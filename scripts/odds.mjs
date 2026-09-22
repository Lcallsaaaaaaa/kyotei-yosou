// 公式から3連単オッズ（120通り全部）を取得して蓄積する。
//
//   node scripts/odds.mjs --from 2026-02-18 --to 2026-08-17     期間を指定して収集
//   node scripts/odds.mjs --from 2026-08-18 --to 2026-08-18      当日ぶん
//   node scripts/odds.mjs --stats                                 収集状況だけ表示
//
// ★なぜ要るか
//   バックテストで「確率順に買う戦略は全パターンで回収率100%未満」と確定した。
//   利益はEV（オッズとの乖離）からしか出ないのに、**過去のオッズが無いのでEV戦略だけ検証できない**。
//   公式は締切時オッズを過去ぶんも残していることを確認したので、ここを埋める。
//
// ★ページ構造（実測）
//   <td class="oddsPoint">◯◯</td> が1レースにちょうど120個、決まった順序で並ぶ。
//   並びは行優先：20行 × 6列（列＝1着の艇番1〜6）。
//   列 f の r 番目は、2着を昇順に、その各々で3着を昇順に並べた r 番目の組。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DELAY = Number(flag('delay', 250)) // 1件あたりの待ち
const CONC = Number(flag('conc', 3))     // 同時に流す本数（往復2〜3秒あるので3本で毎秒1件強）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// バックフィルを裏で回しながら当日ぶんも取る、という運用になるので
// 書き込みが衝突する。即エラーにせず順番待ちさせる。
db.exec('PRAGMA busy_timeout = 60000')

db.exec(`
  CREATE TABLE IF NOT EXISTS odds3t (
    race_id TEXT NOT NULL,
    combo   TEXT NOT NULL,
    odds    REAL,
    PRIMARY KEY (race_id, combo)
  );
  CREATE TABLE IF NOT EXISTS odds_fetch (
    race_id  TEXT PRIMARY KEY,
    fetched  TEXT NOT NULL,
    status   TEXT NOT NULL,   -- ok / empty / error
    n        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_odds_combo ON odds3t(combo);
`)

/** 列fのr番目の組み合わせ（2着昇順→3着昇順） */
function comboAt(f, r) {
  const others = [1, 2, 3, 4, 5, 6].filter((x) => x !== f)
  const s = others[Math.floor(r / 4)]
  const thirds = [1, 2, 3, 4, 5, 6].filter((x) => x !== f && x !== s)
  return `${f}-${s}-${thirds[r % 4]}`
}

