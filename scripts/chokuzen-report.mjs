// chokuzen_log に貯まった「朝モデル vs フルモデル」を結果と突き合わせる。
//
//   node scripts/chokuzen-report.mjs                 貯まっているぶん全部
//   node scripts/chokuzen-report.mjs --from 2026-10-06
//   node scripts/chokuzen-report.mjs --days 14       直近14日
//
// ★何を見るか
//   同じレースに対して、朝モデル(194項目)とフルモデル(226項目)が
//   それぞれ何を本命にしたか・3連単4点が当たったかを並べる。
//   chokuzen.mjs が毎日1行ずつ貯めるので、走らせ直す必要は無い。
//
// ⚠ 回収率は**確定オッズ**（payouts）での数字。締切前に同じ値で買えるとは限らない。
//   [[boatrace-tansho-not-executable]] と同じ注意が効く。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 10000')

let rows
try {
  rows = db.prepare('SELECT * FROM chokuzen_log ORDER BY race_id').all()
} catch {
  console.log('chokuzen_log がまだありません。chokuzen.mjs が1回も走っていない状態です')
  process.exit(0)
}

const days = Number(flag('days', 0))
let from = flag('from')
if (days > 0) {
  const d = new Date(Date.now() - (days - 1) * 86400e3)
  const p2 = (n) => String(n).padStart(2, '0')
  from = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
if (from) rows = rows.filter((r) => r.date >= from)

if (!rows.length) { console.log('その範囲に記録がありません'); process.exit(0) }

// ---------- 結果 ----------
const rank = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
  WHERE rank_num IS NOT NULL AND race_id IN (${rows.map(() => '?').join(',')})`)
  .all(...rows.map((r) => r.race_id))) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}
const pay = new Map()   // race_id|種別|組 -> 払戻
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
  WHERE bet_type IN ('sanrentan','sanrenpuku') AND race_id IN (${rows.map(() => '?').join(',')})`)
  .all(...rows.map((r) => r.race_id)))
  pay.set(`${r.race_id}|${r.bet_type}|${r.combo}`, r.amount)
db.close()

const done = rows.filter((r) => rank.has(r.race_id))
const dates = [...new Set(done.map((r) => r.date))].sort()
const all = [...new Set(rows.map((r) => r.date))].sort()

console.log('■ 直前フルモデルの効き目（毎日の記録を積み上げたもの）')
console.log(`  記録 ${rows.length}レース（${all[0]} 〜 ${all.at(-1)}・${all.length}日分）`)
console.log(`  結果が出ている ${done.length}レース` + (dates.length ? `（${dates.length}日分・${dates[0]} 〜 ${dates.at(-1)}）` : ''))
console.log('')
if (!done.length) { console.log('まだ結果が出ていません（夜のバッチの後にもう一度）'); process.exit(0) }

const parse = (s) => (s ?? '').split('|').filter(Boolean)
  .map((x) => ({ lane: Number(x.split(':')[0]), p: Number(x.split(':')[1]) }))

const stat = { m: { hit: 0, ll: 0, n: 0 }, f: { hit: 0, ll: 0, n: 0 } }
let same = 0, sameTop3 = 0
for (const r of done) {
  const rk = rank.get(r.race_id)
  const M = parse(r.m_probs), F = parse(r.f_probs)
  if (M[0] && F[0] && M[0].lane === F[0].lane) same++
  if (M.slice(0, 3).map((x) => x.lane).join() === F.slice(0, 3).map((x) => x.lane).join()) sameTop3++
  for (const [k, bs] of [['m', M], ['f', F]]) {
    if (!bs.length) continue
    stat[k].n++
    if (rk.get(bs[0].lane) === 1) stat[k].hit++
    const win = bs.find((x) => rk.get(x.lane) === 1)
    const sum = bs.reduce((t, x) => t + x.p, 0) || 1
    stat[k].ll += -Math.log(Math.max((win?.p ?? 0.001) / sum, 1e-9))
  }
}

const pct = (a, b) => (b ? (a / b * 100).toFixed(2) : '0.00').padStart(6) + '%'
console.log(`  本命が一致            ${same}/${done.length}　(${(same / done.length * 100).toFixed(1)}%)`)
console.log(`  上位3艇の並びも一致    ${sameTop3}/${done.length}　(${(sameTop3 / done.length * 100).toFixed(1)}%)`)
console.log('')
console.log('              1着的中     対数尤度(小さいほど良い)')
for (const [k, label] of [['m', '朝モデル  '], ['f', 'フルモデル']])
  console.log(`  ${label}  ${pct(stat[k].hit, stat[k].n)}  ${(stat[k].ll / (stat[k].n || 1)).toFixed(4).padStart(14)}`)
console.log(`  差（フル − 朝）  1着 ${((stat.f.hit / stat.f.n - stat.m.hit / stat.m.n) * 100).toFixed(2)}pt`
  + ` ／ 対数尤度 ${(stat.f.ll / stat.f.n - stat.m.ll / stat.m.n).toFixed(4)}`)
console.log('')

// ---------- 売っている買い目のかたちで比べる ----------
console.log('【売っているかたち（4点買い）で比べる】')
for (const [col, type, label] of [['tri', 'sanrentan', '3連単4点'], ['puku', 'sanrenpuku', '3連複4点']]) {
  console.log(`  ${label}`)
  for (const [pre, who] of [['m', '朝モデル  '], ['f', 'フルモデル']]) {
    let n = 0, hit = 0, ret = 0
    for (const r of done) {
      const cs = (r[`${pre}_${col}`] ?? '').split(',').filter(Boolean).slice(0, 4)
      if (cs.length < 4) continue
      n++
      for (const c of cs) { const a = pay.get(`${r.race_id}|${type}|${c}`); if (a) { hit++; ret += a; break } }
    }
    console.log(`    ${who}  ${String(n).padStart(5)}レース　的中 ${pct(hit, n)}　回収 ${pct(ret, n * 400)}`)
  }
}
console.log('')
console.log('※ 回収率は確定オッズ。締切前に同じ値で買えるとは限らない')
if (dates.length < 7) console.log(`※ まだ${dates.length}日分。日が経つほど確かになる（7日・14日で見直す）`)
