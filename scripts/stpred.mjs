// 本番のSTがどこまで読めるかを測る。
//   node --max-old-space-size=6144 scripts/stpred.mjs
//
// ★なぜ測るか
//   外れたレースを分解したところ、本命のSTが0.20以上だと外れ率59〜83%、
//   F・L持ちなら100%外れていた。STは効いている。
//   ただしSTは結果なので、締切前に読めるかどうかが問題。
//   材料は「展示のST」「その選手の過去のST」「コース別のST」「F・L回数」。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const rows = db.prepare(`
  SELECT e.race_id, e.lane, e.st, e.st_flag, e.course,
         b.ex_st, b.ex_st_flag,
         f.all_st, f.course1_st, f.course2_st, f.course3_st, f.course4_st, f.course5_st, f.course6_st,
         f.f_count, f.l_count, f.r10_st, f.r30_st, f.tochi_st,
         r.date, r.wind_speed, r.wave, r.jcd
  FROM entries e
  JOIN races r ON r.race_id = e.race_id
  LEFT JOIN before_info b ON b.race_id = e.race_id AND b.lane = e.lane
  LEFT JOIN feat f ON f.race_id = e.race_id AND f.lane = e.lane
  WHERE r.date >= '2025-06-01' AND e.st IS NOT NULL`).all()
console.log(`${rows.length.toLocaleString()}行（2025-06以降・本番STあり）\n`)

const cor = (a, b) => {
  const n = a.length
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n
  let sa = 0, sb = 0, sab = 0
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sa += x * x; sb += y * y; sab += x * y }
  return sab / Math.sqrt(sa * sb)
}
const courseSt = (r) => {
  const c = r.course ?? r.lane
  return r[`course${c}_st`] ?? r.all_st
}
console.log('本番のSTと、締切前に分かる材料との相関（1に近いほど読める）')
for (const [nm, get] of [
  ['展示のST', (r) => r.ex_st],
  ['その選手の平均ST', (r) => r.all_st],
  ['直近10走のST', (r) => r.r10_st],
  ['直近30走のST', (r) => r.r30_st],
  ['当地のST', (r) => r.tochi_st],
  ['そのコースでのST', courseSt],
]) {
  const s = rows.filter((r) => { const v = get(r); return v != null && v > 0 && r.st > 0 })
  if (s.length < 1000) { console.log(`  ${nm.padEnd(18)} データ不足（${s.length}行）`); continue }
  const a = s.map((r) => r.st), b = s.map(get)
  console.log(`  ${nm.padEnd(18)} 相関 ${cor(a, b).toFixed(4)}　（${s.length.toLocaleString()}行）`)
}

// 全部まとめて線形で当てる
const use = rows.filter((r) => r.st > 0 && r.ex_st != null && r.ex_st > 0 && r.all_st != null && r.all_st > 0)
console.log(`\n全部まとめて予測（${use.length.toLocaleString()}行・展示STがある分だけ）`)
if (use.length > 5000) {
  const F = [
    (r) => r.ex_st, (r) => r.all_st ?? 0.16, (r) => r.r10_st ?? r.all_st ?? 0.16,
    (r) => r.r30_st ?? r.all_st ?? 0.16, (r) => courseSt(r) ?? 0.16,
    (r) => (r.f_count ?? 0), (r) => (r.l_count ?? 0),
    (r) => (r.course ?? r.lane), (r) => (r.wind_speed ?? 0), (r) => (r.wave ?? 0), () => 1,
  ]
  const D = F.length
  const cut = Math.floor(use.length * 0.7)
  const tr = use.slice(0, cut), te = use.slice(cut)
  // 正規方程式（小さいので直接解く）
  const A = Array.from({ length: D }, () => new Float64Array(D))
  const bv = new Float64Array(D)
  for (const r of tr) {
    const x = F.map((f) => f(r))
    for (let i = 0; i < D; i++) { for (let j = 0; j < D; j++) A[i][j] += x[i] * x[j]; bv[i] += x[i] * r.st }
  }
  for (let i = 0; i < D; i++) A[i][i] += 1e-6
  // ガウス消去
  const M = A.map((row, i) => [...row, bv[i]])
  for (let i = 0; i < D; i++) {
    let p = i
    for (let k = i + 1; k < D; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k
    ;[M[i], M[p]] = [M[p], M[i]]
    for (let k = i + 1; k < D; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= D; j++) M[k][j] -= f * M[i][j] }
  }
  const w = new Float64Array(D)
  for (let i = D - 1; i >= 0; i--) { let s = M[i][D]; for (let j = i + 1; j < D; j++) s -= M[i][j] * w[j]; w[i] = s / M[i][i] }
  const pred = te.map((r) => F.reduce((a, f, i) => a + w[i] * f(r), 0))
  const act = te.map((r) => r.st)
  const mAct = act.reduce((a, b) => a + b, 0) / act.length
  let ss = 0, sr = 0, ae = 0
  for (let i = 0; i < act.length; i++) { ss += (act[i] - mAct) ** 2; sr += (act[i] - pred[i]) ** 2; ae += Math.abs(act[i] - pred[i]) }
  console.log(`  相関 ${cor(act, pred).toFixed(4)}　説明できた割合(R²) ${(1 - sr / ss).toFixed(4)}`)
  console.log(`  平均誤差 ${(ae / act.length).toFixed(4)}秒　（STの標準偏差 ${Math.sqrt(ss / act.length).toFixed(4)}秒）`)
  console.log(`  ※ずっと平均値を答えた場合の平均誤差 ${(act.reduce((a, v) => a + Math.abs(v - mAct), 0) / act.length).toFixed(4)}秒`)
  console.log('\n  効いている材料（係数×その項目のばらつき）')
  const sd = F.map((f) => { const v = tr.map(f); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) })
  const nm = ['展示ST', '平均ST', '直近10走ST', '直近30走ST', 'コース別ST', 'F回数', 'L回数', 'コース', '風速', '波高', '定数']
  nm.map((n, i) => ({ n, v: Math.abs(w[i] * sd[i]) })).sort((a, b) => b.v - a.v).slice(0, 8)
    .forEach((x) => console.log(`    ${x.n.padEnd(12)} ${x.v.toFixed(5)}`))
}
// F・Lが読めるか
console.log('\nフライング・出遅れは読めるか')
{
  const s = rows.filter((r) => r.ex_st_flag != null || true)
  const fl = s.filter((r) => r.st_flag && r.st_flag !== '')
  console.log(`  本番でF・L ${fl.length.toLocaleString()}本（${(fl.length / s.length * 100).toFixed(2)}%）`)
  const exfl = s.filter((r) => r.ex_st_flag && r.ex_st_flag !== '')
  console.log(`  展示でF・L ${exfl.length.toLocaleString()}本`)
  if (exfl.length > 50) {
    const both = exfl.filter((r) => r.st_flag && r.st_flag !== '').length
    console.log(`  展示でF・Lだった艇が本番でもF・L ${both}本 = ${(both / exfl.length * 100).toFixed(2)}%（全体の基準率 ${(fl.length / s.length * 100).toFixed(2)}%）`)
  }
  const fc = s.filter((r) => (r.f_count ?? 0) >= 1)
  const fcfl = fc.filter((r) => r.st_flag && r.st_flag !== '').length
  console.log(`  F持ちの艇 ${fc.length.toLocaleString()}本中 本番でF・L ${fcfl}本 = ${(fcfl / Math.max(fc.length, 1) * 100).toFixed(2)}%`)
}
db.close()
