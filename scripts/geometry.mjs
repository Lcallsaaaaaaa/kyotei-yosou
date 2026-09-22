// 1マークの幾何を実データから測る。
//
//   node scripts/geometry.mjs
//   node scripts/geometry.mjs --jcd 16
//
// ★考え方
//   競艇の勝敗は「1マークに誰が最も有利な位置で到達したか」でほぼ決まる。
//   その位置は次の3つで決まる：
//     ① スタート時の横位置（＝進入コース）
//     ② スタートの前後差（＝ST差）
//     ③ スタートから1マークまでの速度差（＝展示タイム差が代理変数）
//
//   艇速は約16m/s なので **ST差 0.01秒 ≒ 0.16m の前後差**。
//   艇長は約3m。つまり ST差 0.06秒 ≒ 艇1つぶんの差。
//   コース間の横間隔はスタート時で約10m。外から内を制するには
//   この横距離を詰めながら前に出る必要があり、その分だけ前後差が要る。
//
//   → 「どれだけST差があれば外が内を制せるか」を実測で出す。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const jcd = flag('jcd') ? Number(flag('jcd')) : null

const BOAT_SPEED = 16 // m/s（スタート〜1マークの平均的な艇速）
const BOAT_LEN = 3 // m（艇長）
const pf = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '  -  ')
const m = (dst) => (dst >= 0 ? '+' : '') + dst.toFixed(2) + 'm'

const where = jcd ? 'AND r.jcd = ?' : ''
const params = jcd ? [jcd] : []

console.log(`=== 1マークの幾何 実測 ${jcd ? `（jcd=${jcd}）` : '（全場）'} ===\n`)
console.log(`前提: 艇速${BOAT_SPEED}m/s → ST差0.01秒 ≒ ${(BOAT_SPEED * 0.01).toFixed(2)}m ／ 艇長${BOAT_LEN}m ≒ ST差${(BOAT_LEN / BOAT_SPEED).toFixed(3)}秒\n`)

// ---------- レース単位でコース→ST・展示・着順を組み立てる ----------
const rows = all(`
  SELECT e.race_id, r.jcd, r.kimarite, e.course, e.st, e.st_flag, e.exhibition, e.rank_num
  FROM entries e JOIN races r ON r.race_id = e.race_id
  WHERE e.course IS NOT NULL AND e.st IS NOT NULL AND e.st_flag IS NULL ${where}`, ...params)

const races = new Map()
for (const r of rows) {
  if (!races.has(r.race_id)) races.set(r.race_id, { kimarite: r.kimarite, boats: {} })
  races.get(r.race_id).boats[r.course] = { st: r.st, ex: r.exhibition, rank: r.rank_num }
}
// 6艇そろっているレースだけ使う
const clean = [...races.values()].filter((x) => Object.keys(x.boats).length === 6)
console.log(`対象 ${clean.length} レース\n`)

// ---------- ① 1コースの「残り」と、外からのST差の関係 ----------
// 外の艇が1コースに対してどれだけ先に出たか = st(1) - st(outer)
// 正なら外の方が先行（＝1コースより速くスタートを切った）
console.log('=== ① 「1コース艇 vs 外の艇」のST差と、1コースが1着になる確率 ===')
console.log('  ST差＝ st(1コース) − st(外の艇)。正なら外が先行している。')
console.log('  ※ 各レースについて「最も先行した外の艇」との差を使う\n')

const BUCKETS = [-0.20, -0.12, -0.08, -0.04, -0.02, 0, 0.02, 0.04, 0.08, 0.12, 0.20]
const bucketOf = (v) => {
  for (let i = 0; i < BUCKETS.length; i++) if (v < BUCKETS[i]) return i
  return BUCKETS.length
}
const label = (i) =>
  i === 0 ? `      〜${BUCKETS[0].toFixed(2)}`
  : i === BUCKETS.length ? `${BUCKETS[BUCKETS.length - 1].toFixed(2)}〜      `
  : `${BUCKETS[i - 1].toFixed(2)}〜${BUCKETS[i].toFixed(2)}`

const g1 = new Map()
for (const rc of clean) {
  const b1 = rc.boats[1]
  let best = -Infinity
  for (let c = 2; c <= 6; c++) best = Math.max(best, b1.st - rc.boats[c].st)
  const k = bucketOf(best)
  if (!g1.has(k)) g1.set(k, { n: 0, win: 0, sum: 0 })
  const s = g1.get(k)
  s.n++; s.sum += best
  if (b1.rank === 1) s.win++
}
console.log('ST差の帯        件数    平均ST差   換算距離     1コース1着率')
for (const k of [...g1.keys()].sort((a, b) => a - b)) {
  const s = g1.get(k)
  if (s.n < 100) continue
  const avg = s.sum / s.n
  console.log(`${label(k)} ${String(s.n).padStart(8)}   ${avg.toFixed(3)}秒   ${m(avg * BOAT_SPEED).padStart(8)}   ${pf(s.win, s.n).padStart(7)}`)
}

