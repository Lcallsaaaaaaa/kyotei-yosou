// 公式から 単勝・複勝・3連複 のオッズを取得して蓄積する。
//
//   node scripts/odds2.mjs --from 2026-01-01 --to 2026-08-18
//   node scripts/odds2.mjs --stats
//
// ★なぜ要るか
//   3連単オッズだけでは、単勝・3連複の商品を検証できない。
//   3連単から換算する案もあったが、券種ごとに別プール・別控除なので推定になる。
//   実測を取る。
//
// ★並び順（推測せず実測で確定した）
//   oddstf: <td class="oddsPoint"> が12個。
//     前半6個 = 単勝（枠番1〜6の順）、後半6個 = 複勝（同じ順・"1.7-2.6" の範囲表記）
//     検算：単勝オッズ逆数の合計が平均1.359（控除率25%と整合）
//
//   odds3f: 20個。**辞書順ではない。**
//     「(2番目, 3番目, 1番目) の昇順」で並ぶ：
//       1-2-3 1-2-4 1-2-5 1-2-6 | 1-3-4 2-3-4 | 1-3-5 2-3-5 | 1-3-6 2-3-6
//       1-4-5 2-4-5 3-4-5 | 1-4-6 2-4-6 3-4-6 | 1-5-6 2-5-6 3-5-6 4-5-6
//     3連単オッズから作った含意確率と40レース分で突き合わせて確定（相関0.81〜0.99）。
//     辞書順で読むと20通り全部ずれる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DELAY = Number(flag('delay', 60))
const CONC = Number(flag('conc', 6))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

db.exec(`
  CREATE TABLE IF NOT EXISTS odds_tan (race_id TEXT NOT NULL, lane INTEGER NOT NULL,
    tansho REAL, fukusho_lo REAL, fukusho_hi REAL, PRIMARY KEY (race_id, lane));
  CREATE TABLE IF NOT EXISTS odds3f (race_id TEXT NOT NULL, combo TEXT NOT NULL, odds REAL,
    PRIMARY KEY (race_id, combo));
  CREATE TABLE IF NOT EXISTS odds2_fetch (race_id TEXT PRIMARY KEY, fetched TEXT, status TEXT);
`)

// (2番目,3番目,1番目) 昇順の並び
const F3 = []
{
  const cs = []
  for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) for (let c = b + 1; c <= 6; c++) cs.push([a, b, c])
  cs.sort((x, y) => x[1] - y[1] || x[2] - y[2] || x[0] - y[0])
  for (const c of cs) F3.push(c.join('-'))
}

if (argv.includes('--stats')) {
  const t = one(`SELECT COUNT(*) c FROM odds2_fetch WHERE status='ok'`).c
  const total = one(`SELECT COUNT(*) c FROM races`).c
  console.log('=== 単勝・複勝・3連複 オッズの収集状況 ===')
  console.log(`  取得済み ${t} / ${total} レース (${((t / total) * 100).toFixed(1)}%)`)
  console.log(`  odds_tan ${one('SELECT COUNT(*) c FROM odds_tan').c.toLocaleString()} 行`)
  console.log(`  odds3f   ${one('SELECT COUNT(*) c FROM odds3f').c.toLocaleString()} 行`)
  for (const r of all(`SELECT substr(r.date,1,7) m, COUNT(*) tot,
      SUM(CASE WHEN f.status='ok' THEN 1 ELSE 0 END) got
    FROM races r LEFT JOIN odds2_fetch f ON f.race_id=r.race_id GROUP BY m ORDER BY m`))
    console.log(`    ${r.m}  ${r.got} / ${r.tot}`)
  db.close(); process.exit(0)
}

const from = flag('from'), to = flag('to')
if (!from || !to) { console.error('--from --to が必要'); process.exit(1) }

const targets = all(`
  SELECT race_id, jcd, race_no, date FROM races
  WHERE date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM odds2_fetch f WHERE f.race_id=races.race_id AND f.status IN ('ok','empty'))
  ORDER BY date DESC, jcd, race_no`, from, to)
