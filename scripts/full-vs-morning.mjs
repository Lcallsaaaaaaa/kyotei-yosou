// 直前情報を入れたモデルが、入れないモデルより本当に良いかを測る。
//
//   node --max-old-space-size=4096 scripts/full-vs-morning.mjs
//
// ★なぜ測るか（2026-10-06）
//   chokuzen.mjs が毎日300〜400レースを差し替えているのに、
//   **本命が変わったのは4日間で0レース**。ならフルモデルは要らないのでは、
//   という話になった。本命が同じでも、確率の鋭さや2番手以降の並びが
//   良くなっていれば3連複4点・3連単4点には効く。そこを見てから決める。
//
// ★歩進検証の表（wi1 / wk1 / wj1）を直に比べる。
//   どれも「月ごとに学習し直して翌月を予想」したもので、同じレースを含む。
//   作った条件は走らせたときの引数で違う（--nobf など）。
//   名前で判断せず、**中身の成績で比べる**。
//
// ★見るもの
//   ・1着的中率        … 一番確率が高い艇が1着だった割合
//   ・対数尤度(logloss) … 確率の鋭さ。小さいほど良い
//   ・3着以内の並び     … 上位3艇に実際の1〜3着がいくつ入ったか
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
console.log('材料を読み込んでいます…')

const rank = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
  WHERE rank_num IS NOT NULL AND race_id >= '20251101'`).all()) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}
// 直前情報があるレース（展示が6艇そろっている）
const hasBefore = new Set()
{
  const c = new Map()
  for (const r of db.prepare(`SELECT race_id, COUNT(*) n FROM before_info
    WHERE ex_time > 0 AND race_id >= '20251101' GROUP BY race_id`).all())
    if (r.n >= 6) hasBefore.add(r.race_id)
  void c
}

const TABLES = ['wi1', 'wk1', 'wj1']
const P = {}
for (const t of TABLES) {
  const m = new Map()
  try {
    for (const r of db.prepare(`SELECT race_id, lane, p FROM ${t}`).all()) {
      if (!m.has(r.race_id)) m.set(r.race_id, [])
      m.get(r.race_id).push(r)
    }
  } catch { console.log(`${t} は読めません`); continue }
  P[t] = m
}
db.close()

// 3つとも持っていて結果もあるレースだけで比べる（同じ土俵）
const ids = [...(P[TABLES[0]]?.keys() ?? [])]
  .filter((id) => rank.has(id) && TABLES.every((t) => P[t]?.get(id)?.length === 6))
  .sort()
console.log(`${ids.length.toLocaleString()}レース（3つの表すべてにあるもの）`)
console.log(`うち直前情報がそろっているレース ${ids.filter((id) => hasBefore.has(id)).length.toLocaleString()}`)
console.log('')

function score(t, filter) {
  let n = 0, hit = 0, ll = 0, top3 = 0
  for (const id of ids) {
    if (filter && !filter(id)) continue
    const bs = [...P[t].get(id)].sort((a, b) => b.p - a.p)
    const rk = rank.get(id)
    n++
    if (rk.get(bs[0].lane) === 1) hit++
    // 対数尤度：実際に1着だった艇の確率
    const win = bs.find((b) => rk.get(b.lane) === 1)
    const sum = bs.reduce((s, b) => s + b.p, 0) || 1
    ll += -Math.log(Math.max((win?.p ?? 1e-6) / sum, 1e-9))
    // 上位3艇に実際の1〜3着がいくつ入ったか
    const picked = new Set(bs.slice(0, 3).map((b) => b.lane))
    for (const [lane, r] of rk) if (r <= 3 && picked.has(lane)) top3++
  }
  return { n, hit: hit / n * 100, ll: ll / n, top3: top3 / n }
}

const show = (title, filter) => {
  console.log('■ ' + title)
  console.log('  表     レース      1着的中    対数尤度(小さいほど良い)  上位3艇に入った数(最大3)')
  const rows = TABLES.filter((t) => P[t]).map((t) => ({ t, ...score(t, filter) }))
  for (const r of rows)
    console.log(`  ${r.t}  ${String(r.n.toLocaleString()).padStart(8)}  ${r.hit.toFixed(2).padStart(7)}%  ` +
      `${r.ll.toFixed(4).padStart(14)}  ${r.top3.toFixed(3).padStart(18)}`)
  const best = rows.slice().sort((a, b) => a.ll - b.ll)[0]
  const worst = rows.slice().sort((a, b) => b.ll - a.ll)[0]
  console.log(`  → 対数尤度でいちばん良いのは ${best.t}（差 ${(worst.ll - best.ll).toFixed(4)}）`)
  console.log('')
}

show('全レース', null)
show('直前情報がそろっているレースだけ', (id) => hasBefore.has(id))
show('直前情報が無いレースだけ', (id) => !hasBefore.has(id))

console.log('★ 直前情報を使うモデルなら、「そろっているレース」で他より良くなるはず。')
console.log('  そこで差が出なければ、直前情報を入れる意味は無い。')
