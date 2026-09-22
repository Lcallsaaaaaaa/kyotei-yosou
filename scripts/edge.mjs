// 単勝の回収率に直結する指標を測る。
//
//   node --max-old-space-size=6144 scripts/edge.mjs --t wi1
//   node --max-old-space-size=6144 scripts/edge.mjs --t wi1,wm1,wgb1,wk1b   並べて比較
//
// ★なぜ全体の的中率ではダメか
//   単勝の回収率は「本命を当てる力」ではなく「市場が間違えている買い目を見つける力」で決まる。
//   必要倍率に引っかかるのは全体の約10%（オッズが高い＝市場が低く見ている艇）だけ。
//   実測でも、1着的中が最高のモデル（木3段階57.54%）が回収率では最低（144.37%）だった。
//   **測る場所が違っていた。**
//
// ★ここで測るもの
//   ① 選ばれる領域での確率のずれ … モデルが言った確率 対 実際の的中率（校正）
//   ② 市場とのズレの向き        … モデル確率 ÷ 市場確率 の帯ごとに、実際どちらが正しいか
//   ③ 期待値の実現度            … Σ(p×オッズ) の理屈 対 実測の回収
//   ④ 余裕ごとの回収と本数       … 実際にいくら儲かるか
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const TS = flag('t', 'wi1').split(',')

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate()) {
  let a = OD.get(r.race_id); if (!a) { a = {}; OD.set(r.race_id, a) }
  a[r.lane] = r.tansho
}
/** 市場の1着確率（単勝オッズを正規化） */
const mkt = (o) => {
  const r = [1, 2, 3, 4, 5, 6].map((l) => (o[l] > 0 ? 1 / o[l] : 0))
  const s = r.reduce((a, b) => a + b, 0)
  return r.map((v) => v / s)
}
// 共通レース
let common = null
for (const T of TS) {
  const s = new Set(db.prepare(`SELECT DISTINCT race_id FROM ${T}`).all().map((r) => r.race_id))
  common = common ? new Set([...common].filter((x) => s.has(x))) : s
}
console.log(`共通レース ${common.size.toLocaleString()}\n`)