console.log(`=== 単勝・複勝・3連複 収集 ${from} 〜 ${to} ===`)
console.log(`対象 ${targets.length.toLocaleString()} レース  同時${CONC}  間隔${DELAY}ms\n`)

const pts = (h) => [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
const num = (s) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : null }

async function fetchOne(t) {
  const q = `rno=${t.race_no}&jcd=${String(t.jcd).padStart(2, '0')}&hd=${t.date.replace(/-/g, '')}`
  for (let a = 1; a <= 3; a++) {
    try {
      const [h1, h2] = await Promise.all([
        fetch(`https://www.boatrace.jp/owpc/pc/race/oddstf?${q}`, { signal: AbortSignal.timeout(25_000) }).then((r) => r.text()),
        fetch(`https://www.boatrace.jp/owpc/pc/race/odds3f?${q}`, { signal: AbortSignal.timeout(25_000) }).then((r) => r.text()),
      ])
      const v1 = pts(h1), v2 = pts(h2)
      if (v1.length !== 12 || v2.length !== 20) return { t, status: 'empty' }
      const tan = []
      for (let i = 0; i < 6; i++) {
        const f = String(v1[6 + i]).split('-')
        tan.push({ lane: i + 1, tansho: num(v1[i]), lo: num(f[0]), hi: num(f[1] ?? f[0]) })
      }
      const trio = F3.map((c, i) => ({ combo: c, odds: num(v2[i]) }))
      return { t, tan, trio, status: 'ok' }
    } catch { if (a === 3) return { t, status: 'error' }; await sleep(DELAY * a * 5) }
  }
}

const insT = db.prepare(`INSERT INTO odds_tan (race_id,lane,tansho,fukusho_lo,fukusho_hi) VALUES (?,?,?,?,?)
  ON CONFLICT(race_id,lane) DO UPDATE SET tansho=excluded.tansho, fukusho_lo=excluded.fukusho_lo, fukusho_hi=excluded.fukusho_hi`)
const insF = db.prepare(`INSERT INTO odds3f (race_id,combo,odds) VALUES (?,?,?)
  ON CONFLICT(race_id,combo) DO UPDATE SET odds=excluded.odds`)
const insM = db.prepare(`INSERT INTO odds2_fetch (race_id,fetched,status) VALUES (?,?,?)
  ON CONFLICT(race_id) DO UPDATE SET fetched=excluded.fetched, status=excluded.status`)

let ok = 0, empty = 0, err = 0
const buf = []
const stamp = new Date().toISOString()
const t0 = Date.now()
const flush = () => {
  if (!buf.length) return
  db.exec('BEGIN')
  for (const x of buf) {
    if (x.status === 'ok') {
      for (const b of x.tan) insT.run(x.t.race_id, b.lane, b.tansho, b.lo, b.hi)
      for (const c of x.trio) insF.run(x.t.race_id, c.combo, c.odds)
    }
    insM.run(x.t.race_id, stamp, x.status)
  }
  db.exec('COMMIT')
  buf.length = 0
}
for (let i = 0; i < targets.length; i += CONC) {
  const got = await Promise.all(targets.slice(i, i + CONC).map((t) => fetchOne(t)))
  for (const g of got) { buf.push(g); g.status === 'ok' ? ok++ : g.status === 'empty' ? empty++ : err++ }
  if (buf.length >= 60) flush()
  const done = Math.min(i + CONC, targets.length)
  if (done % 300 < CONC || done === targets.length) {
    const el = (Date.now() - t0) / 1000
    console.log(`[${((done / targets.length) * 100).toFixed(1)}%] ${done}/${targets.length}  ok${ok} 空${empty} 失敗${err}  ${(el / done).toFixed(2)}秒/件  残り約${(((targets.length - done) * (el / done)) / 3600).toFixed(1)}時間`)
  }
  await sleep(DELAY)
}
flush()
console.log(`\n完了: ok ${ok} / 空 ${empty} / 失敗 ${err}`)
db.close()
