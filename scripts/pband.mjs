// 買った買い目を「1着確率の帯」で分けて、どの帯が効いているか測る。
//   node --max-old-space-size=8192 scripts/pband.mjs
//
// ★何を知りたいか
//   いまの判定（余裕1.3・全6艇・校正あり）は、校正後の確率が5〜20%の艇をよく買う。
//   低い確率の艇を買うのをやめたほうがいいのか、それとも効いているのかを見る。
//
// ★2つの土俵で測る
//   pred(split=test)  … 本番モデルそのもの。ただし4ヶ月しかない。
//   wi1               … 歩進検証。10ヶ月あるので「月ごとに安定か」を見るのはこちら。
//   [[boatrace-model-vs-walk]] のとおり、確率の鋭さが違うので帯の切り方は
//   それぞれの側で意味が変わる。両方出して、結論が一致するかを見る。
//
// ★足切りの判断は「その帯を外したら全体がどうなるか」で見る
//   帯ごとの回収率だけ見ると、本数の少ない帯のブレに引きずられる。
//   「p >= X の艇だけ買う」に変えたときの全体の数字を並べる。
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
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)

/** 校正表（判定で使っているのと同じ作り。元は wi1） */
function buildCalib(K = 300) {
  const M = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, p, y FROM wi1`).iterate()) {
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
const CAL = buildCalib()
const cal = (p, o) => { const x = CAL.get(binOf(PB, p) + '|' + binOf(OB, o)); return x ? Math.min(0.999, Math.max(1e-6, p * x)) : p }

/** いまの判定で買う分だけ取り出す */
function pick(rows, monthOf) {
  const out = []
  for (const r of rows) {
    const o = OD.get(r.race_id + '|' + r.lane)
    if (!(o > 0)) continue
    const p = cal(r.p, o)
    if (o < (1 / p) * S.MARGIN) continue
    out.push({ p, praw: r.p, o, y: r.y, mo: monthOf(r),
      ret: r.y === 1 ? (PAY.get(r.race_id + '|' + r.lane) ?? o * 100) : 0 })
  }
  return out
}

const BANDS = [0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.01]
const lab = (i) => `${(BANDS[i] * 100).toFixed(0)}〜${BANDS[i + 1] > 1 ? '100' : (BANDS[i + 1] * 100).toFixed(0)}%`

function report(name, bets, days) {
  console.log(`\n══ ${name} ══`)
  console.log(`買った数 ${bets.length.toLocaleString()}本（1日 ${(bets.length / days).toFixed(1)}本）\n`)
  console.log('【校正後の1着確率の帯ごと】')
  console.log('  帯          本数   1日   的中率   平均払戻  回収率     損益     全体に占める利益')
  const tot = bets.reduce((s, b) => s + b.ret - 100, 0)
  for (let i = 0; i < BANDS.length - 1; i++) {
    const a = bets.filter((b) => b.p >= BANDS[i] && b.p < BANDS[i + 1])
    if (!a.length) continue
    const hit = a.filter((b) => b.y === 1).length
    const ret = a.reduce((s, b) => s + b.ret, 0)
    const pl = ret - a.length * 100
    console.log(`  ${lab(i).padEnd(9)} ${String(a.length).padStart(6)} ${(a.length / days).toFixed(1).padStart(6)} ` +
      `${(hit / a.length * 100).toFixed(2).padStart(7)}% ${(hit ? ret / hit : 0).toFixed(0).padStart(8)}円 ` +
      `${(ret / (a.length * 100) * 100).toFixed(1).padStart(7)}% ${(pl > 0 ? '+' : '') + pl.toLocaleString()}`.padStart(10) +
      `${(pl / tot * 100).toFixed(1).padStart(11)}%`)
  }
  console.log(`  ${'合計'.padEnd(8)} ${String(bets.length).padStart(6)} ${(bets.length / days).toFixed(1).padStart(6)} ` +
    `${(bets.filter((b) => b.y === 1).length / bets.length * 100).toFixed(2).padStart(7)}% ` +
    `${''.padStart(9)} ${(bets.reduce((s, b) => s + b.ret, 0) / (bets.length * 100) * 100).toFixed(1).padStart(7)}% ` +
    `${('+' + tot.toLocaleString()).padStart(10)}`)

  console.log('\n【「確率がX以上の艇だけ買う」に変えたら】')
  console.log('  足切り     本数   1日   的中率  回収率      損益  1日あたり  プラスの月')
  for (const th of [0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50]) {
    const a = bets.filter((b) => b.p >= th)
    if (!a.length) continue
    const hit = a.filter((b) => b.y === 1).length
    const ret = a.reduce((s, b) => s + b.ret, 0)
    const pl = ret - a.length * 100
    const per = new Map()
    for (const b of a) { let x = per.get(b.mo); if (!x) { x = { n: 0, g: 0 }; per.set(b.mo, x) } x.n++; x.g += b.ret }
    const pos = [...per.values()].filter((x) => x.g > x.n * 100).length
    console.log(`  ${(th * 100).toFixed(0).padStart(3)}%以上 ${String(a.length).padStart(7)} ${(a.length / days).toFixed(1).padStart(6)} ` +
      `${(hit / a.length * 100).toFixed(2).padStart(7)}% ${(ret / (a.length * 100) * 100).toFixed(1).padStart(7)}% ` +
      `${((pl > 0 ? '+' : '') + pl.toLocaleString()).padStart(10)} ${(pl / days).toFixed(0).padStart(8)}円 ` +
      `${String(pos)}/${per.size}`.padStart(9))
  }
}

// ---------- 本番モデル（split=test） ----------
{
  const rows = db.prepare(`SELECT race_id, lane, p, y, date FROM pred WHERE split='test'`).all()
  const days = new Set(rows.map((r) => r.date)).size
  report(`本番モデル pred(split=test)　${days}日`, pick(rows, (r) => r.date.slice(0, 7)), days)
}
// ---------- 歩進検証（10ヶ月） ----------
{
  const rows = db.prepare(`SELECT race_id, lane, p, y, month FROM wi1`).all()
  const days = new Set(rows.map((r) => r.race_id.slice(0, 8))).size
  report(`歩進検証 wi1　${days}日`, pick(rows, (r) => r.month), days)
}
db.close()
