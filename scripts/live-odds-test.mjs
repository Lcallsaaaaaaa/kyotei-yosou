// 「締切前に見えているオッズ」で選び、「確定払戻」で受け取る形で単勝・複勝を測る。
//
//   node --max-old-space-size=4096 scripts/live-odds-test.mjs
//   node --max-old-space-size=4096 scripts/live-odds-test.mjs --phase 20   20分前の値で選ぶ
//
// ★なぜこれが要るか（2026-10-06）
//   これまでの単勝・複勝の数字は、**選ぶのも受け取るのも確定オッズ**だった。
//   だから「表示20〜50倍→確定0.688倍」のような落差が隠れ、
//   回収148%や164%という幻が出た（[[boatrace-tansho-not-executable]]・
//   [[boatrace-claim-gate]]）。同じ誤りを3回やっている。
//
//   競艇はパリミュチュエル（売上を分け合う）なので、
//     ・買うときに見えるのは**その時点のオッズ**
//     ・実際に戻るのは**確定オッズ**
//   の2つがずれる。だから正しい測り方は1つしかない：
//
//     選ぶ   … odds_live（締切前に実際に見えていた値）
//     受取り … payouts（確定払戻）
//
//   これで100%を超える条件があるなら、それは**買える優位**。
//   無いなら、単勝・複勝はここで打ち切ってよい。
//
// ★材料
//   odds_live … odds-live.mjs が毎日集めている締切前の単勝・複勝（複勝は幅の下側）
//   wi1       … 歩進検証の1着確率（学習に使っていない期間の予測）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const PHASE = Number(flag('phase', 5))      // 締切の何分前までの値で選ぶか

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 30000')
console.log('材料を読み込んでいます…')

// ---------- 締切前に見えていたオッズ（締切にいちばん近い1回） ----------
const live = new Map()   // race_id|lane -> {tan, fuku, mins}
for (const r of db.prepare(`SELECT race_id, lane, mins_before, tansho, fukusho_lo FROM odds_live
  WHERE mins_before <= ? ORDER BY mins_before DESC`).all(PHASE)) {
  // mins_before の降順で入れるので、最後に入った（＝締切にいちばん近い）値が残る
  live.set(`${r.race_id}|${r.lane}`, { tan: r.tansho, fuku: r.fukusho_lo, mins: r.mins_before })
}

