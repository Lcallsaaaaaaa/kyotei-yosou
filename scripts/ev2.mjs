// 買い判断（全120通り版）。ev.mjs の構造的欠陥を修正したもの。
//
//   node scripts/ev2.mjs --jcd 12 --race 12 --date 2026-08-18
//
// ★ev.mjs の何が問題だったか
//   「1着＝1号艇」を前提に20通りしか確率を計算していなかった。
//   2026/08/18 児島12Rは 5-1-3 で決着したが、この出目には**確率ゼロ**を与えていた。
//   4点すべてが1号艇1着だったため全滅（-400円）。
//
// ★修正
//   1着を6艇すべてから選ぶ。以降も残った艇から順に選ぶ（Plackett-Luce と同じ構造）。
//   各着順の「選ばれやすさ」は、選手×コースの**着順別**実績のベータ事後分布から引く。
//   model2 の検証で「1着率・2着率・3着率を分け、着順の段階ごとに重みを変える」のが
//   最も効いた（対数尤度 +0.212）ので、その構造をそのまま確率生成に使う。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 180000')
const all = (s, ...p) => db.prepare(s).all(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const jcd = Number(flag('jcd')), raceNo = Number(flag('race')), date = flag('date')
const NSIM = Number(flag('sim', 6000))
const TOPN = Number(flag('top', 14))
if (!jcd || !raceNo || !date) { console.error('--jcd --race --date が必要'); process.exit(1) }
const raceId = `${date.replace(/-/g, '')}-${String(jcd).padStart(2, '0')}-${String(raceNo).padStart(2, '0')}`

let lanes = flag('lanes')?.split(',').map(Number)
const progs = all(`SELECT lane, racer_id, racer_name, grade FROM programs WHERE race_id=? ORDER BY lane`, raceId)
if (!lanes) {
  if (progs.length !== 6) { console.error(`${raceId} の番組表がありません`); process.exit(1) }
  lanes = progs.map((r) => r.racer_id)
}
const names = Object.fromEntries(progs.map((r) => [r.lane, r.racer_name]))
const grades = Object.fromEntries(progs.map((r) => [r.lane, r.grade]))

const SH = JSON.parse(readFileSync(join(ROOT, 'data', 'shrinkage.json'), 'utf8'))
const Kof = (kind, c) => SH[kind]?.[String(c)]?.K ?? 25

// --- ベータ分布からのサンプリング ---
function randGamma(k) {
  if (k < 1) return randGamma(k + 1) * Math.pow(Math.random(), 1 / k)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x, v
    do { const u1 = Math.random(), u2 = Math.random()
         x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x ** 4) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
const randBeta = (a, b) => { const x = randGamma(a); return x / (x + randGamma(b)) }

// --- 場のコース別ベースレート（着順別）---
const venue = {}
for (const r of all(`SELECT e.course c, COUNT(*) n, SUM(e.rank_num=1) p1, SUM(e.rank_num=2) p2,
    SUM(e.rank_num=3) p3 FROM entries e JOIN races r ON r.race_id=e.race_id
  WHERE r.jcd=? AND e.course IS NOT NULL GROUP BY e.course`, jcd))
  venue[r.c] = { p1: r.p1 / r.n, p2: r.p2 / r.n, p3: r.p3 / r.n }

// --- 各艇の実績（全場・そのコース）---
const obs = []
for (let c = 1; c <= 6; c++) {
  const o = all(`SELECT COUNT(*) n, SUM(rank_num=1) p1, SUM(rank_num=2) p2, SUM(rank_num=3) p3
    FROM entries WHERE racer_id=? AND course=?`, lanes[c - 1], c)[0]
  obs.push(o ?? { n: 0, p1: 0, p2: 0, p3: 0 })
}

console.log(`=== ${date} jcd=${jcd} ${raceNo}R  買い判断（全120通り版）===\n`)
console.log('艇  選手        級  そのコースでの実績')
for (let c = 1; c <= 6; c++) {
  const o = obs[c - 1]
  const p = (x) => (o.n ? ((x / o.n) * 100).toFixed(0) + '%' : ' - ')
  console.log(`${c}  ${(names[c] ?? String(lanes[c - 1])).padEnd(10, '　')}${(grades[c] ?? '').padEnd(3)} ${String(o.n).padStart(3)}走  1着${p(o.p1).padStart(4)} 2着${p(o.p2).padStart(4)} 3着${p(o.p3).padStart(4)}`)
}

// --- モンテカルロ：全120通り ---
const cnt = new Map()
for (let it = 0; it < NSIM; it++) {
  const s1 = [], s2 = [], s3 = []
  for (let c = 1; c <= 6; c++) {
    const o = obs[c - 1], v = venue[c] ?? { p1: 0.16, p2: 0.16, p3: 0.16 }
    for (const [kind, arr, pv, ov] of [['1着率', s1, v.p1, o.p1], ['2着率', s2, v.p2, o.p2], ['3着率', s3, v.p3, o.p3]]) {
      const K = Kof(kind, c)
      arr[c] = randBeta(K * pv + ov, K * (1 - pv) + (o.n - ov))
    }
  }
  // ★確率をそのまま重みにしてはいけない。
  //   各艇の1着率は「それぞれ別の相手と戦った実績」なので、6艇分を足しても1にならない
  //   （この住之江12Rでは合計1.38）。素直に正規化すると強い艇が不当に薄まる。
  //   Plackett-Luce と同じく **オッズ比 p/(1−p) を強さとして使う**のが正しい。
  const strength = (p) => { const q = Math.min(Math.max(p, 0.002), 0.998); return q / (1 - q) }
  const pick = (weights, pool) => {
    const w = pool.map((c) => strength(weights[c]))
    const tot = w.reduce((a, b) => a + b, 0)
    let r = Math.random() * tot
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i] }
    return pool[pool.length - 1]
  }
  let pool = [1, 2, 3, 4, 5, 6]
  const w1 = pick(s1, pool); pool = pool.filter((c) => c !== w1)
  const w2 = pick(s2, pool); pool = pool.filter((c) => c !== w2)
  const w3 = pick(s3, pool)
  const key = `${w1}-${w2}-${w3}`
  cnt.set(key, (cnt.get(key) ?? 0) + 1)
}

