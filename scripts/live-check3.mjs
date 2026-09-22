// 実際に動いている判定を、本番モデルの出力(pred)で測る。
//   node --max-old-space-size=8192 scripts/live-check3.mjs
//
// ★なぜ measured しなおすか
//   これまでの「的中16.53%・回収172.69%」は wi1（歩進検証）で測り、
//   校正表も wi1 から作っていた。同じモデルの中で閉じていたので筋は通る。
//   だが朝に動くのは predict.mjs → model5.json で、その出力は pred に入っている。
//   pred と wi1 は 1着的中も対数尤度も同じだが**確率の鋭さが違う**
//   （3連複上位4点の合計の中央値 0.6135 対 0.6705）。
//   鋭さが違う確率に他モデル由来の校正表を当てると、必要倍率がずれる。
//
// ★時点を守る
//   model5.json は 2026-03-25 まで学習済み。評価は split='test' だけ（2026-05-19〜08-18）。
//   校正表は split='calib'（2026-03-25〜05-18）から作る。test は一切使わない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { PB, OB, binOf } from './calib.mjs'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  OD.set(r.race_id + '|' + r.lane, r.tansho)
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)

/** 表を渡して校正表を作る。行は {race_id,lane,p,y} */
function build(rows, K = 300) {
  const M = new Map()
  for (const r of rows) {
    const od = OD.get(r.race_id + '|' + r.lane)
    if (!(od > 0)) continue
    const k = binOf(PB, r.p) + '|' + binOf(OB, od)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.y; a.sp += r.p
  }
  const cal = new Map()
  for (const [k, a] of M) {
    const obs = a.h / a.n, said = a.sp / a.n, w = a.n / (a.n + K)
    cal.set(k, (w * obs + (1 - w) * said) / Math.max(said, 1e-9))
  }
  return cal
}
const cal = (c, p, o) => { const x = c.get(binOf(PB, p) + '|' + binOf(OB, o)); return x ? Math.min(0.999, Math.max(1e-6, p * x)) : p }

const CAL_WI1 = build(db.prepare(`SELECT race_id, lane, p, y FROM wi1`).all())
const CAL_PRD = build(db.prepare(`SELECT race_id, lane, p, y FROM pred WHERE split='calib'`).all())
console.log(`校正表  wi1由来 ${CAL_WI1.size}升 / pred(calib)由来 ${CAL_PRD.size}升`)

const test = db.prepare(`SELECT race_id, lane, p, y, date FROM pred WHERE split='test'`).all()
const DAYS = new Set(test.map((r) => r.date)).size
console.log(`評価 split=test  ${(test.length / 6).toFixed(0)}レース / ${DAYS}日（${test[0].date} 〜 ${test[test.length - 1].date}）`)
console.log(`設定 余裕${S.MARGIN} / 全6艇=${S.ALL_LANES} / 上限${S.MAX_BUY}本\n`)

function run(name, calTable) {
  let bets = 0, hit = 0, ret = 0, sumP = 0, sumEV = 0
  const per = new Map()
  for (const r of test) {
    const o = OD.get(r.race_id + '|' + r.lane)
    if (!(o > 0)) continue
    const p = calTable ? cal(calTable, r.p, o) : r.p
    if (o < (1 / p) * S.MARGIN) continue
    bets++; sumP += p; sumEV += p * o
    if (r.y === 1) { hit++; ret += PAY.get(r.race_id + '|' + r.lane) ?? o * 100 }
    const mo = r.date.slice(0, 7)
    let a = per.get(mo); if (!a) { a = { b: 0, h: 0, g: 0 }; per.set(mo, a) }
    a.b++; if (r.y === 1) { a.h++; a.g += PAY.get(r.race_id + '|' + r.lane) ?? o * 100 }
  }
  const roi = ret / (bets * 100) * 100
  console.log(`【${name}】`)
  console.log(`  買った数    ${bets.toLocaleString()}本（1日 ${(bets / DAYS).toFixed(1)}本）`)
  console.log(`  的中率      ${(hit / bets * 100).toFixed(2)}%（${hit.toLocaleString()}本）`)
  console.log(`  平均払戻    ${(hit ? ret / hit : 0).toFixed(0)}円`)
  console.log(`  回収率      ${roi.toFixed(2)}%`)
  console.log(`  1日100円で  ${((ret - bets * 100) / DAYS).toFixed(0)}円/日`)
  console.log(`  理屈上の回収 ${(sumEV / bets * 100).toFixed(2)}%（校正後の確率×オッズの平均。実測がこれを大きく下回るなら校正が甘い）`)
  const ms = [...per].sort()
  console.log('  月ごと: ' + ms.map(([m, a]) => `${m.slice(5)} ${(a.g / (a.b * 100) * 100).toFixed(0)}%(${a.b}本)`).join(' '))
  console.log(`  プラスの月 ${ms.filter(([, a]) => a.g > a.b * 100).length}/${ms.length}\n`)
}
run('校正なし', null)
run('wi1由来の校正表（＝いま動いている形）', CAL_WI1)
run('pred(calib)由来の校正表（本来の作り）', CAL_PRD)
db.close()