function parseOdds(html) {
  const vals = [...html.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
  if (vals.length !== 120) return null
  const out = []
  for (let i = 0; i < 120; i++) {
    const r = Math.floor(i / 6)
    const f = (i % 6) + 1
    const v = vals[i]
    const num = /^[\d.]+$/.test(v) ? Number(v) : null
    out.push({ combo: comboAt(f, r), odds: num })
  }
  return out
}

if (argv.includes('--stats')) {
  const t = one(`SELECT COUNT(*) races, SUM(n) rows FROM odds_fetch WHERE status='ok'`)
  const byStatus = all(`SELECT status, COUNT(*) c FROM odds_fetch GROUP BY status`)
  const range = one(`SELECT MIN(r.date) a, MAX(r.date) b FROM odds_fetch o JOIN races r ON r.race_id=o.race_id WHERE o.status='ok'`)
  const total = one(`SELECT COUNT(*) c FROM races`).c
  console.log('=== オッズ収集の状況 ===')
  console.log(`  取得済み ${t.races ?? 0} レース / 全 ${total} レース  (${(((t.races ?? 0) / total) * 100).toFixed(1)}%)`)
  console.log(`  期間: ${range?.a ?? '-'} 〜 ${range?.b ?? '-'}`)
  console.log(`  内訳: ${byStatus.map((x) => `${x.status}=${x.c}`).join(' / ')}`)
  console.log(`  odds3t 行数: ${one('SELECT COUNT(*) c FROM odds3t').c.toLocaleString()}`)
  db.close()
  process.exit(0)
}

const from = flag('from')
const to = flag('to')
if (!from || !to) {
  console.error('使い方: node scripts/odds.mjs --from 2026-02-18 --to 2026-08-17')
  process.exit(1)
}

// まだ取っていないレースだけ対象にする（中断しても再実行で続きから）
// ⚠️ races は「終了したレース」しか持たない。当日のまだ走っていないレースは
//    番組表(programs)にしか存在しないので、両方から拾う。
const targets = all(`
  WITH src AS (
    SELECT race_id, jcd, race_no, date FROM races
    UNION
    SELECT DISTINCT p.race_id,
      CAST(substr(p.race_id, 10, 2) AS INTEGER),
      CAST(substr(p.race_id, 13, 2) AS INTEGER),
      substr(p.race_id,1,4)||'-'||substr(p.race_id,5,2)||'-'||substr(p.race_id,7,2)
    FROM programs p
  )
  SELECT s.race_id, s.jcd, s.race_no, s.date FROM src s
  WHERE s.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM odds_fetch f WHERE f.race_id = s.race_id AND f.status IN ('ok','empty'))
  ORDER BY s.date DESC, s.jcd, s.race_no`, from, to)

console.log(`=== 3連単オッズ収集 ${from} 〜 ${to} ===`)
console.log(`対象 ${targets.length.toLocaleString()} レース（取得済みは除外済み）`)
console.log(`間隔 ${DELAY}ms  推定所要 ${(targets.length * DELAY / 3600000).toFixed(1)} 時間\n`)

const insOdds = db.prepare(`INSERT INTO odds3t (race_id, combo, odds) VALUES (?,?,?)
  ON CONFLICT(race_id, combo) DO UPDATE SET odds = excluded.odds`)
const insFetch = db.prepare(`INSERT INTO odds_fetch (race_id, fetched, status, n) VALUES (?,?,?,?)
  ON CONFLICT(race_id) DO UPDATE SET fetched=excluded.fetched, status=excluded.status, n=excluded.n`)

const stamp = () => new Date().toISOString()
let ok = 0, empty = 0, err = 0
const t0 = Date.now()
const buf = []

// 1件ずつ順に叩くと往復時間で律速する。数本を同時に流し、書き込みはまとめる。
async function fetchOne(t) {
  const url = `https://www.boatrace.jp/owpc/pc/race/odds3t?rno=${t.race_no}&jcd=${String(t.jcd).padStart(2, '0')}&hd=${t.date.replace(/-/g, '')}`
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })
      if (!res.ok) throw new Error(String(res.status))
      const rows = parseOdds(await res.text())
      return { t, rows, status: rows ? 'ok' : 'empty' }
    } catch { if (a === 3) return { t, rows: null, status: 'error' }; await sleep(DELAY * a * 3) }
  }
}
const flush = () => {
  if (!buf.length) return
  db.exec('BEGIN')
  for (const x of buf) {
    if (x.status === 'ok') { for (const r of x.rows) insOdds.run(x.t.race_id, r.combo, r.odds); insFetch.run(x.t.race_id, stamp(), 'ok', x.rows.length) }
    else insFetch.run(x.t.race_id, stamp(), x.status, 0)
  }
  db.exec('COMMIT')
  buf.length = 0
}
for (let i = 0; i < targets.length; i += CONC) {
  const batch = targets.slice(i, i + CONC)
  const res = await Promise.all(batch.map((t) => fetchOne(t)))
  for (const r of res) { buf.push(r); r.status === 'ok' ? ok++ : r.status === 'empty' ? empty++ : err++ }
  if (buf.length >= 60) flush()
  const done = Math.min(i + CONC, targets.length)
  if (done % 300 < CONC || done === targets.length) {
    const el = (Date.now() - t0) / 1000
    console.log(`[${((done / targets.length) * 100).toFixed(1)}%] ${done}/${targets.length}  ok${ok} 空${empty} 失敗${err}  ${(el / done).toFixed(2)}秒/件  残り約${(((targets.length - done) * (el / done)) / 3600).toFixed(1)}時間`)
  }
  await sleep(DELAY)
}
flush()

console.log(`
完了: ok ${ok} / 空 ${empty} / 失敗 ${err}`)
console.log(`odds3t 行数: ${one('SELECT COUNT(*) c FROM odds3t').c.toLocaleString()}`)
db.close()