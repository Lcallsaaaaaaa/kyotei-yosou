import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const O = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  O.set(r.race_id + '|' + r.lane, r.tansho)
const MODELS = [['旧(rfeat未使用)', 'wg1'], ['修正版39項目', 'wi1'], ['46項目', 'wm1'], ['木・1着', 'wgb1'], ['木・3段階', 'wk1b']]
// 共通レース
let common = null
for (const [, T] of MODELS) {
  try {
    const s = new Set(db.prepare(`SELECT DISTINCT race_id FROM ${T}`).all().map((r) => r.race_id))
    common = common ? new Set([...common].filter((x) => s.has(x))) : s
  } catch { }
}
console.log(`共通レース ${common.size.toLocaleString()}\n`)
console.log('  モデル              1着的中   余裕1.0        余裕1.3        余裕1.5')
for (const [nm, T] of MODELS) {
  let rows
  try { rows = db.prepare(`SELECT race_id, lane, p, y FROM ${T} ORDER BY race_id`).all() } catch { continue }
  const R = new Map()
  for (const r of rows) { if (!common.has(r.race_id)) continue
    let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) } a.push(r) }
  const rs = []
  for (const [rid, bs] of R) {
    if (bs.length !== 6) continue
    bs.sort((x, y) => y.p - x.p)
    const od = O.get(rid + '|' + bs[0].lane)
    rs.push({ p: bs[0].p, od, hit: bs[0].y === 1 })
  }
  const acc = rs.filter((r) => r.hit).length / rs.length * 100
  const out = []
  for (const m of [1.0, 1.3, 1.5]) {
    const s = rs.filter((r) => r.od > 0 && r.od >= (1 / r.p) * m)
    if (s.length < 100) { out.push('—'); continue }
    const ret = s.filter((r) => r.hit).reduce((a, r) => a + r.od * 100, 0)
    out.push(`${(ret / (s.length * 100) * 100).toFixed(2)}%(${s.length})`)
  }
  console.log(`  ${nm.padEnd(18)} ${acc.toFixed(2)}%  ${out.map((x) => x.padStart(14)).join(' ')}`)
}
db.close()