// ---------- 確定払戻 ----------
const payT = new Map(), payF = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
  WHERE bet_type IN ('tansho','fukusho')`).all())
  (r.bet_type === 'tansho' ? payT : payF).set(`${r.race_id}|${r.combo}`, r.amount)

// ---------- 1着確率 ----------
// ★pred（本番側）を優先し、足りないところだけ wi1（歩進検証）で埋める。
//   [[boatrace-model-vs-walk]]：閾値は本番側（pred）で出すこと。
//   ⚠ pred は 2026-09-05 で止まっている（09-06以降は pred3＝組み合わせだけ）。
//     そのせいで odds_live（08-20〜）と重なるのは2週間ほどしかない。
//     → 毎日1着確率を残す仕組みを scripts/winprob-daily.mjs で足した。
const P = new Map()
const src = new Map()
for (const [table, label] of [['wi1', '歩進'], ['pred', '本番']]) {
  for (const r of db.prepare(`SELECT race_id, lane, p FROM ${table} ORDER BY race_id, lane`).all()) {
    if (src.get(r.race_id) && src.get(r.race_id) !== label) P.delete(r.race_id)   // 本番側で上書き
    if (!P.has(r.race_id)) P.set(r.race_id, [])
    P.get(r.race_id).push({ lane: r.lane, p: r.p })
    src.set(r.race_id, label)
  }
}
// 日ごとの1着確率（winprob_daily）があればそれも足す
try {
  for (const r of db.prepare('SELECT race_id, lane, p FROM winprob_daily ORDER BY race_id, lane').all()) {
    if (src.get(r.race_id) !== '日次') { P.delete(r.race_id); src.set(r.race_id, '日次') }
    if (!P.has(r.race_id)) P.set(r.race_id, [])
    P.get(r.race_id).push({ lane: r.lane, p: r.p })
  }
} catch { /* まだ無い */ }

// ---------- 着順 ----------
const rank = new Map()
for (const r of db.prepare('SELECT race_id, lane, rank_num FROM entries WHERE rank_num IS NOT NULL').all()) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}
db.close()

// 締切前オッズと確率と着順がそろっているレースだけ
const ids = [...P.keys()].filter((id) => rank.has(id)
  && P.get(id).some((x) => live.get(`${id}|${x.lane}`)?.tan != null)).sort()

console.log('')
console.log(`■ 締切${PHASE}分前までに見えていたオッズで選ぶ`)
if (!ids.length) {
  console.log('  使えるレースがありません（odds_live と wi1 の期間が重なっていない）')
  process.exit(0)
}
console.log(`  ${ids.length.toLocaleString()}レース（${ids[0].slice(0, 8)}〜${ids.at(-1).slice(0, 8)}）`)
{
  const by = {}
  for (const id of ids) by[src.get(id) ?? '?'] = (by[src.get(id) ?? '?'] ?? 0) + 1
  console.log('  確率の出どころ：' + Object.entries(by).map(([k, v]) => `${k} ${v}レース`).join(' ／ '))
}
const CUT = ids[Math.floor(ids.length / 2)].slice(0, 8)
const half = (id) => (id.slice(0, 8) < CUT ? 0 : 1)
console.log(`  前半 〜${CUT} ／ 後半 ${CUT}〜`)
console.log('')

/** ある条件で買って、確定払戻で受け取る。前半・後半べつに集計する。 */
function run(pick, kind) {
  const pay = kind === 'tan' ? payT : payF
  const s = [0, 1].map(() => ({ bet: 0, hit: 0, ret: 0, races: 0 }))
  for (const id of ids) {
    const boats = P.get(id).slice().sort((a, b) => b.p - a.p)
      .map((x) => ({ ...x, ...(live.get(`${id}|${x.lane}`) ?? {}) }))
    const buy = pick(boats, id)
    if (!buy?.length) continue
    const h = s[half(id)]
    h.races++
    for (const b of buy) {
      h.bet += 100
      const amt = pay.get(`${id}|${b.lane}`)
      if (amt) { h.hit++; h.ret += amt }
    }
  }
  return s
}

const f = (v, w = 7) => (v == null ? '  ―  ' : (v.toFixed(1) + '%').padStart(w))
// ★少なすぎる本数で「100%超え」を名乗らせない（2026-10-06）
//   13レースで回収350%のような山は1本の高配当で出る。これを見つけものにすると
//   同じ誤りを4回目にすることになる（[[boatrace-claim-gate]]）。
const MIN = Number(flag('min', 100))
const line = (name, s) => {
  const roi = s.map((h) => (h.bet ? h.ret / h.bet * 100 : null))
  const hit = s.map((h) => (h.bet ? h.hit / (h.bet / 100) * 100 : null))
  const enough = s.every((h) => h.races >= MIN)
  const bothOver = enough && roi.every((r) => r != null && r >= 100)
  const thin = !enough && roi.every((r) => r != null && r >= 100)
  console.log(`  ${bothOver ? '★' : thin ? '△' : ' '} ${name.padEnd(34)}`
    + `${String(s[0].races).padStart(6)}/${String(s[1].races).padStart(6)}レース  `
    + `的中 ${f(hit[0])}/${f(hit[1])}  回収 ${f(roi[0])}/${f(roi[1])}`
    + (thin ? `  ← ${MIN}レース未満なので数えない` : ''))
  return bothOver
}

let winners = 0

// ---------- 単勝 ----------
console.log('【単勝】本命（確率1位）を1点。締切前に見えている倍率で絞る')
console.log(`    ${''.padEnd(34)}${'前半/後半'.padStart(20)}         前半/後半          前半/後半`)
for (const margin of [1.0, 1.1, 1.2, 1.3, 1.5]) {
  // 必要倍率 = 1÷確率×余裕。締切前に見えている倍率がこれ以上なら買う
  if (line(`必要倍率×${margin.toFixed(1)} 以上`, run((bs) => {
    const b = bs[0]
    if (b?.tan == null || !b.p) return null
    return b.tan >= (1 / b.p) * margin ? [b] : null
  }, 'tan'))) winners++
}
for (const [lo, hi] of [[1.5, 3], [3, 5], [5, 10], [10, 20], [20, 999]]) {
  if (line(`見えている倍率 ${lo}〜${hi === 999 ? '∞' : hi}倍`, run((bs) => {
    const b = bs[0]
    return b?.tan != null && b.tan >= lo && b.tan < hi ? [b] : null
  }, 'tan'))) winners++
}
console.log('')

// ---------- 複勝 ----------
console.log('【複勝】2着以内。見えているのは幅の下側（fukusho_lo）なので控えめな判断になる')
for (const margin of [1.0, 1.1, 1.2, 1.3, 1.5]) {
  // 2着以内に入る確率は、1着確率からは直接出ない。
  // ここでは「上位2艇ぶんの1着確率の和」を代わりに使う（粗い近似）。
  if (line(`必要倍率×${margin.toFixed(1)} 以上（本命）`, run((bs) => {
    const b = bs[0]
    if (b?.fuku == null || !b.p) return null
    const p2 = Math.min(0.95, b.p * 1.55)      // 1着確率→2着以内の目安（実測の比に合わせた）
    return b.fuku >= (1 / p2) * margin ? [b] : null
  }, 'fuku'))) winners++
}
for (const n of [1, 2]) {
  if (line(`上位${n}艇を無条件で`, run((bs) => bs.slice(0, n).filter((b) => b.fuku != null), 'fuku'))) winners++
}
for (const [lo, hi] of [[1.0, 1.3], [1.3, 1.6], [1.6, 2.0], [2.0, 3.0], [3.0, 999]]) {
  if (line(`見えている複勝 ${lo}〜${hi === 999 ? '∞' : hi}倍（本命）`, run((bs) => {
    const b = bs[0]
    return b?.fuku != null && b.fuku >= lo && b.fuku < hi ? [b] : null
  }, 'fuku'))) winners++
}
console.log('')

// ---------- まとめ ----------
console.log('■ まとめ')
console.log(`  前半・後半の両方が${MIN}レース以上あって、両方で回収100%以上：${winners}件`)
if (!winners) {
  console.log('  → いまの材料では**買えるオッズで100%を超える条件は無い**。')
  console.log('     これまでの148%や164%は、選ぶのも受け取るのも確定オッズにしていたための幻。')
} else {
  console.log('  → ★印の条件を scripts/claim.mjs に通してから名乗ること（[[boatrace-claim-gate]]）')
}
console.log('')
console.log('※ 選んだのは締切前に見えていた値・受け取ったのは確定払戻。実運用と同じ向き')
console.log('※ 複勝の「見えている値」は幅の下側。実際の払戻はこれ以上になることが多い（控えめな判断）')
console.log(`※ △印は本数が足りないだけ。${MIN}レースを超えたら見直す価値がある`)
console.log('※ 材料は毎日増える（winprob-daily.mjs が1着確率を・odds-live.mjs がオッズを残す）')
