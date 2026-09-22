// その日の「全レース」を現在の条件で判定し、paper_bets に記録する。
//
// なぜ要るか
//   bets は実際に買った記録（1日3本・4本の上限つき）。条件を変えたとき、
//   「新条件なら今日はどう判定されたか」を当日の消化状況と無関係に
//   全レース分残しておきたい。bets を汚さず別テーブルに書く。
//
// ★オッズは odds_live に記録された締切前の実測しか使わない（単勝も複勝も同じ）
//   買う時点で見えていた値だけを使う、という一点で auto-bet と揃える。
//
//   終わったレースの確定オッズを取りに行けば表は埋まるが、それは買う時点で
//   知り得ない値なので**先読み**になる。2026-08-23に一度それをやって、
//   複勝の全レース判定を確定オッズで出してしまった。
//   **数字が埋まることと、検証になることは別。** オッズが無いレースは no_odds のまま残す。
//
//   複勝の締切前オッズは 2026-08-23 の odds-live.mjs 改修から記録が始まる。
//   それ以前の日は複勝が no_odds だらけになるが、それが正しい状態。
//
// ★判定の順序も実運用に合わせる
//   締切が早い順に見て、オッズ条件を通ったものから上限まで買う。
//   「確率順に上位N本」は後のレースのオッズを知っていないとできない（＝先読み）。
//   歩進検証の差：単勝 確率順171.4% / 締切順165.0%、複勝 147.3% / 148.8%。
//
//   node scripts/paper-day.mjs --date 2026-08-23
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DATE = argv[argv.indexOf('--date') + 1] ?? new Date().toISOString().slice(0, 10)
const YMD = DATE.replaceAll('-', '')

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 10000')
db.exec(`CREATE TABLE IF NOT EXISTS paper_bets (
  race_id TEXT, lane INTEGER, bet_type TEXT, date TEXT, venue TEXT, race_no INTEGER,
  deadline TEXT, racer TEXT, p REAL, odds REAL, odds_src TEXT, mins_before INTEGER,
  decision TEXT, judged_at TEXT,
  PRIMARY KEY (race_id, lane, bet_type))`)

const pred = JSON.parse(await readFile(join(ROOT, 'data', `predict-${DATE}.json`), 'utf8'))
console.log(`予想 ${pred.races.length}レース（作成 ${pred.generatedAt}）`)

// ---------- 締切時刻 ----------
const DL = new Map()
for (const r of db.prepare(`SELECT race_id,deadline FROM races WHERE date=? AND deadline IS NOT NULL`).all(DATE))
  DL.set(r.race_id, r.deadline)
if (DL.size < pred.races.length) {
  // 当日はまだ races に入っていない。公式から取る。
  const m = await S.deadlines(YMD, [...new Set(pred.races.map((x) => x.jcd))])
  for (const x of pred.races) {
    const t = m.get(x.jcd)?.[x.race_no - 1]
    if (t && !DL.has(x.race_id)) DL.set(x.race_id, t)
  }
}
console.log(`締切時刻 ${DL.size}レース分`)

