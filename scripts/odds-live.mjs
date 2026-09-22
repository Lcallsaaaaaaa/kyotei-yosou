// 締切前のオッズを時系列で記録する。
//
//   node scripts/odds-live.mjs --date 2026-08-20
//   node scripts/odds-live.mjs --date 2026-08-20 --jcd 16
//   node scripts/odds-live.mjs --report            記録した差を集計する
//
// ★なぜこれが要るか
//   単勝オッズ2倍以上・モデル本命で回収率116.9%という結果が出た。
//   月別4/4通過、ブートストラップ100%割れ0.0%、閾値も完全に単調と、
//   検定は全部通っている。だが**使っているのは締切後の確定オッズ**。
//
//   実際に買うのは締切前で、その時点のオッズは違う。
//   オッズ2倍以上の艇は締切直前に資金が入って下がりやすい。
//   平均15%下がれば 116.9% → 99% となり、優位は消える。
//   ここが唯一の未検証点であり、有料化の可否を決める。
//
// ★やること
//   締切前の各時点でオッズを記録し、確定オッズと突き合わせる。
//   「締切20分前に買えるオッズ」で回収率を計算し直せば、実運用の数字になる。

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

db.exec(`CREATE TABLE IF NOT EXISTS odds_live (
  race_id TEXT NOT NULL, lane INTEGER NOT NULL, taken TEXT NOT NULL,
  mins_before INTEGER, tansho REAL,
  PRIMARY KEY (race_id, lane, taken))`)
// ★複勝も記録する（2026-08-23 追加）
//   オッズページは1回の取得で単勝6つ＋複勝6つを返しているのに、複勝を捨てていた。
//   そのせいで「その日の全レースを実運用どおりに判定し直す」ことが単勝しかできず、
//   複勝は確定オッズで代用するしかなかった（＝先読みになり検証にならない）。
//   通信は増えない。同じHTMLの後半6つを読むだけ。
try { db.exec('ALTER TABLE odds_live ADD COLUMN fukusho_lo REAL') } catch {}

// ---------- 集計 ----------
if (argv.includes('--report')) {
  const rows = all(`
    SELECT l.race_id, l.lane, l.mins_before, l.tansho AS live, f.tansho AS final
    FROM odds_live l JOIN odds_tan f ON f.race_id = l.race_id AND f.lane = l.lane
    WHERE l.tansho IS NOT NULL AND f.tansho IS NOT NULL`)
  if (!rows.length) { console.log('まだ記録がありません'); db.close(); process.exit(0) }
  console.log(`=== 締切前オッズ vs 確定オッズ（${rows.length.toLocaleString()}件） ===`)
  console.log('  締切前     件数   締切前平均  確定平均   比率     2倍以上の艇の比率')
  for (const [lo, hi] of [[0, 5], [5, 10], [10, 20], [20, 30], [30, 60], [60, 999]]) {
    const s = rows.filter((r) => r.mins_before >= lo && r.mins_before < hi)
    if (s.length < 10) continue
    const a = s.reduce((x, r) => x + r.live, 0) / s.length
    const b = s.reduce((x, r) => x + r.final, 0) / s.length
    const big = s.filter((r) => r.final >= 2)
    const rb = big.length ? big.reduce((x, r) => x + r.final / r.live, 0) / big.length : null
    console.log(`  ${String(lo).padStart(3)}〜${String(hi === 999 ? '∞' : hi).padStart(3)}分  ${String(s.length).padStart(6)}   ${a.toFixed(2).padStart(7)}   ${b.toFixed(2).padStart(7)}   ${(b / a).toFixed(3)}    ${rb ? rb.toFixed(3) : '-'}`)
  }
  console.log('\n  比率が1.0より小さい＝締切前の方が高い（＝買った後に下がる／不利）')
  console.log('  比率が1.0より大きい＝締切前の方が低い（＝買った後に上がる／有利）')
  db.close(); process.exit(0)
}

// ---------- 記録 ----------
const DATE = flag('date')
const JCD = flag('jcd') ? Number(flag('jcd')) : null
if (!DATE) { console.error('--date 2026-08-20 が必要'); process.exit(1) }
const ymd = DATE.replace(/-/g, '')

// 締切時刻を出走表ページから取る
const targets = all(`
  SELECT DISTINCT p.race_id,
    CAST(substr(p.race_id,10,2) AS INTEGER) jcd,
    CAST(substr(p.race_id,13,2) AS INTEGER) race_no
  FROM programs p WHERE substr(p.race_id,1,8) = ?
  ${JCD ? 'AND CAST(substr(p.race_id,10,2) AS INTEGER) = ' + JCD : ''}
  ORDER BY p.race_id`, ymd)