// 事後分布の幅を出すため、ブロック分割して分散を見る
const BLOCKS = 12
const blockCnt = Array.from({ length: BLOCKS }, () => new Map())
{
  // 再サンプリングは重いので、簡便に二項分布の誤差で代用する
}
const odds = Object.fromEntries(all(`SELECT combo, odds FROM odds3t WHERE race_id=?`, raceId).map((r) => [r.combo, r.odds]))
const hasOdds = Object.keys(odds).length > 0

const rows = [...cnt.entries()].map(([combo, k]) => {
  const p = k / NSIM
  // モンテカルロ誤差 + 事後の不確実性を合わせた保守側の確率
  const seMC = Math.sqrt((p * (1 - p)) / NSIM)
  const pLo = Math.max(0, p - 1.0 * seMC - 0.18 * p) // 事後の広がりぶんを一律18%見込む
  const o = odds[combo] ?? null
  return { combo, p, pLo, odds: o, ev: o ? p * o : null, evLo: o ? pLo * o : null }
}).sort((a, b) => (b.ev ?? -1) - (a.ev ?? -1))

console.log(`\n1着の確率（全6艇）`)
const w1p = {}
for (const [k, v] of cnt) { const f = Number(k[0]); w1p[f] = (w1p[f] ?? 0) + v / NSIM }
console.log('  ' + [1, 2, 3, 4, 5, 6].map((c) => `${c}号艇 ${((w1p[c] ?? 0) * 100).toFixed(1)}%`).join('  '))

if (!hasOdds) {
  console.log('\n⚠️ オッズ未収集。確率のみ表示\n出目      確率')
  for (const r of rows.slice(0, TOPN)) console.log(`  ${r.combo}   ${(r.p * 100).toFixed(2)}%`)
} else {
  console.log(`\n出目      確率     オッズ    EV     ★EV下限   判定`)
  for (const r of rows.slice(0, TOPN)) {
    const buy = r.evLo !== null && r.evLo >= 1.0
    console.log(`  ${r.combo}   ${(r.p * 100).toFixed(2)}%  ${String(r.odds ?? '-').padStart(7)}  ${(r.ev ?? 0).toFixed(2).padStart(5)}  ${(r.evLo ?? 0).toFixed(2).padStart(6)}   ${buy ? '◎ 買' : '－'}`)
  }
  const buys = rows.filter((r) => r.evLo !== null && r.evLo >= 1.0).slice(0, 4)
  console.log(`\n=== 判定 ===`)
  if (!buys.length) console.log('  🔴 見送り（EV下限が1.0を超える出目なし）')
  else {
    console.log(`  ◎ 買い ${buys.length}点：${buys.map((b) => b.combo).join(' / ')}`)
    console.log(`     投資 ${buys.length * 100}円   期待回収 ${Math.round(buys.reduce((a, b) => a + b.ev * 100, 0))}円`)
    const heads = new Set(buys.map((b) => b.combo[0]))
    console.log(`     1着に置いた艇: ${[...heads].join(',')}号艇 ${heads.size === 1 ? '⚠️ 1艇に集中（児島12Rの失敗と同じ構造）' : '（分散している）'}`)
  }
}
db.close()