// ---------- 締切前オッズ（odds_live の実測のみ） ----------
// auto-bet は締切12分前から見はじめ、プールが出来ていなければ2分前まで繰り返す。
// ここでも同じく「最も早く、かつプールが形成されている読み」を採用する。
function readLive(col, sumLo, sumHi) {
  const byRace = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,mins_before,${col} v FROM odds_live
      WHERE race_id LIKE ? AND mins_before BETWEEN ? AND ? AND ${col} > 0`)
      .all(YMD + '%', S.CHECK_UNTIL, S.CHECK_FROM)) {
    if (!byRace.has(r.race_id)) byRace.set(r.race_id, new Map())
    const byMin = byRace.get(r.race_id)
    if (!byMin.has(r.mins_before)) byMin.set(r.mins_before, new Map())
    byMin.get(r.mins_before).set(r.lane, r.v)
  }
  const out = new Map()
  for (const [rid, byMin] of byRace) {
    for (const mins of [...byMin.keys()].sort((a, b) => b - a)) {   // 早い読みから順に
      const o = byMin.get(mins)
      if (o.size < 4) continue                                       // 4艇未満は材料不足
      const sum = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (sum < sumLo || sum > sumHi) continue                       // プール未形成
      out.set(rid, { odds: o, mins }); break
    }
  }
  return out
}
const TAN = readLive('tansho', 1.15, 1.60)
const FUKU = readLive('fukusho_lo', S.FUKU.sumLo, S.FUKU.sumHi)
console.log(`締切前オッズ（${S.CHECK_FROM}〜${S.CHECK_UNTIL}分前・プール形成済み）　単勝${TAN.size}レース／複勝${FUKU.size}レース`)
if (!FUKU.size) console.log('  ※複勝の締切前オッズは 2026-08-23 の改修から記録開始。それ以前の日は空になります。')

// ---------- 判定 ----------
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const withDL = pred.races.filter((x) => DL.has(x.race_id)).map((x) => ({ ...x, dl: DL.get(x.race_id) }))
const ins = db.prepare(`INSERT OR REPLACE INTO paper_bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const stamp = new Date().toISOString()

const TYPES = [
  { key: 'tansho', label: '単勝', minP: S.MIN_P, margin: S.MARGIN, cap: S.MAX_BUY,
    pick: (x) => x.first?.[0], src: TAN },
  { key: 'fukusho', label: '複勝', minP: S.FUKU.minP, margin: S.FUKU.margin, cap: S.FUKU.maxBuy,
    pick: (x) => x.top2?.[0], src: FUKU },
  { key: 'fuku90', label: '複勝・高的中', minP: S.FUKU90.minP, cap: S.FUKU90.maxBuy,
    fixedOdds: S.FUKU90.minOdds, venueNG: new Set(S.FUKU90.badVenues),
    pick: (x) => x.top2?.[0], src: FUKU },
]

for (const T of TYPES) {
  const cand = withDL.map((x) => {
    const f = T.pick(x); if (!f) return null
    return { x, lane: f.lane, name: f.name, p: f.p, dl: x.dl, mins: toMin(x.dl) }
  }).filter((c) => c && c.p >= T.minP && !(T.venueNG && T.venueNG.has(c.x.jcd)))
    .sort((a, b) => a.mins - b.mins)          // ★締切が早い順＝実運用の順序

  let bought = 0
  const rows = []
  for (const c of cand) {
    const got = T.src.get(c.x.race_id)
    const o = got?.odds.get(Number(c.lane)) ?? null
    let dec
    if (o == null) dec = 'no_odds'                       // オッズが無いものは上限を消費しない
    else if (bought >= T.cap) dec = 'capped'
    else if (o >= (T.fixedOdds ?? S.minOddsFor(c.p, T.margin))) { dec = 'buy'; bought++ }
    else dec = 'skip'
    rows.push({ c, o, mins: got?.mins ?? null, dec })
    ins.run(c.x.race_id, c.lane, T.key, DATE, c.x.venue, c.x.race_no, c.dl, c.name,
      c.p, o, o == null ? null : 'live', got?.mins ?? null, dec, stamp)
  }
  const n = (d) => rows.filter((r) => r.dec === d).length
  console.log(`\n═══ ${T.label}　候補${rows.length}本　条件：${T.fixedOdds ? `確率${T.minP*100}%以上×${T.fixedOdds}倍以上` : `必要倍率=(1÷確率)×${T.margin}`} × 1日${T.cap}本 ═══`)
  console.log(`買い${n('buy')} ／ 見送り${n('skip')} ／ 上限到達後${n('capped')} ／ 締切前オッズ無し${n('no_odds')}`)
  for (const r of rows) {
    if (r.dec === 'no_odds') continue                    // 判定できていないものは並べない
    const mark = r.dec === 'buy' ? '★買い' : r.dec === 'skip' ? '　見送り' : '　上限到達後'
    console.log(`  ${r.c.dl} ${(r.c.x.venue + r.c.x.race_no + 'R').padEnd(8)} ${r.c.lane}号艇 ${r.c.name.padEnd(7)} 確率${(r.c.p * 100).toFixed(0)}%  ${(r.o.toFixed(1) + '倍').padStart(6)}(${r.mins}分前) 必要${(T.fixedOdds ?? S.minOddsFor(r.c.p, T.margin)).toFixed(2)}倍  ${mark}`)
  }
}
db.close()
console.log(`\npaper_bets に記録しました。結果の突合は翌日15:00の取り込み後。`)
