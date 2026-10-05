// 複勝（2着以内）の的中率と回収率を測る。
//
//   node --max-old-space-size=4096 scripts/fukusho-test.mjs
//
// ★競艇の複勝は「2着以内」。6艇で2枠ぶんなので、単勝よりずっと当たる。
//   そのぶんオッズが低いので、当たっても戻らないことが多い。
//   **的中率と回収率は別物**（[[boatrace-hitrate-vs-roi]]）。
//
// ★回収率は確定払戻（payouts の fukusho）で出す。
//   締切前の複勝オッズ（odds_tan.fukusho_lo/hi）は幅でしか出ないので、
//   「締切前に実行できるか」は別に見る必要がある。ここでは
//   **確定払戻の数字であることを必ず明記する**（[[boatrace-claim-gate]]）。
//
// ★前半で見て、後半で確かめる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

console.log('材料を読み込んでいます…')

// 確定払戻（複勝）
const pay = new Map()   // race_id|lane -> 円
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='fukusho'`).all())
  pay.set(r.race_id + '|' + r.combo, r.amount)

// 歩進検証の1着確率（学習に使っていない期間の予測）
const P = new Map()     // race_id -> [{lane,p}]
for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1 ORDER BY race_id, lane`).all()) {
  if (!P.has(r.race_id)) P.set(r.race_id, [])
  P.get(r.race_id).push({ lane: r.lane, p: r.p })
}

