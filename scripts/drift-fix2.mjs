// 締切前オッズを「オッズ帯ごとの実測倍率」で補正してから判定する。
//   node --max-old-space-size=8192 scripts/drift-fix2.mjs
//
// ★分かったこと（2026-08-31）
//   単勝は総取り式で、**払戻は締切後に決まる**。締切前の表示は目安でしかない。
//   締切0分前の6,486件で、表示が高いほど確定で崩れる：
//     0〜3倍 1.138 ／ 3〜8倍 1.026 ／ 8〜20倍 0.933 ／ 20〜50倍 0.688 ／ 50倍〜 0.395
//   締切間際は金が一気に入るので、それまで薄かった穴党の表示が圧縮される。
//   いまの判定は高オッズの艇を狙うので、これを丸ごと食らっていた。
//   実測：締切前判定 83.4%（確定オッズで判定できたなら 111.0%）。
//
// ★直し方
//   表示オッズをそのまま使わず、「その表示なら確定はいくらになりそうか」に直してから
//   必要倍率と比べる。倍率はオッズ帯ごとに実測から作る。
//     判定式: live * f(live) >= (1 ÷ 確率) × 余裕
//
// ⚠ 倍率の表を作った期間と、判定を試す期間が重なると出来過ぎになる。
//   前半で表を作り、後半で試す（時点を守る）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'
import { loadCalib, calibrate } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const OD = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  OD.set(r.race_id + '|' + r.lane, r.tansho)
const LIVE = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho, mins_before FROM odds_live
    WHERE tansho IS NOT NULL AND mins_before IS NOT NULL ORDER BY mins_before DESC`).iterate())
  LIVE.set(r.race_id + '|' + r.lane, r.tansho)
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
    WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.combo, r.amount)
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane FROM entries WHERE rank_num=1`).iterate())
  WIN.set(r.race_id, r.lane)
const CAL = loadCalib(db, 'wi1')

const rows = []
for (const f of readdirSync(join(ROOT, 'data')).filter((x) => /^predict-\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'))
  for (const r of (j.races ?? [])) {
    const win = WIN.get(r.race_id); if (win == null) continue
    for (const b of (r.first ?? [])) {
      const k = r.race_id + '|' + b.lane
      const fin = OD.get(k), lv = LIVE.get(k)
      if (!(fin > 0) || !lv) continue
      rows.push({ id: r.race_id, lane: b.lane, p: b.p, fin, live: lv,
        y: win === b.lane ? 1 : 0, day: r.race_id.slice(0, 8) })
    }
  }
}
const DAYS = [...new Set(rows.map((r) => r.day))].sort()
const cut = DAYS[Math.floor(DAYS.length / 2)]
const train = rows.filter((r) => r.day < cut)
const test = rows.filter((r) => r.day >= cut)
console.log(`表を作る期間 ${DAYS[0]}〜 ${train.length.toLocaleString()}本 / 試す期間 ${cut}〜 ${test.length.toLocaleString()}本\n`)

// オッズ帯ごとの「確定÷締切前」の中央値
const OB2 = [0, 2, 3, 5, 8, 12, 20, 35, 60, 9999]
const bin = (o) => { for (let i = 1; i < OB2.length; i++) if (o < OB2[i]) return i - 1; return OB2.length - 2 }
function table(src) {
  const M = new Map()
  for (const r of src) { const b = bin(r.live); let a = M.get(b); if (!a) { a = []; M.set(b, a) } a.push(r.fin / r.live) }
  const t = new Map()
  for (const [b, v] of M) { v.sort((x, y) => x - y); if (v.length >= 30) t.set(b, v[Math.floor(v.length / 2)]) }
  return t
}
const T = table(train)
console.log('【補正の倍率（前半から作成）】')
for (let i = 0; i < OB2.length - 1; i++) {
  if (!T.has(i)) continue
  console.log(`  ${String(OB2[i]).padStart(4)}〜${OB2[i + 1] > 9000 ? '   ' : String(OB2[i + 1]).padStart(3)}倍  ×${T.get(i).toFixed(3)}`)
}
const adj = (o) => o * (T.get(bin(o)) ?? 1)

function run(src, mode, th = 0, margin = S.MARGIN) {
  let n = 0, hit = 0, ret = 0
  const per = new Map()
  for (const r of src) {
    const shown = mode === 'fin' ? r.fin : r.live
    const use = mode === 'adj' ? adj(r.live) : shown
    const p = calibrate(CAL, r.p, use)
    if (p < th) continue
    if (use < (1 / p) * margin) continue
    n++
    const g = r.y === 1 ? (PAY.get(r.id + '|' + r.lane) ?? r.fin * 100) : 0
    if (r.y === 1) hit++
    ret += g
    let a = per.get(r.day); if (!a) { a = { n: 0, g: 0 }; per.set(r.day, a) }
    a.n++; a.g += g
  }
  return { n, hit, roi: n ? ret / (n * 100) * 100 : 0, pl: ret - n * 100,
    pos: [...per.values()].filter((a) => a.g > a.n * 100).length, days: per.size }
}
const line = (nm, a, d) => a.n ? `  ${nm.padEnd(26)} ${String(a.n).padStart(5)} ${(a.n / d).toFixed(1).padStart(6)} ` +
  `${(a.hit / a.n * 100).toFixed(2).padStart(7)}% ${a.roi.toFixed(1).padStart(7)}% ` +
  `${((a.pl > 0 ? '+' : '') + a.pl.toLocaleString()).padStart(9)} ${a.pos}/${a.days}` : ''

const td = new Set(test.map((r) => r.day)).size
console.log(`\n【試す期間（${td}日）で比べる】`)
console.log('  やり方                       本数   1日   的中率   回収率      損益  プラスの日')
console.log(line('いまの判定（表示のまま）', run(test, 'live'), td))
console.log(line('帯ごとに補正してから判定', run(test, 'adj'), td))
console.log(line('確定オッズで判定（幻）', run(test, 'fin'), td))
console.log('\n【補正あり × 余裕を変える】')
console.log('  やり方                       本数   1日   的中率   回収率      損益  プラスの日')
for (const m of [1.0, 1.3, 1.6, 2.0, 2.5]) {
  const l = line(`補正あり 余裕${m.toFixed(1)}`, run(test, 'adj', 0, m), td)
  if (l) console.log(l)
}
console.log(`\n⚠ 試す期間は${td}日しかない。ここでプラスでも結論にはならない。`)
db.close()