if (!targets.length) { console.error(`${DATE} の番組表がありません`); process.exit(1) }
console.log(`${targets.length} レースを監視します`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadlines = new Map()
for (const t of targets) {
  if (deadlines.has(t.jcd)) continue
  try {
    const h = await (await fetch(`https://www.boatrace.jp/owpc/pc/race/racelist?rno=1&jcd=${String(t.jcd).padStart(2, '0')}&hd=${ymd}`,
      { signal: AbortSignal.timeout(20_000) })).text()
    const ts = [...h.matchAll(/(\d{1,2}:\d{2})/g)].map((m) => m[1])
    deadlines.set(t.jcd, ts.slice(0, 12))
  } catch { deadlines.set(t.jcd, []) }
  await sleep(300)
}

// ★取れた値が使えるかどうかの印（2026-08-31 追加）
//   これが無かったせいで、壊れた記録を混ぜたまま「締切前オッズで判定すると回収83.4%」
//   という結論を出した。実際は記録の85%が壊れていた：
//     6艇そろわない 59.5% ／ 同値の艇がある 22.1% ／ ちょうど1.0倍がある 3.7%
//   ⚠ 記録は消さない。印を付けて残す（不利な内容も残す）。
//     使う側は必ず ok=1 で絞ること。
for (const c of ['ok INTEGER', 'overround REAL'])
  try { db.exec('ALTER TABLE odds_live ADD COLUMN ' + c) } catch { /* すでにある */ }
const ins = db.prepare(`INSERT OR REPLACE INTO odds_live (race_id,lane,taken,mins_before,tansho,fukusho_lo,ok,overround) VALUES (?,?,?,?,?,?,?,?)`)
/** 6艇ぶんの単勝オッズが、オッズ板として筋が通っているか */
export function snapshotOk(v6) {
  const v = v6.filter((x) => Number.isFinite(x) && x > 0)
  if (v.length !== 6) return { ok: 0, sum: null }        // 板がまだ開いていない
  const sum = v.reduce((a, b) => a + 1 / b, 0)
  if (new Set(v).size < 6) return { ok: 0, sum }          // 同じ値が並ぶ＝仮の値
  if (v.some((x) => x === 1)) return { ok: 0, sum }       // ちょうど1.0倍は張り付き
  if (sum < 1.30 || sum > 1.42) return { ok: 0, sum }     // 控除率25%なら1.33前後になる
  return { ok: 1, sum }
}
const minsTo = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  return (h * 60 + m) - (now.getHours() * 60 + now.getMinutes())
}

// 締切60分前から5分おきに、締切まで記録し続ける
console.log('締切60分前から5分おきに記録します（Ctrl+Cで終了）\n')
const WATCH_FROM = Number(flag('from-mins', 20))
const done = new Set()
// ★生存記録（auto-bet と同じ理由。status.mjs がこの更新時刻を見る）
const beat = () => { try { writeFileSync(join(ROOT, 'logs', 'hb-odds-live.txt'), new Date().toISOString()) } catch {} }
try { mkdirSync(join(ROOT, 'logs'), { recursive: true }) } catch {}
beat()
for (;;) {
  let remaining = 0
  for (const t of targets) {
    const dl = deadlines.get(t.jcd)?.[t.race_no - 1]
    if (!dl) continue
    const mb = minsTo(dl)
    if (mb < 0) continue
    remaining++
    // ★締切20分前より前は記録しない。
    //   実測で Σ(1/オッズ) が 20〜29分前=2.71 / 45〜60分前=4.07 となり、
    //   プールが形成されていない＝オッズが数字になっていない。取っても使えない。
    if (mb > WATCH_FROM) continue
    const key = `${t.race_id}:${mb <= 6 ? mb : Math.round(mb / 3) * 3}`   // 締切間際は1分刻みで厚く取る
    if (done.has(key)) continue
    try {
      const h = await (await fetch(`https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${t.race_no}&jcd=${String(t.jcd).padStart(2, '0')}&hd=${ymd}`,
        { signal: AbortSignal.timeout(20_000) })).text()
      const v = [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
      if (v.length !== 12) continue
      const stamp = new Date().toTimeString().slice(0, 8)
      const tan6 = [...Array(6)].map((_, i) => Number(v[i]))
      const H = snapshotOk(tan6)
      db.exec('BEGIN')
      for (let i = 0; i < 6; i++) {
        const o = tan6[i]
        // 後半6つは複勝の「下限-上限」（例 "1.4-2.2"）。下限だけ取る。
        const fm = String(v[i + 6] ?? '').match(/^([0-9.]+)/)
        const f = fm ? Number(fm[1]) : NaN
        ins.run(t.race_id, i + 1, stamp, mb,
          Number.isFinite(o) && o > 0 ? o : null,
          Number.isFinite(f) && f > 0 ? f : null, H.ok, H.sum)
      }
      db.exec('COMMIT')
      // ★壊れていた回は done に入れない。同じ時点をもう一度取りにいく。
      if (H.ok) done.add(key)
      console.log(`  ${new Date().toTimeString().slice(0, 5)}  ${t.race_id}  締切${mb}分前  ` +
        `${H.ok ? '' : '⚠使えない '}単勝[${v.slice(0, 6).join(' ')}]  複勝[${v.slice(6, 12).join(' ')}]` +
        `${H.sum != null ? `  控除${H.sum.toFixed(3)}` : ''}`)
    } catch {}
    await sleep(400)
  }
  beat()
  if (!remaining) { console.log('\n全レース終了'); break }
  await sleep(20_000)
}
db.close()
