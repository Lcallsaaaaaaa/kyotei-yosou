// 「自信度が低いレース」を、本命の堅さで分けて測り直す。
//
//   node --max-old-space-size=4096 scripts/oana-split.mjs
//
// ★なぜ要るか（2026-10-09・実機で見つけた）
//   自信度＝3連複の上位4組の合計。これは「**3着までを絞り込めるか**」の目安で、
//   「**1着が堅いか**」ではない。
//   実例：鳴門12R（10/09）は 1号艇の1着確率 85.8% なのに自信度 0.5413。
//     2着3着が割れているだけで、1着は堅い。
//   ところが自信度だけで振り分けていたので、このレースに**本命を外す大穴**を出し、
//   同じページで「イン逃げ濃厚・本線は1号艇 逃げ 85.8%」と書いていた。
//   **買う人から見れば矛盾**で、商品として成立しない。
//
//   ここで測るのは「自信度が低いレース」を2つに割ったときの大穴の成績：
//     ① 本命も割れている（真に荒れる）
//     ② 本命は堅いが2着3着が割れている ← ここに大穴を出すのが正しいのか
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 30000')
console.log('材料を読み込んでいます…')

// 1着確率（歩進検証）
const P1 = new Map()
for (const r of db.prepare('SELECT race_id, lane, p FROM wi1').all()) {
  if (!P1.has(r.race_id)) P1.set(r.race_id, [])
  P1.get(r.race_id).push({ lane: r.lane, p: r.p })
}
// 3連単（歩進検証）
const P3 = new Map()
for (const r of db.prepare('SELECT race_id, combo, p FROM wi3').all()) {
  if (!P3.has(r.race_id)) P3.set(r.race_id, [])
  P3.get(r.race_id).push({ combo: r.combo, p: r.p })
}
const payT = new Map()
for (const r of db.prepare("SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrentan'").all())
  payT.set(`${r.race_id}|${r.combo}`, r.amount)
db.close()

const toFuku = (c) => c.split('-').map(Number).sort((a, b) => a - b).join('-')
const POOL = 120

const races = []
for (const [id, arr] of P3) {
  if (arr.length < 60 || !P1.has(id)) continue
  const cs = arr.slice().sort((a, b) => b.p - a.p).slice(0, POOL)
  // 自信度＝3連複の上位4組の合計
  const seen = new Set()
  for (const x of cs) { const f = toFuku(x.combo); if (!seen.has(f)) seen.add(f); if (seen.size === 4) break }
  let conf = 0
  for (const x of cs) if (seen.has(toFuku(x.combo))) conf += x.p
  // 本命の1着確率
  const top = P1.get(id).slice().sort((a, b) => b.p - a.p)[0]
  // 大穴＝本命を外した上位4点
  const oana = cs.filter((x) => !x.combo.split('-').map(Number).includes(top.lane)).slice(0, 4).map((x) => x.combo)
  // 中穴＝本命を2着か3着に置いた上位4点
  const chu = cs.filter((x) => { const [a, b, c] = x.combo.split('-').map(Number)
    return a !== top.lane && (b === top.lane || c === top.lane) }).slice(0, 4).map((x) => x.combo)
  // 本命の型＝素直に上位4点（本命が堅ければ 1-X-Y が並ぶ）
  const honmei = cs.slice(0, 4).map((x) => x.combo)
  // 3連複の型（組は昇順に直す）
  const fu = []
  const seenF = new Set()
  for (const x of cs) { const f = toFuku(x.combo); if (!seenF.has(f)) { seenF.add(f); fu.push(f) } if (fu.length === 4) break }
  races.push({ id, conf, fav: top.p, oana, chu, honmei, hfuku: fu.slice(0, 4), kenjitsu: fu.slice(0, 2) })
}
races.sort((a, b) => a.id.localeCompare(b.id))
const CUT = races[Math.floor(races.length / 2)].id.slice(0, 8)
const half = (id) => (id.slice(0, 8) < CUT ? 0 : 1)
const TL = races.map((r) => r.conf).sort((a, b) => a - b)[Math.floor(races.length * 0.50)]

console.log('')
console.log(`■ 歩進検証 ${races.length.toLocaleString()}レース（前半 〜${CUT} ／ 後半 ${CUT}〜）`)
console.log(`  自信度の下位50%の境目 = ${TL.toFixed(4)}`)
console.log('')

