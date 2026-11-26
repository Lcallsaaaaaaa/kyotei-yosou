// 締切前に見えているオッズが、確定までにどれだけ動くかを測る。
//
//   node scripts/odds-drift.mjs
//   node scripts/odds-drift.mjs --min 2.5     しきい値を変える
//
// ★なぜこれを測って公開するのか（2026-10-11）
//   英語圏のスポーツベッティング系で評価されている会社は、
//   「自分のところの予想がどう劣化するか」を自分で測って公開している。
//   このサイトの値打ちは当たることではなく**数字を正直に出すこと**なので、同じことをする。
//
// ★ただし競艇は「パリミュチュエル方式」なので、英語圏の話をそのまま持ってきてはいけない
//   ブックメーカー（固定オッズ）では、早く賭けた人は良いオッズで固定できる。
//   だから「公開から15分で回収率が6%落ちる」という測り方に意味がある。
//   **競艇は締切後に配当が決まる。いつ買っても払戻は同じ。**
//   だから劣化するのは「払戻」ではなく **「決めるときに見えている情報」** のほう。
//
//   つまり測るべきはこれ：
//     ①締切T分前に見えているオッズは、確定までにどれだけ動くか
//     ②「見えているオッズが◯倍以上なら買う」という決め方をしたとき、
//       実際にいくら戻るか（＝確定オッズで選べたら、という幻の数字と比べてどれだけ違うか）
//
// ★材料
//   odds_live … 締切20分前〜1分前のオッズ（2026-08〜10・約5,600レース）
//   odds_tan  … 確定オッズ（払戻と98.6%一致を確認済み）
//   payouts   … 確定払戻（的中判定に使う）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const MINS = (flag('mins', '20,15,10,5,3,2,1')).split(',').map(Number)
const THRESHOLDS = (flag('th', '1.5,2,2.5,3,4,5')).split(',').map(Number)

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 30000')

const f1 = (v) => (v == null ? '―' : v.toFixed(1))
const pct = (w, n) => (n ? (w / n) * 100 : null)
const med = (xs) => { if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b); const i = s.length >> 1
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2 }

const rowsAt = db.prepare(`
  SELECT ol.lane, ol.tansho shown, ot.tansho fin, p.combo win_combo, p.amount pay
  FROM odds_live ol
  JOIN odds_tan ot ON ot.race_id = ol.race_id AND ot.lane = ol.lane
  LEFT JOIN payouts p ON p.race_id = ol.race_id AND p.bet_type = 'tansho'
  WHERE ol.mins_before = ? AND ol.tansho IS NOT NULL AND ol.tansho > 0
    AND ot.tansho IS NOT NULL AND ot.tansho > 0`)

console.log('\n■ 材料')
{
  const s = db.prepare(`SELECT COUNT(DISTINCT ol.race_id) n, MIN(substr(ol.race_id,1,8)) a, MAX(substr(ol.race_id,1,8)) b
    FROM odds_live ol WHERE EXISTS (SELECT 1 FROM odds_tan ot WHERE ot.race_id = ol.race_id)`).get()
  console.log(`  締切前オッズと確定オッズが両方あるレース：${s.n.toLocaleString()}（${s.a}〜${s.b}）`)
  console.log('  ⚠ 競艇はパリミュチュエル方式。いつ買っても払戻は同じ。')
  console.log('    劣化するのは払戻ではなく「決めるときに見えている情報」のほう。')
}

// ---------- ① オッズはどれだけ動くか ----------
console.log('\n■ ① 締切T分前に見えているオッズは、確定までにどれだけ動くか')
console.log('  （確定 ÷ 表示。1.00なら動かなかった）')
console.log('')
console.log('  T分前   件数      中央値   ±10%以内  ±25%以内  半分以下  2倍以上')
const cache = new Map()
for (const T of MINS) {
  const rows = rowsAt.all(T)
  cache.set(T, rows)
  if (!rows.length) { console.log(`  ${String(T).padStart(3)}分前   データなし`); continue }
  const ratio = rows.map((r) => r.fin / r.shown)
  const within = (x) => ratio.filter((v) => v >= 1 / x && v <= x).length
  const half = ratio.filter((v) => v <= 0.5).length
  const dbl = ratio.filter((v) => v >= 2).length
  console.log(`  ${String(T).padStart(3)}分前  ${String(rows.length).padStart(7)}  ${
    med(ratio).toFixed(3)}    ${f1(pct(within(1.1), ratio.length)).padStart(5)}%    ${
    f1(pct(within(1.25), ratio.length)).padStart(5)}%   ${
    f1(pct(half, ratio.length)).padStart(5)}%   ${f1(pct(dbl, ratio.length)).padStart(5)}%`)
}