// ---------- ② コース別「まくりが決まるST差」 ----------
console.log('\n=== ② コース別：そのコースが1着になったとき、内側の艇にどれだけ先行していたか ===')
console.log('  内側艇＝自分より内のコース全部。その中で最も速かったSTとの差を見る。\n')
console.log('コース  1着回数   1着時の平均ST差  換算距離   艇身換算   （参考）全体の平均ST差')
for (let c = 2; c <= 6; c++) {
  let winN = 0, winSum = 0, allN = 0, allSum = 0
  for (const rc of clean) {
    const me = rc.boats[c]
    let innerBest = Infinity
    for (let i = 1; i < c; i++) innerBest = Math.min(innerBest, rc.boats[i].st)
    const diff = innerBest - me.st // 正なら自分が先行
    allN++; allSum += diff
    if (me.rank === 1) { winN++; winSum += diff }
  }
  const wAvg = winSum / winN
  console.log(`  ${c}   ${String(winN).padStart(7)}   ${wAvg.toFixed(3)}秒        ${m(wAvg * BOAT_SPEED).padStart(8)}  ${(wAvg * BOAT_SPEED / BOAT_LEN).toFixed(2)}艇身   ${(allSum / allN).toFixed(3)}秒`)
}

// ---------- ③ 決まり手ごとのST差プロファイル ----------
console.log('\n=== ③ 決まり手別：1着艇が内側艇にどれだけ先行していたか ===')
console.log('  「まくり」は前に出て制する技、「差し」は内に入る技。ST差の符号が逆になるはず。\n')
const g3 = new Map()
for (const rc of clean) {
  if (!rc.kimarite) continue
  let winner = null
  for (let c = 1; c <= 6; c++) if (rc.boats[c].rank === 1) winner = c
  if (!winner || winner === 1) continue // 1コース1着は「逃げ」でST差の意味が薄い
  let innerBest = Infinity
  for (let i = 1; i < winner; i++) innerBest = Math.min(innerBest, rc.boats[i].st)
  const diff = innerBest - rc.boats[winner].st
  if (!g3.has(rc.kimarite)) g3.set(rc.kimarite, { n: 0, sum: 0, plus: 0, courseSum: 0 })
  const s = g3.get(rc.kimarite)
  s.n++; s.sum += diff; s.courseSum += winner
  if (diff > 0) s.plus++
}
console.log('決まり手        件数    平均ST差   換算距離    艇身   先行していた割合  平均コース')
for (const [k, s] of [...g3.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const avg = s.sum / s.n
  console.log(`${k.padEnd(12, '　')}${String(s.n).padStart(7)}   ${avg.toFixed(3)}秒  ${m(avg * BOAT_SPEED).padStart(8)}  ${(avg * BOAT_SPEED / BOAT_LEN).toFixed(2)}  ${pf(s.plus, s.n).padStart(10)}      ${(s.courseSum / s.n).toFixed(2)}`)
}

// ---------- ④ 展示タイム差の寄与（速度差の代理変数） ----------
console.log('\n=== ④ 展示タイム差（速度の代理）と、外が内を制する確率 ===')
console.log('  展示が速い＝数値が小さい。差＝ 展示(内側最速) − 展示(自艇)。正なら自分が速い。\n')
const EXB = [-0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10]
const exBucket = (v) => { for (let i = 0; i < EXB.length; i++) if (v < EXB[i]) return i; return EXB.length }
const exLabel = (i) =>
  i === 0 ? `     〜${EXB[0].toFixed(2)}`
  : i === EXB.length ? `${EXB[EXB.length - 1].toFixed(2)}〜     `
  : `${EXB[i - 1].toFixed(2)}〜${EXB[i].toFixed(2)}`

for (const target of [4, 5]) {
  const g = new Map()
  for (const rc of clean) {
    const me = rc.boats[target]
    if (me.ex == null) continue
    let innerEx = Infinity
    for (let i = 1; i < target; i++) if (rc.boats[i].ex != null) innerEx = Math.min(innerEx, rc.boats[i].ex)
    if (!Number.isFinite(innerEx)) continue
    const d = innerEx - me.ex
    const k = exBucket(d)
    if (!g.has(k)) g.set(k, { n: 0, win: 0, top3: 0 })
    const s = g.get(k)
    s.n++
    if (me.rank === 1) s.win++
    if (me.rank && me.rank <= 3) s.top3++
  }
  console.log(`【${target}コース】展示差の帯      件数     1着率    3連対率`)
  for (const k of [...g.keys()].sort((a, b) => a - b)) {
    const s = g.get(k)
    if (s.n < 200) continue
    console.log(`  ${exLabel(k)} ${String(s.n).padStart(8)}  ${pf(s.win, s.n).padStart(7)}  ${pf(s.top3, s.n).padStart(7)}`)
  }
  console.log('')
}
db.close()