const load = (T) => {
  const R = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, p, y, month FROM ${T}`).iterate()) {
    if (!common.has(r.race_id)) continue
    let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
    a.push(r)
  }
  const out = []
  for (const [rid, bs] of R) {
    if (bs.length !== 6) continue
    const o = OD.get(rid); if (!o) continue
    const q = mkt(o)
    bs.sort((a, b) => a.lane - b.lane)
    // 全6艇を候補として持つ（本命だけでなく、必要倍率を満たす艇はどれでも買える）
    for (let i = 0; i < 6; i++) {
      const od = o[bs[i].lane]
      if (!(od > 0)) continue
      out.push({ rid, mo: bs[i].month, lane: bs[i].lane, p: bs[i].p, q: q[i], od, hit: bs[i].y === 1,
        top: bs.reduce((a, b) => (b.p > a.p ? b : a)).lane === bs[i].lane })
    }
  }
  return out
}
for (const T of TS) {
  const rows = load(T)
  console.log(`━━━━ ${T} ━━━━`)
  // 全体の的中（本命1点）
  {
    const t = rows.filter((r) => r.top)
    console.log(`  参考：本命1点の的中 ${(t.filter((r) => r.hit).length / t.length * 100).toFixed(2)}%（${t.length.toLocaleString()}レース）`)
  }
  // ① 選ばれる領域での校正
  console.log('\n  ① 必要倍率で選ばれる買い目の校正（余裕1.3・本命に限らず全艇）')
  const sel = rows.filter((r) => r.od >= (1 / r.p) * 1.3)
  console.log('    確率帯      本数   言った確率  実際の的中  ずれ    その帯の回収')
  for (const [lo, hi] of [[0, 0.15], [0.15, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 0.75], [0.75, 1.01]]) {
    const s = sel.filter((r) => r.p >= lo && r.p < hi)
    if (s.length < 100) continue
    const said = s.reduce((a, r) => a + r.p, 0) / s.length * 100
    const act = s.filter((r) => r.hit).length / s.length * 100
    const ret = s.filter((r) => r.hit).reduce((a, r) => a + r.od * 100, 0) / (s.length * 100) * 100
    console.log(`    ${lo.toFixed(2)}〜${hi.toFixed(2)} ${String(s.length).padStart(8)} ${said.toFixed(2).padStart(10)}% ${act.toFixed(2).padStart(10)}% ${(act - said).toFixed(2).padStart(7)} ${ret.toFixed(2).padStart(12)}%`)
  }
  const said = sel.reduce((a, r) => a + r.p, 0) / sel.length * 100
  const act = sel.filter((r) => r.hit).length / sel.length * 100
  console.log(`    合計    ${String(sel.length).padStart(8)} ${said.toFixed(2).padStart(10)}% ${act.toFixed(2).padStart(10)}% ${(act - said).toFixed(2).padStart(7)}`)
  // ② 市場とのズレの向きごとの正しさ
  console.log('\n  ② モデル確率 ÷ 市場確率 の帯ごとに、どちらが正しいか（全艇）')
  console.log('    ズレ       本数    モデルが言った  市場が言った  実際   モデルの誤差  市場の誤差')
  for (const [lo, hi] of [[0, 0.7], [0.7, 0.9], [0.9, 1.1], [1.1, 1.4], [1.4, 2.0], [2.0, 99]]) {
    const s = rows.filter((r) => r.q > 0 && r.p / r.q >= lo && r.p / r.q < hi)
    if (s.length < 500) continue
    const mp = s.reduce((a, r) => a + r.p, 0) / s.length * 100
    const mq = s.reduce((a, r) => a + r.q, 0) / s.length * 100
    const ac = s.filter((r) => r.hit).length / s.length * 100
    console.log(`    ${lo.toFixed(1)}〜${hi > 90 ? '  ' : hi.toFixed(1)} ${String(s.length).padStart(8)} ${mp.toFixed(2).padStart(13)}% ${mq.toFixed(2).padStart(12)}% ${ac.toFixed(2).padStart(7)}% ${(mp - ac).toFixed(2).padStart(12)} ${(mq - ac).toFixed(2).padStart(11)}`)
  }
  // ③④ 余裕ごと
  console.log('\n  ③ 余裕ごとの理屈と実測')
  console.log('    余裕   本数   1日   理屈上の回収  実測の回収   差   1日100円の損益')
  for (const m of [1.0, 1.2, 1.3, 1.5, 1.8]) {
    const s = rows.filter((r) => r.od >= (1 / r.p) * m)
    if (s.length < 200) continue
    const theo = s.reduce((a, r) => a + r.p * r.od, 0) / s.length * 100
    const ret = s.filter((r) => r.hit).reduce((a, r) => a + r.od * 100, 0)
    const roi = ret / (s.length * 100) * 100
    const days = common.size / 149.6
    console.log(`    ${m.toFixed(1)} ${String(s.length).padStart(7)} ${(s.length / days).toFixed(1).padStart(5)}本 ${theo.toFixed(2).padStart(12)}% ${roi.toFixed(2).padStart(11)}% ${(roi - theo).toFixed(2).padStart(7)} ${((ret - s.length * 100) / days).toFixed(0).padStart(13)}円`)
  }
  // 月ごと
  const s13 = rows.filter((r) => r.od >= (1 / r.p) * 1.3)
  const MOS = [...new Set(s13.map((r) => r.mo))].filter(Boolean).sort()
  const per = MOS.map((mo) => {
    const t = s13.filter((r) => r.mo === mo)
    if (t.length < 50) return null
    return t.filter((r) => r.hit).reduce((a, r) => a + r.od * 100, 0) / (t.length * 100) * 100
  }).filter((x) => x != null)
  console.log(`\n  ④ 余裕1.3の月ごと（${per.length}ヶ月）　100%超 ${per.filter((x) => x >= 100).length}ヶ月　最低 ${Math.min(...per).toFixed(1)}%　最高 ${Math.max(...per).toFixed(1)}%`)
  console.log(`     ${per.map((x) => x.toFixed(0) + '%').join(' ')}\n`)
}
db.close()
