// 保存した予測(pred)から、買うかどうかの判断に使える確率を作る。
//
//   node scripts/decide.mjs
//
// ★何が問題だったか
//   全部入りモデルは全体としてはよく当たっている（ずれの平均0.42pt）が、
//   **高確率帯だけ楽観的**だった：70〜80%で−2.1pt、80〜90%で−3.8pt、90%超で−10.9pt。
//   温度スケーリングはT=1.00（補正不要）と出た。全体を一律に薄める方法では直らない。
//   買うかどうかを決めるのはまさにこの高確率帯なので、ここを直さないと使えない。
//
// ★考え方
//   買い判断に要るのは「6艇の合計が1になる確率分布」ではなく
//   「**この艇の1着率は本当に何%か**」。後者に正規化は要らない。
//   だから補正期間で「予測値 → 実際の1着率」の対応表を作り、正規化せずにそのまま当てる。
//   （前回は補正後に正規化して打ち消してしまい、かえって悪化させた）

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)

const calib = all(`SELECT p, y FROM pred WHERE split='calib'`)
const test = all(`SELECT race_id, lane, date, course, p, y FROM pred WHERE split='test'`)
console.log(`補正 ${calib.length.toLocaleString()} / 検証 ${test.length.toLocaleString()}`)

/** 保序回帰（PAV）。順序は変えず、値だけ実績に寄せる */
function isotonic(pairs) {
  const s = [...pairs].sort((a, b) => a[0] - b[0])
  const bl = s.map(([x, y]) => ({ x, sum: y, n: 1 }))
  for (let i = 1; i < bl.length;) {
    if (bl[i - 1].sum / bl[i - 1].n <= bl[i].sum / bl[i].n) { i++; continue }
    bl[i - 1].sum += bl[i].sum; bl[i - 1].n += bl[i].n; bl[i - 1].x = bl[i].x
    bl.splice(i, 1); if (i > 1) i--
  }
  const xs = bl.map((b) => b.x), ys = bl.map((b) => b.sum / b.n)
  return (p) => {
    if (p <= xs[0]) return ys[0]
    if (p >= xs[xs.length - 1]) return ys[ys.length - 1]
    let lo = 0, hi = xs.length - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= p) lo = m; else hi = m }
    const t = (p - xs[lo]) / (xs[hi] - xs[lo] || 1)
    return ys[lo] + t * (ys[hi] - ys[lo])
  }
}
const cal = isotonic(calib.map((r) => [r.p, r.y]))

const table = (rows, get, label) => {
  console.log(`\n=== ${label} ===`)
  console.log('  帯          件数    予測平均   実際     ずれ    95%誤差幅')
  let wsum = 0, wn = 0
  for (let b = 0; b < 10; b++) {
    const s = rows.filter((r) => { const v = get(r); return v >= b / 10 && v < (b + 1) / 10 })
    if (!s.length) continue
    const pp = s.reduce((a, r) => a + get(r), 0) / s.length
    const ac = s.reduce((a, r) => a + r.y, 0) / s.length
    const se = Math.sqrt(Math.max(ac * (1 - ac), 1e-6) / s.length) * 1.96
    wsum += Math.abs(ac - pp) * s.length; wn += s.length
    console.log(`  ${(b * 10).toString().padStart(2)}〜${(b * 10 + 10).toString().padStart(3)}%  ${String(s.length).padStart(7)}  ${(pp * 100).toFixed(1).padStart(7)}% ${(ac * 100).toFixed(1).padStart(7)}% ${((ac - pp) * 100).toFixed(1).padStart(6)}pt  ±${(se * 100).toFixed(1)}pt`)
  }
  console.log(`  ずれの平均 ${(wsum / wn * 100).toFixed(2)}pt`)
}
table(test, (r) => r.p, '補正なし（検証期間）')
table(test, (r) => cal(r.p), '補正あり・正規化しない（検証期間）')

// 買う閾値をどこに置くか。実際の1着率が閾値を下回っていないかを見る。
console.log('\n=== 閾値ごとの実力（検証期間・単勝の1着率） ===')
console.log('  閾値    該当数   実際の1着率   95%下限   閾値を満たすか')
for (const th of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
  const s = test.filter((r) => cal(r.p) >= th)
  if (s.length < 30) { console.log(`  ${(th * 100).toFixed(0)}%   ${String(s.length).padStart(6)}   件数不足`); continue }
  const ac = s.reduce((a, r) => a + r.y, 0) / s.length
  const lo = ac - 1.96 * Math.sqrt(ac * (1 - ac) / s.length)
  console.log(`  ${(th * 100).toFixed(0)}%   ${String(s.length).padStart(6)}      ${(ac * 100).toFixed(1)}%      ${(lo * 100).toFixed(1)}%     ${lo >= th ? '満たす' : '**下回る**'}`)
}
db.close()
