// 「1〜6号艇に数値を出して、高い順に着順を決める」方式を測る。
//
//   node --max-old-space-size=8192 scripts/singlescore.mjs
//
// ★本人の指摘
//   「1〜6号艇の数値が明確に出せば、数値が高い順に着順が決まるのでは？」
//   私はこれを「表現できない」と切り捨てたが、測っていなかった。測る。
//
// ★比べるもの
//   A（本人案）  各艇の数値1つ。高い順に1着2着3着。
//                2連単30通りは 数値i × 数値j で並べる
//   B（現行）    1着用・2着用・3着用の3組の重みで別々に計算（wk3）
//
//   どちらが的中率が高いか。点数を増やしたときの伸び方も見る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

// 実際の1〜3着
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}

// A：各艇の数値（wk1 の1着確率をそのまま「その艇の強さ」として使う）
const S = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p FROM wk1`).all()) {
  let a = S.get(r.race_id); if (!a) { a = []; S.set(r.race_id, a) }
  a.push({ lane: r.lane, p: r.p })
}

// B：現行の3組の重み（wk3 の3連単確率を2連単に畳む）
const B = new Map()
for (const r of db.prepare(`SELECT race_id,combo,p FROM wk3`).all()) {
  const k2 = r.combo.slice(0, r.combo.lastIndexOf('-'))
  let m = B.get(r.race_id); if (!m) { m = new Map(); B.set(r.race_id, m) }
  m.set(k2, (m.get(k2) ?? 0) + r.p)
}

const rankA_mul = [], rankA_pl = [], rankB = [], rank1st = []
for (const [rid, boats] of S) {
  const o = ORD.get(rid); if (!o || !o[1] || !o[2] || !o[3] || boats.length !== 6) continue
  const want2 = `${o[1]}-${o[2]}`

  // ── A-1：単純に 数値i × 数値j で並べる ──
  const mul = []
  for (const a of boats) for (const b of boats) if (a.lane !== b.lane)
    mul.push([`${a.lane}-${b.lane}`, a.p * b.p])
  mul.sort((x, y) => y[1] - x[1])
  const i1 = mul.findIndex(([k]) => k === want2); if (i1 >= 0) rankA_mul.push(i1 + 1)

  // ── A-2：数値i ×（残りの中での数値j の割合）＝順に選ぶ形 ──
  //   同じ数値を使うが、1着を除いた後で正規化し直す
  const pl = []
  for (const a of boats) {
    const rest = boats.filter((b) => b.lane !== a.lane)
    const t = rest.reduce((s, b) => s + b.p, 0)
    for (const b of rest) pl.push([`${a.lane}-${b.lane}`, a.p * (b.p / t)])
  }
  pl.sort((x, y) => y[1] - x[1])
  const i2 = pl.findIndex(([k]) => k === want2); if (i2 >= 0) rankA_pl.push(i2 + 1)

  // ── B：現行 ──
  const m = B.get(rid)
  if (m) {
    const list = [...m].sort((x, y) => y[1] - x[1])
    const i3 = list.findIndex(([k]) => k === want2); if (i3 >= 0) rankB.push(i3 + 1)
  }

  // 参考：1着だけ
  const top = [...boats].sort((x, y) => y.p - x.p)
  rank1st.push(top.findIndex((b) => b.lane === o[1]) + 1)
}

const curve = (arr, n) => arr.length ? arr.filter((x) => x <= n).length / arr.length * 100 : 0
const need90 = (arr) => { for (let n = 1; n <= 30; n++) if (curve(arr, n) >= 90) return n; return null }

console.log(`対象 ${rankB.length.toLocaleString()}レース\n`)
console.log('════ 2連単の的中率（点数ごと）════')
console.log('  点数   A-1 数値の掛け算   A-2 順に選ぶ    B 現行(3組の重み)')
for (const n of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 24, 30]) {
  const a1 = curve(rankA_mul, n), a2 = curve(rankA_pl, n), b = curve(rankB, n)
  const best = Math.max(a1, a2, b)
  const mk = (v) => (v.toFixed(2) + '%').padStart(9) + (Math.abs(v - best) < 0.005 ? '★' : ' ')
  console.log(`${String(n).padStart(6)} ${mk(a1)}      ${mk(a2)}   ${mk(b)}`)
}
console.log('')
console.log(`  90%に必要な点数   A-1 ${need90(rankA_mul) ?? '―'}点 ／ A-2 ${need90(rankA_pl) ?? '―'}点 ／ B ${need90(rankB) ?? '―'}点`)

console.log('\n════ 参考：1着だけの的中率（同じ数値で並べた場合）════')
for (const n of [1, 2, 3, 4, 5, 6]) console.log(`  ${n}点  ${curve(rank1st, n).toFixed(2)}%`)
db.close()
