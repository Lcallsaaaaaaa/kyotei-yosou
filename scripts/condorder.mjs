// 1着が決まったとき、2着・3着はどれだけ決まるのか。
//
//   node --max-old-space-size=4096 scripts/condorder.mjs
//
// ★なぜ要るか
//   いまのモデル（walk.mjs の fitPL）は、2着を選ぶときに
//   「1着が誰だったか」を入力していない。1着の艇を候補から外すだけ。
//   もし「1着が4号艇なら2着は5号艇が来やすい」といった構造が強ければ、
//   それを渡していないぶん損をしている。
//
// ★測ること
//   ① 1着の枠ごとに、2着はどの枠になるか（条件つき分布）
//   ② それが「1着を除いただけの分布」からどれだけ離れているか
//      離れていなければ渡す意味は無い。離れていれば渡す価値がある
//   ③ 3着も同じく（1着2着が決まった後）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
const races = [...ORD.values()].filter((m) => m[1] && m[2] && m[3])
console.log(`1〜3着がそろったレース ${races.length.toLocaleString()}\n`)

const pc = (n, d) => d ? (n / d * 100).toFixed(1) : '0.0'

// ---------- ① 全体の2着分布（1着を除いただけ） ----------
console.log('════ ① 全体：2着になった枠の割合 ════')
const all2 = [1, 2, 3, 4, 5, 6].map((L) => races.filter((m) => m[2] === L).length)
console.log('  ' + [1, 2, 3, 4, 5, 6].map((L, i) => `${L}号艇 ${pc(all2[i], races.length)}%`).join('  '))

// ---------- ② 1着の枠ごとの2着分布 ----------
console.log('\n════ ② 1着の枠ごとに、2着はどの枠か ════')
console.log('1着     本数    2着→ 1号艇   2号艇   3号艇   4号艇   5号艇   6号艇   最頻')
for (let W = 1; W <= 6; W++) {
  const s = races.filter((m) => m[1] === W)
  if (!s.length) continue
  const d = [1, 2, 3, 4, 5, 6].map((L) => (L === W ? null : s.filter((m) => m[2] === L).length))
  const top = d.map((v, i) => [i + 1, v]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0]
  console.log(`${W}号艇 ${String(s.length).padStart(9)}      ` +
    d.map((v) => (v == null ? '  ―  ' : pc(v, s.length) + '%').padStart(7)).join('') +
    `   ${top[0]}号艇`)
}

// ---------- ③ 「1着を除いただけ」の予測とどれだけ違うか ----------
// 1着を除いた後、残り5艇の全体割合を正規化したものを「素朴な予測」とする
console.log('\n════ ③ 素朴な予測（1着を除いて正規化）との差 ════')
console.log('※ 差が小さければ「1着が誰か」を渡す意味は無い。大きければ渡す価値がある')
console.log('1着     2着の枠   実際     素朴な予測    差')
let maxGap = 0
for (let W = 1; W <= 6; W++) {
  const s = races.filter((m) => m[1] === W)
  if (s.length < 1000) continue
  const rest = [1, 2, 3, 4, 5, 6].filter((L) => L !== W)
  const base = rest.map((L) => all2[L - 1])
  const bsum = base.reduce((a, b) => a + b, 0)
  for (let i = 0; i < rest.length; i++) {
    const L = rest[i]
    const act = s.filter((m) => m[2] === L).length / s.length
    const naive = base[i] / bsum
    const gap = (act - naive) * 100
    if (Math.abs(gap) > Math.abs(maxGap)) maxGap = gap
    console.log(`${W}号艇   ${L}号艇  ${(act * 100).toFixed(1).padStart(7)}% ${(naive * 100).toFixed(1).padStart(11)}% ${gap.toFixed(1).padStart(8)}pt${Math.abs(gap) > 5 ? '  ★' : ''}`)
  }
  console.log('')
}
console.log(`最大のズレ ${maxGap.toFixed(1)}pt`)

// ---------- ④ 3着も同じく ----------
console.log('\n════ ④ 1着2着が決まったとき、3着はどこまで絞れるか ════')
console.log('※ 上位10パターンだけ')
const pairs = new Map()
for (const m of races) {
  const k = `${m[1]}-${m[2]}`
  let a = pairs.get(k); if (!a) { a = []; pairs.set(k, a) }
  a.push(m[3])
}
const top = [...pairs].sort((a, b) => b[1].length - a[1].length).slice(0, 10)
console.log('1着-2着   本数     3着の内訳（多い順）              最頻の割合')
for (const [k, v] of top) {
  const c = [1, 2, 3, 4, 5, 6].map((L) => [L, v.filter((x) => x === L).length])
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  console.log(`${k.padEnd(8)} ${String(v.length).padStart(7)}   ` +
    c.slice(0, 4).map(([L, n]) => `${L}号艇${pc(n, v.length)}%`).join(' ') +
    `   ${pc(c[0][1], v.length)}%`)
}

// ---------- ⑤ 決まり手が分かれば2着はもっと絞れるか ----------
console.log('\n════ ⑤ 1着の枠＋決まり手ごとの2着分布 ════')
const KM = new Map()
for (const r of db.prepare(`SELECT race_id,kimarite FROM races WHERE kimarite IS NOT NULL AND kimarite <> ''`).all())
  KM.set(r.race_id, r.kimarite)
const withK = []
for (const [rid, m] of ORD) {
  if (!m[1] || !m[2] || !m[3]) continue
  const k = KM.get(rid); if (k) withK.push({ ...m, k })
}
console.log('1着  決まり手      本数    2着の最頻     割合    （枠だけの場合との差）')
for (let W = 1; W <= 6; W++) {
  const base = races.filter((m) => m[1] === W)
  if (base.length < 1000) continue
  const baseTop = [1, 2, 3, 4, 5, 6].filter((L) => L !== W)
    .map((L) => [L, base.filter((m) => m[2] === L).length]).sort((a, b) => b[1] - a[1])[0]
  const basePc = baseTop[1] / base.length
  const ks = [...new Set(withK.filter((x) => x[1] === W).map((x) => x.k))]
  for (const k of ks) {
    const s = withK.filter((x) => x[1] === W && x.k === k)
    if (s.length < 800) continue
    const c = [1, 2, 3, 4, 5, 6].filter((L) => L !== W)
      .map((L) => [L, s.filter((x) => x[2] === L).length]).sort((a, b) => b[1] - a[1])[0]
    const p = c[1] / s.length
    console.log(`${W}号艇 ${k.padEnd(10)} ${String(s.length).padStart(7)}   ${c[0]}号艇 ${(p * 100).toFixed(1).padStart(8)}%   ${((p - basePc) * 100).toFixed(1).padStart(7)}pt${Math.abs(p - basePc) * 100 > 5 ? '  ★' : ''}`)
  }
}
db.close()
