// 8次元を同時に扱い、各次元が「他を考慮した上で」どれだけ効くかを測る。
//
//   node scripts/cross.mjs                    1コース1着を対象
//   node scripts/cross.mjs --target makuri     まくり系決着を対象
//
// ★なぜこれが要るか
//   これまでは1次元ずつ集計して「効く／効かない」を判断していた。
//   だが時間帯の29pt差が番組編成の言い換えだったように、
//   **単独で見た差は他の次元の影が映っているだけ**のことがある。
//   逆に、他を揃えて初めて出てくる効果もある（グレード×決まり手がそうだった）。
//
// ★方法：加法モデルの反復当てはめ（バックフィッティング）
//   結果をロジット（対数オッズ）で表し、
//     ロジット = 全体平均 + 場の効果 + グレードの効果 + コースの効果 + …
//   と分解する。各次元の効果を「他の次元を引いた残差」から推定し、
//   値が動かなくなるまで繰り返す。
//   各水準は標本が薄いほどゼロへ縮小する（階層ベイズと同じ考え方）。
//
//   最後に「その次元を外すと予測がどれだけ悪化するか」で寄与を測る。
//   単独の集計差ではなく、**他を全部入れた状態での上乗せ分**が出る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 180000')
const all = (s, ...p) => db.prepare(s).all(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const TARGET = flag('target', 'in1')
const SPLIT = '2026-02-18'

const waveB = (w) => (w == null ? 'na' : w <= 1 ? '0-1cm' : w <= 3 ? '2-3cm' : w <= 5 ? '4-5cm' : '6cm+')
const windB = (w) => (w == null ? 'na' : w <= 1 ? '0-1m' : w <= 3 ? '2-3m' : w <= 5 ? '4-5m' : '6m+')
const rnoB = (r) => (r <= 3 ? '1-3R' : r <= 6 ? '4-6R' : r <= 9 ? '7-9R' : '10-12R')
const hourB = (d) => (d ? d.slice(0, 2) + '時' : 'na')

console.log(`=== 8次元の同時分析  対象: ${TARGET === 'in1' ? '1コース艇が1着' : 'まくり系で決着'} ===\n`)

// ---------- データを読む ----------
const sql = TARGET === 'in1'
  ? `SELECT r.jcd, r.grade, r.wave, r.wind_speed ws, r.wind_dir wd, r.race_no rn, r.deadline dl,
       r.day_no, e.racer_id, e.motor_no,
       (CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) y,
       p.motor_top2 mt2, p.age, p.branch, p.weight, p.win_rate_loc wrl, p.top2_nat t2n,
       r.date
     FROM races r JOIN entries e ON e.race_id=r.race_id
     LEFT JOIN programs p ON p.race_id=e.race_id AND p.lane=e.lane
     WHERE e.course=1 AND e.rank_num IS NOT NULL`
  : `SELECT r.jcd, r.grade, r.wave, r.wind_speed ws, r.wind_dir wd, r.race_no rn, r.deadline dl,
       r.day_no, NULL racer_id, NULL motor_no,
       (CASE WHEN r.kimarite IN ('まくり','まくり差し') THEN 1 ELSE 0 END) y,
       NULL mt2, r.date
     FROM races r WHERE r.kimarite IS NOT NULL`

const rows = all(sql)
console.log(`全データ ${rows.length.toLocaleString()} 件（学習 ${SPLIT} 未満／検証 ${SPLIT} 以降）\n`)

// ---------- 次元の定義 ----------
const DIMS = [
  ['場', (r) => String(r.jcd)],
  ['グレード', (r) => r.grade ?? 'na'],
  ['波高', (r) => waveB(r.wave)],
  ['風速', (r) => windB(r.ws)],
  ['場×風向', (r) => `${r.jcd}|${r.wd ?? 'na'}`],
  ['レース番号', (r) => rnoB(r.rn)],
  ['時刻', (r) => hourB(r.dl)],
  ['日目', (r) => String(Math.min(r.day_no ?? 1, 7))],
]
// 場の所在県。地元かどうかを判定するために持つ
const VENUE_PREF = {1:'群馬',2:'埼玉',3:'東京',4:'東京',5:'東京',6:'静岡',7:'愛知',8:'愛知',
  9:'三重',10:'福井',11:'滋賀',12:'大阪',13:'兵庫',14:'徳島',15:'香川',16:'岡山',
  17:'広島',18:'山口',19:'山口',20:'福岡',21:'福岡',22:'福岡',23:'佐賀',24:'長崎'}

if (TARGET === 'in1') {
  DIMS.push(['選手', (r) => String(r.racer_id ?? 'na')])
  DIMS.push(['モーター2連率', (r) => (r.mt2 == null ? 'na' : `${Math.floor(r.mt2 / 5) * 5}%台`)])
  // --- ここから人の側 ---
  DIMS.push(['地元か', (r) => (r.branch == null ? 'na' : r.branch === VENUE_PREF[r.jcd] ? '地元' : '他所')])
  DIMS.push(['支部', (r) => r.branch ?? 'na'])
  DIMS.push(['年齢', (r) => (r.age == null ? 'na' : `${Math.floor(r.age / 5) * 5}代前後`)])
  DIMS.push(['体重', (r) => (r.weight == null ? 'na' : `${r.weight}kg`)])
  DIMS.push(['当地勝率', (r) => (r.wrl == null ? 'na' : `${Math.floor(r.wrl)}点台`)])
  DIMS.push(['全国2連率', (r) => (r.t2n == null ? 'na' : `${Math.floor(r.t2n / 10) * 10}%台`)])
}

const train = rows.filter((r) => r.date < SPLIT)
const test = rows.filter((r) => r.date >= SPLIT)
const gy = train.reduce((a, b) => a + b.y, 0) / train.length
const logit = (p) => Math.log(p / (1 - p))
const sigmoid = (z) => 1 / (1 + Math.exp(-z))
const g0 = logit(gy)
console.log(`全体平均 ${(gy * 100).toFixed(2)}%\n`)

// ---------- バックフィッティング ----------
// 各次元の各水準に「上乗せ分（ロジット）」を持たせ、他を固定して順に更新する
const K_SH = 40 // 縮小の強さ（標本がこれ未満なら効果はほぼゼロへ）
const eff = DIMS.map(() => new Map())
const keyCache = DIMS.map((d) => train.map((r) => d[1](r)))
const testKey = DIMS.map((d) => test.map((r) => d[1](r)))

const predict = (i, skip = -1) => {
  let z = g0
  for (let d = 0; d < DIMS.length; d++) {
    if (d === skip) continue
    z += eff[d].get(keyCache[d][i]) ?? 0
  }
  return z
}

console.log('反復中...')
for (let iter = 1; iter <= 12; iter++) {
  for (let d = 0; d < DIMS.length; d++) {
    // 他の次元で説明した残り（作業残差）を集める
    const acc = new Map()
    for (let i = 0; i < train.length; i++) {
      const z = predict(i, d)
      const p = sigmoid(z)
      const k = keyCache[d][i]
      if (!acc.has(k)) acc.set(k, { num: 0, den: 0 })
      const a = acc.get(k)
      a.num += train[i].y - p          // 観測と予測のズレ
      a.den += p * (1 - p)             // ロジスティック回帰の重み
    }
    for (const [k, a] of acc) eff[d].set(k, a.num / (a.den + K_SH * 0.25))
  }
  if (iter % 4 === 0) {
    let ll = 0
    for (let i = 0; i < train.length; i++) {
      const p = Math.min(Math.max(sigmoid(predict(i)), 1e-6), 1 - 1e-6)
      ll += train[i].y ? Math.log(p) : Math.log(1 - p)
    }
    console.log(`  ${String(iter).padStart(2)}回目  学習の対数尤度/件 ${(ll / train.length).toFixed(5)}`)
  }
}

// ---------- 検証データでの寄与を測る ----------
const testLL = (skip = -1) => {
  let ll = 0
  for (let i = 0; i < test.length; i++) {
    let z = g0
    for (let d = 0; d < DIMS.length; d++) {
      if (d === skip) continue
      z += eff[d].get(testKey[d][i]) ?? 0
    }
    const p = Math.min(Math.max(sigmoid(z), 1e-6), 1 - 1e-6)
    ll += test[i].y ? Math.log(p) : Math.log(1 - p)
  }
  return ll / test.length
}
const base0 = (() => {
  let ll = 0
  for (const r of test) ll += r.y ? Math.log(gy) : Math.log(1 - gy)
  return ll / test.length
})()
const full = testLL()

console.log(`\n=== 検証データ ${test.length.toLocaleString()} 件での結果 ===`)
console.log(`  何も使わない（全体平均のみ）  ${base0.toFixed(5)}`)
console.log(`  8次元すべて使う              ${full.toFixed(5)}   改善 ${(full - base0).toFixed(5)}`)

console.log(`\n=== 各次元の寄与（その次元だけ外した時の悪化幅）===`)
console.log('次元            水準数   外すと悪化   全体改善に占める割合')
const contrib = []
for (let d = 0; d < DIMS.length; d++) {
  const without = testLL(d)
  const drop = full - without
  contrib.push({ name: DIMS[d][0], levels: eff[d].size, drop })
}
const totalDrop = contrib.reduce((a, b) => a + Math.max(b.drop, 0), 0)
for (const c of contrib.sort((a, b) => b.drop - a.drop)) {
  const share = totalDrop > 0 ? (Math.max(c.drop, 0) / totalDrop) * 100 : 0
  console.log(`${c.name.padEnd(14, '　')}${String(c.levels).padStart(5)}   ${c.drop.toFixed(5).padStart(9)}   ${share.toFixed(1).padStart(5)}%${c.drop <= 0 ? '  ← 外した方が良い' : ''}`)
}
console.log('\n  ※「外すと悪化」が大きいほど、他の7次元では代替できない固有の情報を持っている。')
console.log('  ※ 値が負なら、その次元は雑音を持ち込んでいる。')

// ---------- 効果の中身を見る ----------
console.log(`\n=== 効果の大きい水準（上位・下位）===`)
for (let d = 0; d < DIMS.length; d++) {
  if (eff[d].size > 60) continue // 選手など水準が多すぎるものは別途
  const e = [...eff[d]].filter(([k]) => k !== 'na').sort((a, b) => b[1] - a[1])
  if (e.length < 2) continue
  const fmt = ([k, v]) => `${k}:${v >= 0 ? '+' : ''}${(sigmoid(g0 + v) * 100 - gy * 100).toFixed(1)}pt`
  console.log(`  ${DIMS[d][0].padEnd(12, '　')} 高← ${e.slice(0, 3).map(fmt).join(' ')}  ／  低← ${e.slice(-3).map(fmt).join(' ')}`)
}
db.close()