// ---------- ② 見えているオッズで決めると、実際いくら戻るか ----------
console.log('\n■ ② 「単勝◯倍以上なら買う」と決めたときの回収率')
console.log('  実際＝T分前に**見えている**オッズで選び、確定払戻を受け取る（本当にできる買い方）')
console.log('  幻　＝**確定**オッズで選ぶ（締切後にしか分からないので、実際にはできない）')
console.log('')
for (const th of THRESHOLDS) {
  console.log(`  ── 単勝 ${th}倍以上 ──`)
  // 幻（確定オッズで選ぶ）。T に依らないので1回だけ出す
  const base = cache.get(MINS[0]) ?? []
  const ill = base.filter((r) => r.fin >= th)
  const illHit = ill.filter((r) => r.win_combo === String(r.lane))
  const illRet = illHit.reduce((s, r) => s + (r.pay ?? 0), 0)
  console.log(`     幻（確定で選ぶ）     ${String(ill.length).padStart(6)}点  的中${
    f1(pct(illHit.length, ill.length)).padStart(5)}%  回収${f1(pct(illRet, ill.length * 100)).padStart(6)}%`)
  for (const T of MINS) {
    const rows = cache.get(T) ?? []
    const pick = rows.filter((r) => r.shown >= th)
    if (!pick.length) { console.log(`     ${String(T).padStart(3)}分前に見えている値  データなし`); continue }
    const hit = pick.filter((r) => r.win_combo === String(r.lane))
    const ret = hit.reduce((s, r) => s + (r.pay ?? 0), 0)
    console.log(`     ${String(T).padStart(3)}分前に見えている値 ${String(pick.length).padStart(6)}点  的中${
      f1(pct(hit.length, pick.length)).padStart(5)}%  回収${f1(pct(ret, pick.length * 100)).padStart(6)}%`)
  }
  console.log('')
}

// ---------- ③ モデルの確率と組み合わせたとき（いちばん大事） ----------
// ★ここは机上の計算ではない。
//   auto-bet.mjs が毎日、締切1〜12分前に**実際に画面で見えていたオッズ**を odds_seen に記録している。
//   つまり「そのとき本当に買えた値」。それと確定オッズを同じ行で比べられる。
console.log('\n■ ③ モデルの1着確率と組み合わせたとき（実記録・バックテストではない）')
{
  const rows = db.prepare(`
    SELECT b.lane, b.p, b.odds_seen seen, ot.tansho fin, p2.combo win_combo, p2.amount pay
    FROM bets b
    JOIN odds_tan ot ON ot.race_id = b.race_id AND ot.lane = b.lane
    LEFT JOIN payouts p2 ON p2.race_id = b.race_id AND p2.bet_type='tansho'
    WHERE b.bet_type='tansho' AND b.p IS NOT NULL AND b.odds_seen IS NOT NULL
      AND b.odds_seen > 0 AND ot.tansho > 0 AND b.mins_before > 0`).all()
  const span = db.prepare(`SELECT MIN(date) a, MAX(date) b, COUNT(DISTINCT race_id) r FROM bets
    WHERE bet_type='tansho' AND p IS NOT NULL AND odds_seen IS NOT NULL AND mins_before > 0`).get()
  console.log(`  判定の記録 ${rows.length.toLocaleString()}件 / ${span.r.toLocaleString()}レース（${span.a}〜${span.b}）`)
  console.log('  odds_seen ＝ 締切1〜12分前に auto-bet が画面で見ていた、そのとき本当に買えた値')
  console.log('')
  const roi = (xs) => {
    if (!xs.length) return null
    const hit = xs.filter((r) => r.win_combo === String(r.lane))
    return { n: xs.length, hit: hit.length / xs.length * 100,
      roi: hit.reduce((s, r) => s + (r.pay ?? 0), 0) / (xs.length * 100) * 100 }
  }
  const fm = (o) => o ? `${String(o.n).padStart(5)}点  的中${f1(o.hit).padStart(5)}%  回収${f1(o.roi).padStart(6)}%` : '  該当なし'
  console.log('  条件                    実際（見えている値で選ぶ）        幻（確定で選ぶ・買えない）')
  for (const pMin of [0.4, 0.5, 0.6]) {
    for (const oMin of [2, 2.5, 3]) {
      const real = roi(rows.filter((r) => r.p >= pMin && r.seen >= oMin))
      const ill = roi(rows.filter((r) => r.p >= pMin && r.fin >= oMin))
      console.log(`  1着確率${pMin}以上 × ${oMin}倍以上   ${fm(real)}   ${fm(ill)}`)
    }
  }
  console.log('')
  console.log('  → どの組み合わせでも **幻は100%超え・実際は100%割れ**。')
  console.log('     「確定オッズなら勝てる条件」は実在するが、**その値は買うときには存在しない**。')
}

console.log('\n■ 読み方')
console.log('  ・「幻」が100%を超えても、それは**締切後にしか分からない値で選んでいる**から。買えない')
console.log('  ・「見えている値」のほうが本当に実行できる数字。こちらが100%を超えなければ、その条件は使えない')
console.log('  ・控除率25%があるので、どの条件も75%前後に引き戻される（[[boatrace-hitrate-vs-roi]]）')
console.log('  ⚠ 点数の少ない条件（100点未満）は上下に振れる。母数を見て読むこと')
db.close()
