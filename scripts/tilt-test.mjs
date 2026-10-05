// チルト跳アラートを絞ったら、1着率の伸びがどこまで行くかを測る。
//
//   node --max-old-space-size=4096 scripts/tilt-test.mjs
//
// ★いまの条件（api.mjs）は「チルト+1.0度以上、または同じ節の前走から上げた艇」。
//   2026-10-05の実測で、3着以内は1.1倍（飾り）だが**1着は1.5倍**だった。
//   表示を「1着」に変えるにあたり、**もっと絞れば伸びるか**を見る。
//
// ★枠を揃えて比べる。外枠は元から1着率が低いので、揃えないと
//   「チルトのせい」を「枠のせい」と取り違える（10/05に一度やった）。
// ★前半で見て、後半で確かめる。前半だけで良い条件を選ばない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
console.log('材料を読み込んでいます…')

const rank = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
  WHERE rank_num IS NOT NULL AND race_id >= '20220818'`).all()) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}

// 直前情報。選手ごとに「同じ節の前走のチルト」を順に持たせる
const raw = db.prepare(`SELECT b.race_id, b.lane, b.tilt, p.racer_id
  FROM before_info b LEFT JOIN programs p ON p.race_id=b.race_id AND p.lane=b.lane
  WHERE b.tilt IS NOT NULL AND b.race_id >= '20220818' ORDER BY b.race_id`).all()
db.close()

const toYmd = (id) => id.slice(0, 8)
const minus = (ymd, n) => {
  const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10).replaceAll('-', '')
}
const last = new Map()   // racer|jcd -> {tilt, ymd}
const rows = []
for (const r of raw) {
  if (!rank.has(r.race_id)) continue
  const key = r.racer_id ? `${r.racer_id}|${r.race_id.slice(9, 11)}` : null
  const pv = key ? last.get(key) : null
  // 同じ節＝8日以内の同じ場の前走
  r.prevTilt = pv && pv.ymd >= minus(toYmd(r.race_id), 8) ? pv.tilt : null
  r.won = (rank.get(r.race_id).get(r.lane) ?? 9) === 1
  rows.push(r)
  if (key) last.set(key, { tilt: r.tilt, ymd: toYmd(r.race_id) })
}

const ymds = [...new Set(rows.map((r) => toYmd(r.race_id)))].sort()
const CUT = ymds[Math.floor(ymds.length / 2)]
const half = (r) => (toYmd(r.race_id) < CUT ? 0 : 1)
const d = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
console.log(`${rows.length.toLocaleString()}艇ぶん　前半 〜${d(CUT)} ／ 後半 ${d(CUT)}〜`)
console.log('')

/** 条件に当てはまる艇の1着率を、同じ枠の当てはまらない艇と比べる。 */
function run(label, hit) {
  const stat = [new Map(), new Map()]
  for (const r of rows) {
    const h = half(r), k = r.lane
    if (!stat[h].has(k)) stat[h].set(k, { on: [0, 0], off: [0, 0] })
    const s = stat[h].get(k)[hit(r) ? 'on' : 'off']
    s[0]++; if (r.won) s[1]++
  }
  const out = []
  for (const h of [0, 1]) {
    let n = 0, w = 0, adj = 0
    for (const [, s] of stat[h]) {
      if (!s.on[0] || !s.off[0]) continue
      n += s.on[0]; w += s.on[1]; adj += s.off[1] / s.off[0] * s.on[0]
    }
    out.push(n ? { n, p: w / n * 100, base: adj / n * 100, r: adj ? (w / n) / (adj / n) : null } : null)
  }
  const f = (x) => (x == null ? '  ―  ' : (x.toFixed(1) + '%').padStart(6))
  const [a, b] = out
  if (!a || !b || a.n < 300 || b.n < 300) { console.log(`  ${label.padEnd(34)} 該当が少なすぎます`); return null }
  console.log(`  ${label.padEnd(34)} 前半 ${f(a.p)}/${f(a.base)} ${a.r.toFixed(2)}倍　後半 ${f(b.p)}/${f(b.base)} ${b.r.toFixed(2)}倍　(${b.n.toLocaleString()}件)`)
  return { a, b }
}

console.log('【いまの条件】（表示を「1着」に変える前の確認）')
run('チルト+1.0以上 または 前走から上げた', (r) => r.tilt >= 1.0 || (r.prevTilt != null && r.tilt > r.prevTilt))
console.log('')

console.log('【ばらして見る】')
run('チルト+1.0以上だけ', (r) => r.tilt >= 1.0)
run('前走から上げただけ（+1.0未満）', (r) => r.tilt < 1.0 && r.prevTilt != null && r.tilt > r.prevTilt)
run('両方あてはまる', (r) => r.tilt >= 1.0 && r.prevTilt != null && r.tilt > r.prevTilt)
console.log('')

console.log('【チルトの高さで絞る】')
for (const th of [0.5, 1.0, 1.5, 2.0, 3.0])
  run(`チルト+${th.toFixed(1)}以上`, (r) => r.tilt >= th)
console.log('')

console.log('【上げ幅で絞る】')
for (const up of [0.5, 1.0, 1.5])
  run(`前走から+${up.toFixed(1)}度以上あげた`, (r) => r.prevTilt != null && r.tilt - r.prevTilt >= up)
console.log('')

console.log('【高さ×上げ幅】')
for (const th of [1.0, 1.5])
  for (const up of [0.5, 1.0])
    run(`+${th.toFixed(1)}以上 かつ 前走から+${up.toFixed(1)}以上`,
      (r) => r.tilt >= th && r.prevTilt != null && r.tilt - r.prevTilt >= up)
console.log('')
console.log('★「前半も後半も」同じ倍率が出たものだけ採る。片方だけ高いのは偶然の山。')