// 着順
const rank = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num IS NOT NULL`).all()) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}

// 締切前の複勝オッズ（幅）。実行できるかを見るため
const pre = new Map()   // race_id|lane -> [lo,hi]
for (const r of db.prepare(`SELECT race_id, lane, fukusho_lo, fukusho_hi FROM odds_tan
  WHERE fukusho_lo IS NOT NULL`).all())
  pre.set(r.race_id + '|' + r.lane, [r.fukusho_lo, r.fukusho_hi])
db.close()

const ids = [...P.keys()].filter((id) => rank.has(id) && [...P.get(id)].some((x) => pay.has(id + '|' + x.lane)))
  .sort()
console.log(`${ids.length.toLocaleString()}レース（${ids[0].slice(0, 8)}〜${ids.at(-1).slice(0, 8)}）`)
const CUT = ids[Math.floor(ids.length / 2)].slice(0, 8)
const half = (id) => (id.slice(0, 8) < CUT ? 0 : 1)
console.log(`前半 〜${CUT} ／ 後半 ${CUT}〜　（複勝＝2着以内）`)
console.log('')

const f1 = (v) => (v == null ? '  ―  ' : (v.toFixed(1) + '%').padStart(7))

/** pick(id, boats) が返した艇を100円ずつ買う。戻りは確定払戻。 */
function run(title, note, pick) {
  const box = [[0, 0, 0, 0], [0, 0, 0, 0]]   // [半期][点数, 的中, 投資, 払戻]
  for (const id of ids) {
    const bs = [...P.get(id)].sort((a, b) => b.p - a.p)
    const chosen = pick(bs, id); if (!chosen?.length) continue
    const h = half(id)
    for (const b of chosen) {
      const amt = pay.get(id + '|' + b.lane)
      box[h][0]++; box[h][2] += 100
      if ((rank.get(id).get(b.lane) ?? 9) <= 2) { box[h][1]++; box[h][3] += amt ?? 0 }
    }
  }
  console.log('■ ' + title)
  if (note) console.log('  ' + note)
  console.log('        買った数        的中率     回収率（確定払戻）')
  for (const h of [0, 1]) {
    const [n, hit, spent, ret] = box[h]
    if (!n) { console.log(`  ${h ? '後半' : '前半'}  （該当なし）`); continue }
    console.log(`  ${h ? '後半' : '前半'}  ${String(n.toLocaleString()).padStart(8)}点  ` +
      `${f1(hit / n * 100)}  ${f1(ret / spent * 100)}`)
  }
  console.log('')
  return box
}

run('① 1号艇の複勝（いつでも買う）', '基準。ここを超えないと話にならない',
  (bs) => bs.filter((b) => b.lane === 1))

run('② AIの本命（1着確率1位）の複勝', 'オッズを使わない＝朝に決まる',
  (bs) => [bs[0]])

for (const th of [0.5, 0.6, 0.7, 0.8]) {
  run(`③ 本命の1着確率が${(th * 100).toFixed(0)}%以上のときだけ`, '',
    (bs) => (bs[0].p >= th ? [bs[0]] : []))
}

run('④ 本命の1着確率が40%未満（荒れそう）のとき', '当たりにくいぶん、戻りは大きいか',
  (bs) => (bs[0].p < 0.4 ? [bs[0]] : []))

run('⑤ 2番手の複勝', '本命でなく対抗を買う',
  (bs) => [bs[1]])

run('⑥ 本命＋2番手の2点', '2着以内は2枠しかないので、2点で両取りを狙う',
  (bs) => [bs[0], bs[1]])

// ---------- 必要倍率で絞る ----------
// ⚠⚠ ここから下は**全部が確定オッズ前提**＝実際には買えない数字。
//   `odds_tan` は odds-backfill.mjs が入れた「過去の**確定**オッズ」で、
//   fukusho_lo/hi はレース後に出る複勝の確定表示（1.7-2.6 のような幅）。
//   **締切前に見える値段ではない。**
//   締切前の複勝オッズは odds_snap にも無い（2026-09-23〜・3連単/3連複/2連単/2連複だけ）。
//   つまり「必要倍率で絞ると100%を超える」は、単勝でやったのと同じ幻。
//   同じ誤りを**4回目**にしないため、画面には必ずこの断りを出す。
//   （[[boatrace-claim-gate]]・[[boatrace-tansho-not-executable]]）
console.log('')
console.log('【必要倍率で絞る】')
console.log('  ⚠ 下の回収率は**確定オッズ前提**です。締切前にこの値段で買えた保証はありません。')
console.log('    複勝の締切前オッズは手元にありません（odds_tan は確定・odds_snap に複勝は無い）。')

// 前半で「1着確率の帯 → 実際に2着以内に入った率」を作る（後半は触らない）
const band = (p) => Math.min(9, Math.floor(p * 10))
const tbl = Array.from({ length: 10 }, () => [0, 0])
for (const id of ids) {
  if (half(id) !== 0) continue
  const b = [...P.get(id)].sort((x, y) => y.p - x.p)[0]
  const t = tbl[band(b.p)]
  t[0]++; if ((rank.get(id).get(b.lane) ?? 9) <= 2) t[1]++
}
const rate2 = tbl.map(([n, h]) => (n >= 200 ? h / n : null))
console.log('  前半で作った「1着確率の帯 → 2着以内率」：')
console.log('   ' + rate2.map((r, i) => r == null ? null : `${i * 10}%台→${(r * 100).toFixed(0)}%`).filter(Boolean).join(' '))

console.log('')
console.log('  余裕   買った数   的中率   回収率（確定オッズ前提・実行不能）')
for (const margin of [1.0, 1.1, 1.2, 1.3, 1.5]) {
  let n = 0, hit = 0, spent = 0, retFix = 0
  for (const id of ids) {
    if (half(id) !== 1) continue              // 後半だけで試す
    const b = [...P.get(id)].sort((x, y) => y.p - x.p)[0]
    const r2 = rate2[band(b.p)]; if (!r2) continue
    const pr = pre.get(id + '|' + b.lane); if (!pr) continue
    if (pr[0] < 1 / r2 * margin) continue     // 確定の下限が必要倍率に届かない
    n++; spent += 100
    if ((rank.get(id).get(b.lane) ?? 9) <= 2) { hit++; retFix += pay.get(id + '|' + b.lane) ?? 0 }
  }
  if (!n) { console.log(`  ×${margin.toFixed(1)}   該当なし`); continue }
  console.log(`  ×${margin.toFixed(1)}  ${String(n.toLocaleString()).padStart(8)}点  ` +
    `${f1(hit / n * 100)}  ${f1(retFix / spent * 100)}`)
}
console.log('')
console.log('  ★この数字は運用の根拠にしないこと。')
console.log('    締切前の複勝オッズを貯め始めない限り、実行できるかは分かりません。')
console.log('    単勝では同じ条件が「表示20〜50倍→確定0.688倍」で崩れました。')
