// 単勝プールの大きさを、オッズの整数制約から全レースで絞り込む。
//   node --max-old-space-size=8192 scripts/pool.mjs
//   node --max-old-space-size=8192 scripts/pool.mjs --races 5000 --rate 0.75
//
// ★なぜ要るか
//   総取り式なので、自分の賭け金でオッズが動く。実測254本から
//   「そのレースの単勝プールの7.05%を1点に入れると回収率が100%に落ちる」と分かった。
//   だが**単勝の発売額は公開されていない**（公式ページにもKファイルにも無い）。
//   円でいくらまで賭けられるかを言うには、プールの大きさが要る。
//
// ★考え方
//   オッズは「整数枚の票」から作られる。
//     オッズ_i = 払戻率 × 総票数 / その艇の票数     （100円=1票）
//   表示は小数1桁で切り捨てなので、表示 o のとき真のオッズは [o, o+0.1) にある。
//   よって その艇の票数 n_i は  (0.75N/(o+0.1), 0.75N/o]  の整数。
//   さらに Σn_i = N（全部の票を足すと総票数）。
//   この2つを同時に満たす N を小さい方から探せば、**プールの下限**が出る。
//   1レースでは緩いが、全レースで見れば分布として意味を持つ。
//
// ★これは下限であって実額ではない
//   大きい N ではこの制約はほぼ常に満たされるので、上限は決まらない。
//   「少なくともこれ以上はある」しか言えない。それでも
//   「100円で影響が出るか」を判断するには足りる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? Number(argv[i + 1]) : d }
const LIMIT = flag('races', 3000)
const RATE = flag('rate', 0.75)
const MAXN = flag('maxn', 200000)

/** その N が6艇の表示オッズと矛盾しないか */
function feasible(o, N) {
  let lo = 0, hi = 0
  for (let i = 0; i < 6; i++) {
    const a = Math.floor(RATE * N / (o[i] + 0.1)) + 1   // 下限（開区間なので+1）
    const b = Math.floor(RATE * N / o[i])               // 上限（閉区間）
    if (a > b) return false
    lo += a; hi += b
  }
  return lo <= N && N <= hi
}
function minPool(o) {
  for (let N = 6; N <= MAXN; N++) if (feasible(o, N)) return N
  return null
}

const races = []
{
  let cur = null, list = []
  const flush = () => { if (cur && list.length === 6 && list.every((x) => x > 0)) races.push({ id: cur, o: list }); list = [] }
  for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan
      WHERE tansho > 0 ORDER BY race_id, lane`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r.tansho)
  }
  flush()
}
console.log(`6艇そろったレース ${races.length.toLocaleString()}件。うち先頭 ${Math.min(LIMIT, races.length).toLocaleString()}件で解く`)
console.log(`払戻率 ${RATE}（Σ(1/オッズ) の実測中央値 1.359 からの推定）\n`)

const out = []
let none = 0
for (const r of races.slice(0, LIMIT)) {
  const n = minPool(r.o)
  if (n == null) { none++; continue }
  out.push(n)
}
out.sort((a, b) => a - b)
const q = (p) => out[Math.floor(out.length * p)]
console.log(`解けた ${out.length.toLocaleString()}件 / 上限まで解なし ${none}件\n`)
console.log('【プールの下限（票数＝100円単位）の分布】')
for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99])
  console.log(`  下位${String(p * 100).padStart(3)}%  ${String(q(p)).padStart(8)}票 = ${(q(p) * 100).toLocaleString().padStart(12)}円`)
console.log(`  最小       ${String(out[0]).padStart(8)}票 = ${(out[0] * 100).toLocaleString().padStart(12)}円`)
console.log('')
console.log('【この下限だと、賭け金がプールの何%になるか】')
console.log('  賭け金    最小のレースで   下位5%のレースで   中央のレースで')
for (const x of [100, 500, 1000, 5000, 10000]) {
  const f = (N) => (x / (N * 100) * 100).toFixed(2) + '%'
  console.log(`  ${(x.toLocaleString() + '円').padStart(8)} ${f(out[0]).padStart(14)} ${f(q(0.05)).padStart(16)} ${f(q(0.5)).padStart(15)}`)
}
console.log('\n  ※ 7.05%を超えると優位が消える。上の値がそれを下回っていれば安全側。')
console.log('  ※ これは下限。実際のプールはこれ以上なので、影響は表より小さい。')
db.close()