function run(set, key) {
  const s = [0, 1].map(() => ({ races: 0, bets: 0, hit: 0, ret: 0, best: 0, man: 0 }))
  for (const r of set) {
    const buy = r[key]
    if (!buy?.length) continue
    const h = s[half(r.id)]
    h.races++; h.bets += buy.length
    for (const c of buy) { const a = payT.get(`${r.id}|${c}`); if (a) { h.hit++; h.ret += a; if (a > h.best) h.best = a; if (a >= 10000) h.man++; break } }
  }
  return s
}
const payF = new Map()
{
  const { DatabaseSync } = await import('node:sqlite')
  const d2 = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
  d2.exec('PRAGMA busy_timeout = 30000')
  for (const r of d2.prepare("SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrenpuku'").all())
    payF.set(`${r.race_id}|${r.combo}`, r.amount)
  d2.close()
}
function runF(set, key) {
  const s2 = [0, 1].map(() => ({ races: 0, bets: 0, hit: 0, ret: 0, man: 0 }))
  for (const r of set) {
    const buy = r[key]; if (!buy?.length) continue
    const h = s2[half(r.id)]; h.races++; h.bets += buy.length
    for (const c of buy) { const a = payF.get(`${r.id}|${c}`); if (a) { h.hit++; h.ret += a; if (a >= 10000) h.man++; break } }
  }
  return s2
}
const showF = (label, set, key) => {
  const s2 = runF(set, key)
  if (!s2[0].races || !s2[1].races) { console.log(`  ${label.padEnd(40)}本数が足りません`); return }
  const hit = s2.map((x) => x.hit / x.races * 100)
  const roi = s2.map((x) => x.ret / (x.bets * 100) * 100)
  const n = s2[0].races + s2[1].races
  const avg = (s2[0].ret + s2[1].ret) / Math.max(1, s2[0].hit + s2[1].hit)
  console.log(`  ${label.padEnd(40)}${String(n).padStart(6)}  `
    + `的中 ${hit[0].toFixed(1).padStart(4)}/${hit[1].toFixed(1).padStart(4)}%  `
    + `回収 ${roi[0].toFixed(1).padStart(5)}/${roi[1].toFixed(1).padStart(5)}%  `
    + `平均${Math.round(avg).toLocaleString().padStart(6)}円`)
}
const show = (label, set, key) => {
  const s = run(set, key)
  if (!s[0].races || !s[1].races) { console.log(`  ${label.padEnd(40)}本数が足りません`); return }
  const hit = s.map((x) => x.hit / x.races * 100)
  const roi = s.map((x) => x.ret / (x.bets * 100) * 100)
  const n = s[0].races + s[1].races
  const avg = (s[0].ret + s[1].ret) / Math.max(1, s[0].hit + s[1].hit)
  const man = s[0].man + s[1].man
  const agree = roi.every((v) => v >= 100) || roi.every((v) => v < 100)
  console.log(`  ${label.padEnd(40)}${String(n).padStart(6)}  `
    + `的中 ${hit[0].toFixed(1).padStart(4)}/${hit[1].toFixed(1).padStart(4)}%  `
    + `回収 ${roi[0].toFixed(1).padStart(5)}/${roi[1].toFixed(1).padStart(5)}%  `
    + `平均${Math.round(avg).toLocaleString().padStart(6)}円  `
    + (man ? `万舟${Math.round(n / man)}本に1回` : '万舟なし')
    + (agree ? '' : '  ← 前後で食い違う'))
}

const lo = races.filter((r) => r.conf <= TL)
console.log('【自信度が低いレース（下位50%）を、本命の堅さで割る】')
console.log(`  ${''.padEnd(40)}レース  的中(前/後)     回収(前/後)      平均配当  万舟`)
show('全部（いま出しているもの）', lo, 'oana')
console.log('')
for (const [lo2, hi2] of [[0, 0.40], [0.40, 0.55], [0.55, 0.70], [0.70, 1.01]]) {
  const set = lo.filter((r) => r.fav >= lo2 && r.fav < hi2)
  show(`大穴：本命の1着確率 ${(lo2 * 100).toFixed(0)}〜${(hi2 * 100).toFixed(0)}%`, set, 'oana')
}
console.log('')
for (const [lo2, hi2] of [[0, 0.40], [0.40, 0.55], [0.55, 0.70], [0.70, 1.01]]) {
  const set = lo.filter((r) => r.fav >= lo2 && r.fav < hi2)
  show(`中穴：本命の1着確率 ${(lo2 * 100).toFixed(0)}〜${(hi2 * 100).toFixed(0)}%`, set, 'chu')
}
console.log('')
for (const [lo2, hi2] of [[0, 0.40], [0.40, 0.55], [0.55, 0.70], [0.70, 1.01]]) {
  const set = lo.filter((r) => r.fav >= lo2 && r.fav < hi2)
  show(`本命：本命の1着確率 ${(lo2 * 100).toFixed(0)}〜${(hi2 * 100).toFixed(0)}%`, set, 'honmei')
}
console.log('')
console.log('【直す案：自信度が低く、かつ本命が55%未満のときだけ穴を出す】')
{
  const set = lo.filter((r) => r.fav < 0.55)
  show('大穴（本命55%未満に限る）', set, 'oana')
  show('中穴（本命55%未満に限る）', set, 'chu')
  const set2 = lo.filter((r) => r.fav >= 0.55)
  show('本命（自信度は低いが本命は堅い）', set2, 'honmei')
}
console.log('')
console.log('【案B：自信度をやめて「本命の1着確率」だけで振り分ける】')
console.log('  画面に出ている「本線 X号艇 NN%」と同じ物差しなので、言っていることが食い違わない')
{
  const katai = races.filter((r) => r.fav >= 0.55)
  const ware = races.filter((r) => r.fav < 0.55)
  console.log(`  本命が堅い（55%以上）${katai.length.toLocaleString()}レース ／ 割れている（55%未満）${ware.length.toLocaleString()}レース`)
  show('  本命 3連単4点（堅いレース）', katai, 'honmei')
  show('  大穴 3連単4点（割れたレース）', ware, 'oana')
  show('  中穴 3連単4点（割れたレース）', ware, 'chu')
  showF('  本命 3連複4点（堅いレース）', katai, 'hfuku')
  showF('  堅実 3連複2点（堅いレース）', katai, 'kenjitsu')
  console.log('')
  console.log('  ＜参考＞逆に出したらどうなるか（＝いまの作りで起きていたこと）')
  show('  大穴を堅いレースに出す', katai, 'oana')
  show('  本命を割れたレースに出す', ware, 'honmei')
}
console.log('')
console.log('■ 読み方')
console.log('  本命の1着確率が高い帯で大穴の回収が落ちるなら、そこには出してはいけない。')
console.log('  （画面に「イン逃げ濃厚・本線は1号艇85.8%」と書きながら本命を外す券を出すことになる）')
console.log('※ 回収率は確定払戻。締切前に同じ値で買えるとは限らない')
