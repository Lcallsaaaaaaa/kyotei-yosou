// 複勝に、単勝と同じ「自信 × オッズ下限」の走査をかける。
//
//   node scripts/fukusho.mjs
//
// ★なぜ複勝を見るか
//   単勝オッズ2倍以上で回収110.6%が見つかった。単勝が効いた理由は
//   (1) 市場が薄い (2) モデルが1着予測に特化している の2つ。
//   複勝は「2着以内」なので当たりやすく、市場はさらに薄い。
//   ただしモデルの得意分野（1着）からはずれる。両方の効果がどう出るかは
//   測らないと分からない。
//
// ★複勝オッズは範囲で公表される
//   「1.7-2.6」のように下限と上限がある。どの艇が2着以内に入るかで確定額が変わるため。
//   検証では**下限**を使う。上限を使うと実際より良い結果が出る。
//   買う側から見れば「最低これだけは戻る」が下限なので、保守的に見積もる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'we1'), T3 = flag('t3', 'we3')

// モデルの「2着以内に入る確率」を3連単120通りから畳んで作る
console.log('読み込み中...')
const p2 = new Map()   // race_id -> Map(lane -> P(2着以内))
for (const r of all(`SELECT race_id, combo, p FROM ${T3}`)) {
  let g = p2.get(r.race_id); if (!g) { g = { tot: 0, m: new Map() }; p2.set(r.race_id, g) }
  const [a, b] = r.combo.split('-').map(Number)
  g.tot += r.p
  g.m.set(a, (g.m.get(a) ?? 0) + r.p)
  g.m.set(b, (g.m.get(b) ?? 0) + r.p)
}
for (const [, g] of p2) for (const [k, v] of g.m) g.m.set(k, v / g.tot)

const months = new Map()
for (const r of all(`SELECT race_id, month FROM ${T1} WHERE lane=1`)) months.set(r.race_id, r.month)

// 複勝オッズ（下限）と実際の着順
const rows = all(`
  SELECT o.race_id, o.lane, o.fukusho_lo AS odds, e.rank_num
  FROM odds_tan o
  JOIN entries e ON e.race_id = o.race_id AND e.lane = o.lane
  WHERE o.fukusho_lo IS NOT NULL AND o.fukusho_lo > 0`)
const data = []
for (const r of rows) {
  const g = p2.get(r.race_id); if (!g) continue
  const mo = months.get(r.race_id); if (!mo) continue
  data.push({ race_id: r.race_id, lane: r.lane, month: mo,
    p: g.m.get(r.lane) ?? 0, odds: r.odds, y: r.rank_num != null && r.rank_num <= 2 ? 1 : 0 })
}
console.log(`${data.length.toLocaleString()} 艇ぶん / ${new Set(data.map((d) => d.race_id)).size.toLocaleString()}レース`)

const ms = [...new Set(data.map((d) => d.month))].sort()
const half = Math.floor(ms.length / 2)
const isE = (r) => ms.indexOf(r.month) < half
console.log(`月 ${ms.join(' ')}\n`)

const st = (a) => {
  if (!a.length) return null
  return { n: a.length, hit: a.reduce((x, r) => x + r.y, 0) / a.length,
    roi: a.reduce((x, r) => x + r.y * r.odds, 0) / a.length,
    pp: a.reduce((x, r) => x + r.p, 0) / a.length }
}

// 各レースでモデルが「2着以内に入る確率が最も高い」と見た艇を1点買う
const byRace = new Map()
for (const d of data) { let g = byRace.get(d.race_id); if (!g) { g = []; byRace.set(d.race_id, g) } g.push(d) }
const tops = []
for (const [, g] of byRace) tops.push(g.reduce((a, b) => (b.p > a.p ? b : a)))

console.log('=== 複勝1点（モデルが2着以内に最も入りやすいと見た艇） ===')
console.log('  オッズ下限   点数    予想    実際    回収率   前半     後半   両方100%超')
let prev = null, mono = true
for (const th of [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0]) {
  const s = tops.filter((r) => r.odds >= th)
  const t = st(s); if (!t || t.n < 150) continue
  const e = st(s.filter(isE)), l = st(s.filter((r) => !isE(r)))
  const ok = e && l && e.roi >= 1 && l.roi >= 1
  if (prev !== null && t.roi < prev - 0.02) mono = false
  prev = t.roi
  console.log(`  ${th.toFixed(1).padStart(6)}倍  ${String(t.n).padStart(6)}  ${(t.pp * 100).toFixed(1).padStart(5)}%  ${(t.hit * 100).toFixed(1).padStart(5)}%  ${(t.roi * 100).toFixed(1).padStart(6)}%  ${(e ? (e.roi * 100).toFixed(1) : '-').padStart(6)}%  ${(l ? (l.roi * 100).toFixed(1) : '-').padStart(6)}%   ${ok ? '★' : ''}`)
}
console.log(`  → 閾値に対して${mono ? '単調に上昇（構造あり）' : '単調でない（偶然の可能性）'}`)

// 全艇を対象に、確率帯ごとの回収率
console.log('\n=== 全艇・モデルの2着以内確率の帯ごと ===')
console.log('  帯          艇数    予想    実際     ずれ    平均オッズ  回収率')
for (const [lo, hi] of [[0, .2], [.2, .3], [.3, .4], [.4, .5], [.5, .6], [.6, .7], [.7, .8], [.8, .9], [.9, 1]]) {
  const s = data.filter((r) => r.p >= lo && r.p < hi)
  const t = st(s); if (!t || t.n < 300) continue
  const ao = s.reduce((a, r) => a + r.odds, 0) / s.length
  console.log(`  ${(lo * 100).toFixed(0).padStart(2)}〜${(hi * 100).toFixed(0).padStart(3)}%  ${String(t.n).padStart(7)}  ${(t.pp * 100).toFixed(1).padStart(5)}%  ${(t.hit * 100).toFixed(1).padStart(5)}%  ${((t.hit - t.pp) * 100).toFixed(1).padStart(5)}pt   ${ao.toFixed(2).padStart(6)}   ${(t.roi * 100).toFixed(1).padStart(6)}%`)
}

// 上位2点買い（複勝は2着以内なので2点買うと片方は必ず外れる構造）
console.log('\n=== 参考：確率上位2点をそれぞれ複勝で買う ===')
const two = []
for (const [, g] of byRace) {
  const s = [...g].sort((a, b) => b.p - a.p).slice(0, 2)
  for (const x of s) two.push(x)
}
for (const th of [1.0, 1.4, 1.8, 2.2]) {
  const s = two.filter((r) => r.odds >= th)
  const t = st(s); if (!t || t.n < 300) continue
  const e = st(s.filter(isE)), l = st(s.filter((r) => !isE(r)))
  console.log(`  ${th.toFixed(1)}倍以上  ${String(t.n).padStart(6)}点  的中${(t.hit * 100).toFixed(1)}%  回収${(t.roi * 100).toFixed(1)}%  前半${(e ? (e.roi * 100).toFixed(1) : '-')}% / 後半${(l ? (l.roi * 100).toFixed(1) : '-')}%`)
}
console.log('\n※ 複勝オッズは範囲で公表される。ここでは保守的に**下限**を使用。')
db.close()
