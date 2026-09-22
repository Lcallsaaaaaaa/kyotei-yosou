// 「2番手が1番手を上回る」条件の組み合わせを総当たりで探す。
//   node --max-old-space-size=6144 scripts/second2.mjs --t wg1
//
// ★見つけたいもの
//   単独の条件では見つからなかった（確率差が小さいほど互角に近づくだけ）。
//   条件を2つ3つ重ねたときに、2番手の勝率が1番手を超える領域があるかを探す。
//   あれば、そこだけ入れ替えれば1着的中が上がる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wg1')
const MIN = Number(flag('min', 300))

const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${T} ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const meta = new Map()
for (const r of db.prepare(`SELECT race_id, jcd, grade, deadline, wind_speed, wave, race_no, day_no FROM races WHERE date >= '2025-10-01'`).all())
  meta.set(r.race_id, r)
const rf = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rc_a1, rc_entry_risk, exc_race_moved, exc_moved,
    ex_rank, exst_rank, vh_nige, ex_rel FROM rfeat WHERE race_id IN (SELECT DISTINCT race_id FROM ${T})`).iterate())
  rf.set(r.race_id + '|' + r.lane, r)

const races = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  bs.sort((x, y) => y.p - x.p)
  const win = bs.findIndex((b) => b.y === 1); if (win < 0) continue
  const m = meta.get(rid); if (!m) continue
  const f1 = rf.get(rid + '|' + bs[0].lane), f2 = rf.get(rid + '|' + bs[1].lane)
  if (!f1 || !f2) continue
  races.push({ rank: win, gap: bs[0].p - bs[1].p, l1: bs[0].lane, l2: bs[1].lane, m, f1, f2 })
}
const N = races.length
console.log(`対象 ${N.toLocaleString()}レース\n`)

// 候補となる条件（すべて締切前に分かるもの）
const C = {
  '確率差<0.05': (r) => r.gap < 0.05,
  '確率差<0.10': (r) => r.gap < 0.10,
  '確率差<0.20': (r) => r.gap < 0.20,
  '2番手が内側': (r) => r.l2 < r.l1,
  '2番手が1号艇': (r) => r.l2 === 1,
  '1番手が1号艇でない': (r) => r.l1 !== 1,
  '2番手の展示1位': (r) => Math.round(r.f2.ex_rank) === 1,
  '2番手の展示1-2位': (r) => Math.round(r.f2.ex_rank) <= 2,
  '1番手の展示4位以下': (r) => Math.round(r.f1.ex_rank) >= 4,
  '2番手の展示STが1番手より速い': (r) => r.f2.exst_rank > 0 && r.f1.exst_rank > 0 && r.f2.exst_rank < r.f1.exst_rank,
  '2番手の展示ST1-2位': (r) => Math.round(r.f2.exst_rank) >= 1 && Math.round(r.f2.exst_rank) <= 2,
  '展示で進入が動いた': (r) => r.f1.exc_race_moved > 0,
  '前づけ危険度1.5以上': (r) => r.f1.rc_entry_risk >= 1.5,
  '波5cm以上': (r) => (r.m.wave ?? 0) >= 5,
  '風6m以上': (r) => (r.m.wind_speed ?? 0) >= 6,
  '場の逃げ率が低い': (r) => r.f1.vh_nige > 0 && r.f1.vh_nige < 0.48,
  'A1が0-1人': (r) => r.f1.rc_a1 <= 1,
  '2R-8R': (r) => r.m.race_no >= 2 && r.m.race_no <= 8,
}
const KEYS = Object.keys(C)
const ev = races.map((r) => KEYS.map((k) => C[k](r)))

function score(mask) {
  let n = 0, w1 = 0, w2 = 0
  for (let i = 0; i < races.length; i++) {
    let ok = true
    for (const j of mask) if (!ev[i][j]) { ok = false; break }
    if (!ok) continue
    n++; if (races[i].rank === 0) w1++; else if (races[i].rank === 1) w2++
  }
  return { n, w1, w2 }
}

const found = []
// 1条件・2条件・3条件
const idx = KEYS.map((_, i) => i)
for (const a of idx) {
  const s = score([a]); if (s.n >= MIN) found.push({ k: [a], ...s })
  for (const b of idx) { if (b <= a) continue
    const s2 = score([a, b]); if (s2.n >= MIN) found.push({ k: [a, b], ...s2 })
    for (const c of idx) { if (c <= b) continue
      const s3 = score([a, b, c]); if (s3.n >= MIN) found.push({ k: [a, b, c], ...s3 })
    }
  }
}
for (const f of found) { f.r1 = f.w1 / f.n * 100; f.r2 = f.w2 / f.n * 100; f.d = f.r2 - f.r1 }
found.sort((x, y) => y.d - x.d)
console.log(`条件の組み合わせ ${found.length.toLocaleString()}通りを試した（${MIN}レース以上のものだけ）\n`)
console.log('★ 2番手のほうが強く出た上位20（差がプラスなら入れ替えて得する）')
console.log('  レース数  全体比   1番手   2番手     差   条件')
for (const f of found.slice(0, 20))
  console.log(`  ${String(f.n).padStart(7)} ${(f.n / N * 100).toFixed(1).padStart(6)}% ${f.r1.toFixed(2).padStart(7)}% ${f.r2.toFixed(2).padStart(7)}% ${((f.d >= 0 ? '+' : '') + f.d.toFixed(2) + 'pt').padStart(9)}   ${f.k.map((i) => KEYS[i]).join(' ＋ ')}`)
console.log(`\n差がプラス（2番手が上回る）の組み合わせ: ${found.filter((f) => f.d > 0).length} / ${found.length}`)
db.close()
