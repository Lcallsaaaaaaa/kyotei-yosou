// 朝に「どのレースのどの艇を、オッズいくら以上で買うか」の一覧を作る。
//
//   node scripts/watchlist.mjs --date 2026-08-31
//   node scripts/watchlist.mjs --date 2026-08-31 --margin 1.3
//
// ★考え方
//   買う判定は「必要倍率 =（1 ÷ 確率）× 余裕　オッズがそれ以上なら買う」。
//   朝の時点でオッズは分からないが、**必要倍率はモデルの確率だけで決まる**ので先に出せる。
//   締切前にオッズを見て、必要倍率を超えていれば買う。
//
// ★確率は校正して使う
//   モデルは自信過剰（0.8と言って実際71.5%）。そのままだと必要倍率が低く出て買いすぎる。
//   確率帯 × オッズ帯 の升目で、過去の実績に引き直す。
//   ⚠ オッズ帯が要るので、必要倍率は「そのオッズ帯に入る前提」で解く。
//     オッズ帯ごとに校正後の確率を出し、必要倍率がその帯に収まるものを採る。
//
// ★出力
//   data/watch-YYYY-MM-DD.json … status.mjs の /asa が読む
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DATE = flag('date') || new Date().toISOString().slice(0, 10)
const CAL_TABLE = flag('cal', 'wi1')

// ---------- 校正表を作る（過去の実績から） ----------
const PB = [0, 0.02, 0.04, 0.07, 0.10, 0.15, 0.20, 0.27, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1.01]
const OB = [0, 1.5, 2.2, 3.2, 5, 8, 15, 30, 9999]
const bi = (B, v) => { for (let i = 1; i < B.length; i++) if (v < B[i]) return i - 1; return B.length - 2 }
const cal = (() => {
  const OD = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
    OD.set(r.race_id + '|' + r.lane, r.tansho)
  const M = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${CAL_TABLE}`).iterate()) {
    const od = OD.get(r.race_id + '|' + r.lane)
    if (!(od > 0)) continue
    const k = bi(PB, r.p) + '|' + bi(OB, od)
    let a = M.get(k); if (!a) { a = { n: 0, h: 0, sp: 0 }; M.set(k, a) }
    a.n++; a.h += r.y; a.sp += r.p
  }
  const out = new Map()
  const K = 300
  for (const [k, a] of M) {
    const obs = a.h / a.n, said = a.sp / a.n
    const w = a.n / (a.n + K)
    out.set(k, (w * obs + (1 - w) * said) / Math.max(said, 1e-9))
  }
  return out
})()
console.log(`校正表 ${cal.size}升（${CAL_TABLE}から作成）`)

/**
 * 必要倍率を解く。
 * オッズ帯ごとに校正後の確率が変わるので、帯を順に見て
 * 「その帯に入るオッズで、必要倍率を満たす一番低い値」を探す。
 */
function requiredOdds(pRaw, margin) {
  for (let b = 0; b < OB.length - 1; b++) {
    const c = cal.get(bi(PB, pRaw) + '|' + b)
    const p = c ? Math.min(0.999, Math.max(1e-6, pRaw * c)) : pRaw
    const need = (1 / p) * margin
    const lo = OB[b], hi = OB[b + 1]
    // その帯の中に必要倍率が収まるなら、それが答え
    if (need >= lo && need < hi) return { odds: need, p }
    // 帯の下限より必要倍率が低いなら、その帯の下限で買える
    if (need < lo) return { odds: lo, p }
  }
  return null   // どの帯でも成立しない＝実質買えない
}

// ---------- 当日の予想を読む ----------
const f = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(f)) { console.error(`${f} がありません。先に predict.mjs（--trio --json --out）を走らせること`); process.exit(1) }
const j = JSON.parse(readFileSync(f, 'utf8'))
// 締切時刻。当日は races にまだ入っていないので、公式から取り直す。
//   （races は競走成績が出てから作られるので、朝の時点では空）
const DL = new Map()
for (const r of db.prepare(`SELECT race_id, deadline FROM races WHERE date=?`).all(DATE))
  DL.set(r.race_id, r.deadline)
if (!DL.size) {
  const S = await import('./strategy.mjs')
  const jcds = [...new Set((j.races ?? []).map((r) => r.jcd))]
  const M = await S.deadlines(DATE.replace(/-/g, ''), jcds)
  for (const r of (j.races ?? [])) {
    const dl = M.get(r.jcd)?.[r.race_no - 1] ?? null
    if (dl) DL.set(r.race_id, dl)
  }
  console.log(`締切時刻を公式から取得 ${DL.size}レース`)
}

const MARGINS = [1.0, 1.3, 1.5]
const races = []
for (const r of (j.races ?? [])) {
  const boats = []
  for (const b of (r.first ?? [])) {
    const need = {}
    for (const m of MARGINS) {
      const x = requiredOdds(b.p, m)
      need[m] = x ? Math.round(x.odds * 10) / 10 : null
    }
    const c = requiredOdds(b.p, 1.0)
    boats.push({ lane: b.lane, name: b.name, p: b.p, pc: c ? c.p : b.p, need })
  }
  boats.sort((a, b) => b.p - a.p)
  races.push({ race_id: r.race_id, venue: r.venue, race_no: r.race_no,
    deadline: DL.get(r.race_id) ?? null, grade: r.grade, boats,
    trio: (r.sanrentan ?? []).slice(0, 3), trioBox: (r.sanrenpuku ?? []).slice(0, 3) })
}
races.sort((a, b) => String(a.deadline ?? '99:99').localeCompare(String(b.deadline ?? '99:99')))
const out = { date: DATE, generatedAt: new Date().toISOString(), margins: MARGINS, races }
const OUT = join(ROOT, 'data', `watch-${DATE}.json`)
writeFileSync(OUT, JSON.stringify(out))
console.log(`${DATE}　${races.length}レース → ${OUT}`)
// 目安を表示
for (const m of MARGINS) {
  const n = races.reduce((a, r) => a + r.boats.filter((b) => b.need[m] != null && b.need[m] <= 30).length, 0)
  console.log(`  余裕${m.toFixed(1)}：見張る艇 ${n}本`)
}
db.close()
