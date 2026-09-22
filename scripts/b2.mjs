// 「本命がB2級かつ確率40%未満なら単勝を買う」の判定と記録。
//
//   node scripts/b2.mjs --date 2026-08-31        その日の判定を記録
//   node scripts/b2.mjs --fill --date 2026-08-31 結果を照合（当日は速報、翌朝は競走成績）
//   node scripts/b2.mjs --report                 ためた分の成績
//   node scripts/b2.mjs --hist                   過去の1日あたり本数の分布
//
// ★これは何か
//   2026-08-31に、オッズを使わない買い方を過去298日で総当たりして唯一残った条件。
//   モデルが本命にした艇がB2級（最下位クラス）で、しかもモデルの自信が40%未満のとき、
//   単勝を1点だけ買う。
//
//   ★数字は2つある。強いほうだけを見ないこと。
//
//   歩進検証(wi1)・298日
//     254本 / 的中36.2% / 回収131.5% / 95%範囲 105.9〜149.1%（100%割れ0.6%）
//     前半119本124.4% ／ 後半135本137.8%（前半で決めて後半で試す形を通過）
//     最大の払戻1本を抜いても 前半114.9% / 後半133.2%
//     確率帯で単調：20〜30%が178.2%、30〜40%が121.7%、40〜50%で91.8%に落ちる
//
//   本番モデル(pred・学習後)・147日  ← **実際に動くのはこちら**
//     124本 / 的中35.5% / 回収125.2%
//     最大1本を抜くと114.7% / 月別プラス3/6
//     **95%範囲 90.9〜158.0%（100%割れ 9.4%）＝100%を含む。有意ではない**
//
//   向きは同じだが、本番モデル側は本数が半分で、まだ「勝てる」とは言えない。
//   [[boatrace-model-vs-walk]] のとおり、判断は必ず pred 側の数字でする。
//
//   ★2026-09-11 朝モデル（02:00に実在する入力だけで学習）で測り直した ← **今の本番はこれ**
//     model5(pred3)・154日  134本 / 的中36.6% / 回収118.2% / 1本抜き108.5%
//     95%範囲 87.2〜152.7%（100%割れ13.5%）
//     **前半(calib)153.5% ／ 後半(test)86.9% ＝ 前半で決めて後半で試すと100%を割る**
//     同じ条件を model4(pred) で測ると 99.1%（後半74.1%）。
//     上の125.2%は、02:00には存在しない波高・直前情報を使ったモデルで出した数字。
//     前向きの記録は 9本・的中25%・回収42.5%（2026-09-11時点・100点に遠く届かない）。
//   → 未確定のまま。後半が100%を割っていることは「強くなっていない」証拠として扱う。
//
// ★なぜオッズを使わないのが大事か
//   単勝は総取り式で払戻が締切後に決まる。「オッズがX倍以上なら買う」という形は
//   価格を固定できず成立しなかった（[[boatrace-tansho-not-executable]]）。
//   この条件は朝の予想と出走表の級別だけで決まるので、**買う前に何を買うか確定できる**。
//
// ★賭け金の上限
//   自分の金でオッズが動く。実測254本で「そのレースの単勝プールの7.05%を入れると
//   回収率が100%に落ちる」。プールは全レースのオッズから逆算して中央19,900円（下限）、
//   公開情報からの上限が約45万円。最悪の想定でも1,000円までならプラスが残る。
//   ⚠ ただし当面は1点100円。100点たまるまで実績で判断しない（本人の運用ルール）。
//
// ★まだ結論ではない
//   254本は約0.85本/日。60通り試した中の1つでもある。
//   単調性と分割を通っているので偶然の可能性は下がったが、消えてはいない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

/** 条件。ここを1か所に固定する（散らばると必ずずれる） */
export const RULE = { grade: 'B2', maxP: 0.40, unit: 100, maxUnit: 1000 }

db.exec(`
  CREATE TABLE IF NOT EXISTS b2_daily (
    race_id TEXT PRIMARY KEY, date TEXT NOT NULL, venue TEXT, race_no INTEGER, deadline TEXT,
    lane INTEGER, racer TEXT, grade TEXT, p REAL,
    hit INTEGER, payout REAL, odds_final REAL, recorded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_b2_date ON b2_daily(date);
`)

if (argv.includes('--backtest')) {
  // ---------- 過去をそのまま流して、日々の記録として何が見えるかを出す ----------
  //   node scripts/b2.mjs --backtest            歩進検証(wi1)・298日
  //   node scripts/b2.mjs --backtest --src pred 本番モデル・学習後の147日
  //
  // ★集計だけでなく「続けたときの見え方」を出す
  //   回収率が良くても、連敗が長く資金の落ち込みが深ければ続かない。
  //   100点たまった時点で何が言えるかも、実際に窓を切って見る。
  // ⚠ ここで作る記録は b2_backtest に入れる。実運用の b2_daily とは混ぜない。
  const SRC = flag('src', 'wi1')
  const PG = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, grade, racer_name FROM programs`).iterate())
    PG.set(r.race_id + '|' + r.lane, r)
  const PAY = new Map()
  for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
      WHERE bet_type='tansho' AND amount IS NOT NULL`).iterate())
    PAY.set(r.race_id + '|' + Number(r.combo), r.amount)
  const WIN = new Map()
  for (const r of db.prepare(`SELECT race_id, lane FROM entries WHERE rank_num=1`).iterate())
    WIN.set(r.race_id, r.lane)
  const OD = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho>0`).iterate())
    OD.set(r.race_id + '|' + r.lane, r.tansho)
  const R = new Map()
  const q = SRC === 'pred'
    ? `SELECT race_id, lane, p FROM pred WHERE split IN ('calib','test')`
    : `SELECT race_id, lane, p FROM wi1`
  for (const r of db.prepare(q).iterate()) {
    let a = R.get(r.race_id); if (!a) { a = new Map(); R.set(r.race_id, a) }
    a.set(r.lane, r.p)
  }
  const days = new Set([...R.keys()].map((k) => k.slice(0, 8)))
  console.log(`【${SRC === 'pred' ? '本番モデル(pred・学習後)' : '歩進検証(wi1)'}】${R.size.toLocaleString()}レース / ${days.size}日`)
  console.log(`条件: 本命が${RULE.grade}級 かつ 確率${RULE.maxP * 100}%未満 → 単勝1点 ${RULE.unit}円\n`)

  const bets = []
  for (const [rid, a] of [...R].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const w = WIN.get(rid); if (w == null) continue
    const t = [...a].sort((x, y) => y[1] - x[1])[0]
    const g = PG.get(rid + '|' + t[0])
    if (!g || g.grade !== RULE.grade || t[1] >= RULE.maxP) continue
    const won = w === t[0]
    const pay = won ? (PAY.get(rid + '|' + t[0]) ?? null) : 0
    if (pay == null) continue
    bets.push({ rid, day: rid.slice(0, 8), lane: t[0], racer: g.racer_name, p: t[1],
      won, pay, od: OD.get(rid + '|' + t[0]) ?? null })
  }
  // ★常駐処理（odds-live / auto-bet / status）が書き込み中だとロックで落ちる。
  //   待って何度でもやり直す。集計は書き込みに失敗しても続ける。
  // ⚠ busy_timeout は既定300秒。ここで待たせると1回の失敗で5分止まる（実際に止めた）。
  //   保存は「できたら残す」程度のものなので、待ち時間を短くして早く諦める。
  db.exec('PRAGMA busy_timeout = 2000')
  let saved = false
  for (let a = 1; a <= 10 && !saved; a++) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS b2_backtest (
        race_id TEXT NOT NULL, src TEXT NOT NULL, day TEXT, lane INTEGER, racer TEXT, p REAL,
        hit INTEGER, payout REAL, odds REAL, PRIMARY KEY (race_id, src))`)
      const ins = db.prepare(`INSERT OR REPLACE INTO b2_backtest VALUES (?,?,?,?,?,?,?,?,?)`)
      db.exec('BEGIN IMMEDIATE')
      for (const b of bets) ins.run(b.rid, SRC, b.day, b.lane, b.racer, b.p, b.won ? 1 : 0, b.pay, b.od)
      db.exec('COMMIT')
      saved = true
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* トランザクションが開いていない */ }
      if (a === 10) console.log(`  ⚠ b2_backtest に保存できなかった（${e.message}）。集計だけ出す。`)
      else await new Promise((r) => setTimeout(r, 1000))
    }
  }

  const inv = bets.length * RULE.unit
  const ret = bets.reduce((s, b) => s + b.pay, 0)
  const hits = bets.filter((b) => b.won)
  console.log(`  買った数    ${bets.length}本（1日 ${(bets.length / days.size).toFixed(2)}本 / ${days.size}日）`)
  console.log(`  的中        ${hits.length}本（${(hits.length / bets.length * 100).toFixed(1)}%）`)
  console.log(`  平均払戻    ${(ret / hits.length).toFixed(0)}円   平均オッズ ${(bets.filter((b) => b.od).reduce((s, b) => s + b.od, 0) / bets.filter((b) => b.od).length).toFixed(2)}倍`)
  console.log(`  回収率      ${(ret / inv * 100).toFixed(1)}%`)
  console.log(`  損益        ${(ret - inv >= 0 ? '+' : '') + (ret - inv).toLocaleString()}円（投入 ${inv.toLocaleString()}円）`)
  console.log(`  1日あたり   ${((ret - inv) / days.size).toFixed(0)}円`)

  // 資金の動き
  let cum = 0, peak = 0, dd = 0, ddAt = '', run = 0, worstRun = 0, worstRunAt = ''
  for (const b of bets) {
    cum += b.pay - RULE.unit
    if (cum > peak) peak = cum
    if (peak - cum > dd) { dd = peak - cum; ddAt = b.day }
    if (b.won) run = 0
    else { run++; if (run > worstRun) { worstRun = run; worstRunAt = b.day } }
  }
  console.log(`\n  いちばん深い落ち込み ${dd.toLocaleString()}円（${ddAt.slice(0, 4)}-${ddAt.slice(4, 6)}-${ddAt.slice(6)}時点）`)
  console.log(`  最長の連敗           ${worstRun}本（${worstRunAt.slice(0, 4)}-${worstRunAt.slice(4, 6)}-${worstRunAt.slice(6)}まで／約${(worstRun / (bets.length / days.size)).toFixed(0)}日ぶん）`)

  // 月別
  const per = new Map()
  for (const b of bets) {
    const m = b.day.slice(0, 4) + '-' + b.day.slice(4, 6)
    let a = per.get(m); if (!a) { a = { n: 0, g: 0 }; per.set(m, a) }
    a.n++; a.g += b.pay
  }
  const ms = [...per].sort()
  console.log('\n  月別')
  let acc = 0
  for (const [m, a] of ms) {
    acc += a.g - a.n * RULE.unit
    console.log(`    ${m}  ${String(a.n).padStart(3)}本  回収${(a.g / (a.n * RULE.unit) * 100).toFixed(0).padStart(4)}%  ` +
      `損益${((a.g - a.n * RULE.unit >= 0 ? '+' : '') + (a.g - a.n * RULE.unit)).padStart(6)}円  累計${(acc >= 0 ? '+' : '') + acc}円`)
  }
  console.log(`    プラスの月 ${ms.filter(([, a]) => a.g > a.n * RULE.unit).length}/${ms.length}`)

  // 100点たまった時点で何が言えるか（窓を切って見る）
  // ⚠ 連続100本の窓で見てはいけない。窓どうしが重なるので散らばりを過小に見せる
  //   （実際それで「100%割れ0%」と出て、ブートストラップの9.4%と食い違った）。
  //   これから来る100本は今までの本と重ならないので、**引き直し（復元抽出）**で見る。
  const W = 100
  if (bets.length >= 30) {
    let seed = 20260831
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const N = 20000, roll = []
    for (let i = 0; i < N; i++) {
      let s = 0
      for (let k = 0; k < W; k++) s += bets[Math.floor(rnd() * bets.length)].pay
      roll.push(s / (W * RULE.unit) * 100)
    }
    roll.sort((a, b) => a - b)
    const qq = (p) => roll[Math.floor(N * p)]
    console.log(`\n  【これから100点そろえたとき、何が見えるか】（引き直し${N.toLocaleString()}回）`)
    console.log(`    下位5% ${qq(0.05).toFixed(0)}%  下位25% ${qq(0.25).toFixed(0)}%  中央 ${qq(0.5).toFixed(0)}%  上位25% ${qq(0.75).toFixed(0)}%  上位5% ${qq(0.95).toFixed(0)}%`)
    console.log(`    100%を下回って見える確率  ${(roll.filter((x) => x < 100).length / N * 100).toFixed(1)}%`)
    console.log(`    150%を上回って見える確率  ${(roll.filter((x) => x > 150).length / N * 100).toFixed(1)}%`)
    console.log(`    ⚠ 過去の実力が${(ret / inv * 100).toFixed(0)}%だとしても、100点では${qq(0.05).toFixed(0)}〜${qq(0.95).toFixed(0)}%のどこかに出る。`)
    console.log(`      100点は「勝てる」と決める材料にはならない。負けても捨てる材料にもならない。`)
    // 何点あれば分かるか
    for (const w of [200, 400, 800, 1600]) {
      const r2 = []
      for (let i = 0; i < 4000; i++) {
        let s = 0
        for (let k = 0; k < w; k++) s += bets[Math.floor(rnd() * bets.length)].pay
        r2.push(s / (w * RULE.unit) * 100)
      }
      r2.sort((a, b) => a - b)
      const lo = r2[Math.floor(4000 * 0.05)], hi = r2[Math.floor(4000 * 0.95)]
      console.log(`    ${String(w).padStart(4)}点なら 90%の確率で ${lo.toFixed(0)}〜${hi.toFixed(0)}%（幅${(hi - lo).toFixed(0)}pt）` +
        `　${(bets.length / days.size) > 0 ? `＝約${Math.round(w / (bets.length / days.size))}日` : ''}`)
    }
  }
  console.log(`\n  記録は b2_backtest（src='${SRC}'）。実運用の b2_daily とは別。`)
  db.close(); process.exit(0)
}

if (argv.includes('--hist')) {
  // 過去の1日あたり本数。0本の日がどれくらいあるかを知っておく
  const PG = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, grade FROM programs`).iterate())
    PG.set(r.race_id + '|' + r.lane, r.grade)
  const R = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, p FROM wi1`).iterate()) {
    let a = R.get(r.race_id); if (!a) { a = new Map(); R.set(r.race_id, a) }
    a.set(r.lane, r.p)
  }
  const per = new Map()
  for (const [rid, a] of R) {
    const d = rid.slice(0, 8)
    if (!per.has(d)) per.set(d, 0)
    const t = [...a].sort((x, y) => y[1] - x[1])[0]
    if (PG.get(rid + '|' + t[0]) === RULE.grade && t[1] < RULE.maxP) per.set(d, per.get(d) + 1)
  }
  const v = [...per.values()]
  const c = new Map()
  for (const x of v) c.set(x, (c.get(x) ?? 0) + 1)
  console.log(`${v.length}日ぶん / 合計 ${v.reduce((a, b) => a + b, 0)}本 / 1日平均 ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}本\n`)
  console.log('  1日の本数   日数    割合')
  for (const [n, d] of [...c].sort((a, b) => a[0] - b[0]))
    console.log(`  ${String(n).padStart(6)}本 ${String(d).padStart(6)}日 ${(d / v.length * 100).toFixed(1).padStart(6)}%`)
  db.close(); process.exit(0)
}

if (argv.includes('--report')) {
  const d = db.prepare(`SELECT COUNT(DISTINCT date) d, COUNT(*) n,
    SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) done,
    SUM(COALESCE(hit,0)) h, SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret FROM b2_daily`).get()
  console.log(`B2判定の実績：${d.d}日 / 記録 ${d.n}本 / 結果が出た ${d.done}本`)
  if (d.done) {
    console.log(`  的中     ${d.h}本（${(d.h / d.done * 100).toFixed(1)}%）`)
    console.log(`  回収率   ${(d.ret / (d.done * RULE.unit) * 100).toFixed(1)}%（1点${RULE.unit}円）`)
    console.log(`  損益     ${(d.ret - d.done * RULE.unit >= 0 ? '+' : '') + (d.ret - d.done * RULE.unit).toLocaleString()}円`)
  }
  console.log(`\n  過去の実測（判断は本番モデル側でする）`)
  console.log(`    本番モデル(147日)  124本・的中35.5%・回収125.2%・95%範囲 90.9〜158.0%  ← こちらが実力`)
  console.log(`    歩進検証 (298日)  254本・的中36.2%・回収131.5%・95%範囲105.9〜149.1%`)
  console.log(`  ⚠ 100点たまるまで実績で判断しない。いまは ${d.done}/100点。`)
  const rows = db.prepare(`SELECT date, venue, race_no, lane, racer, p, hit, payout FROM b2_daily ORDER BY date DESC, race_no LIMIT 20`).all()
  if (rows.length) {
    console.log('\n  直近の記録')
    for (const r of rows)
      console.log(`    ${r.date} ${r.venue}${r.race_no}R ${r.lane}号艇 ${r.racer} 確率${(r.p * 100).toFixed(1)}% ` +
        (r.hit == null ? '（結果待ち）' : r.hit ? `★的中 ${r.payout}円` : 'はずれ'))
  }
  db.close(); process.exit(0)
}

if (argv.includes('--fill')) {
  // 結果の元は2つ。当日は公式の結果ページ(result_live)、翌朝は競走成績(entries/payouts)。
  // Kファイルが来たらそちらが正なので上書きする。
  const only = flag('date')
  const rows = only
    ? db.prepare(`SELECT race_id, lane FROM b2_daily WHERE date=?`).all(only)
    : db.prepare(`SELECT race_id, lane FROM b2_daily WHERE hit IS NULL`).all()
  if (!rows.length) { console.log('照合するものなし'); db.close(); process.exit(0) }
  const ids = rows.map(() => '?').join(',')
  const IDS = rows.map((r) => r.race_id)
  const WIN = new Map(), PAY = new Map(), OD = new Map()
  try {
    for (const r of db.prepare(`SELECT race_id, lane1, tansho, tansho_pay FROM result_live
        WHERE status='ok' AND race_id IN (${ids})`).all(...IDS)) {
      WIN.set(r.race_id, r.lane1)
      if (r.tansho && r.tansho_pay != null) PAY.set(r.race_id + '|' + r.tansho, r.tansho_pay)
    }
  } catch { /* result_live が無い日 */ }
  for (const r of db.prepare(`SELECT race_id, lane FROM entries WHERE rank_num=1 AND race_id IN (${ids})`).all(...IDS))
    WIN.set(r.race_id, r.lane)
  for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
      WHERE bet_type='tansho' AND amount IS NOT NULL AND race_id IN (${ids})`).all(...IDS))
    PAY.set(r.race_id + '|' + Number(r.combo), r.amount)
  for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE race_id IN (${ids})`).all(...IDS))
    OD.set(r.race_id + '|' + r.lane, r.tansho)
  const upd = db.prepare(`UPDATE b2_daily SET hit=?, payout=?, odds_final=? WHERE race_id=?`)
  let n = 0
  db.exec('BEGIN')
  for (const r of rows) {
    const w = WIN.get(r.race_id); if (w == null) continue
    const hit = w === r.lane ? 1 : 0
    const pay = hit ? (PAY.get(r.race_id + '|' + r.lane) ?? null) : 0
    if (hit && pay == null) continue          // 払戻がまだ
    upd.run(hit, pay, OD.get(r.race_id + '|' + r.lane) ?? null, r.race_id); n++
  }
  db.exec('COMMIT')
  console.log(`埋めた ${n} / 対象 ${rows.length}`)
  db.close(); process.exit(0)
}

// ---------- 当日の判定 ----------
const DATE = flag('date') || new Date().toISOString().slice(0, 10)
const f = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(f)) { console.error(`${f} がありません`); process.exit(1) }
const j = JSON.parse(readFileSync(f, 'utf8'))
const PG = new Map()
for (const r of db.prepare(`SELECT race_id, lane, grade, racer_name FROM programs WHERE substr(race_id,1,8)=?`)
  .all(DATE.replace(/-/g, ''))) PG.set(r.race_id + '|' + r.lane, r)
const DL = new Map()
// ★締切の取り方（2026-09-21に直した）
//   以前は races に1件でもあれば公式から取らなかった。9/21は15時の処理で当日の races に
//   156レース中25件だけ入っていて、残り131レースの締切が不明のまま「99:99＝まだ先」扱いになり、
//   15:41に走った朝バッチが**締切後のレースまで記録した**。
//   → races・race_meta・公式の順に、レースごとに足りない分を埋める。
//   → それでも分からない当日のレースは「締切済み」とみなして記録しない（下の late / early）。
for (const r of db.prepare(`SELECT race_id, deadline FROM races WHERE date=?`).all(DATE)) if (r.deadline) DL.set(r.race_id, r.deadline)
try { for (const r of db.prepare(`SELECT race_id, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL`).all(DATE)) if (!DL.get(r.race_id)) DL.set(r.race_id, r.deadline) } catch { /* race_meta がまだ無い */ }
if ((j.races ?? []).some((r) => !DL.get(r.race_id))) {   // 足りないレースがあれば公式から取る
  const S = await import('./strategy.mjs')
  const M = await S.deadlines(DATE.replace(/-/g, ''), [...new Set((j.races ?? []).map((r) => r.jcd))])
  for (const r of (j.races ?? [])) { const d = M.get(r.jcd)?.[r.race_no - 1]; if (d) DL.set(r.race_id, d) }
}

const picks = []
let checked = 0
for (const r of (j.races ?? [])) {
  const t = (r.first ?? []).slice().sort((a, b) => b.p - a.p)[0]
  if (!t) continue
  const g = PG.get(r.race_id + '|' + t.lane)
  if (!g) continue
  checked++
  if (g.grade !== RULE.grade || t.p >= RULE.maxP) continue
  picks.push({ r, t, g })
}
// ★当日の記録では、締切を過ぎたレースを**足さない・書き換えない**（tansho/haishin/spot と同じ）。
//   締切後に出した判定は買えない。hit IS NULL のガードでは締切後・結果前の行を守れない。
//   ⚠ 日付は toISOString(UTC) で比べないこと。深夜0〜9時に前日と判定される。
{
  const _d = new Date()
  const _today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
  const _now = _d.toTimeString().slice(0, 5)
  if (DATE === _today) {
    const late = picks.filter((x) => (DL.get(x.r.race_id) ?? '00:00') <= _now)
    for (const x of late) picks.splice(picks.indexOf(x), 1)
    if (late.length) console.log(`締切を過ぎた ${late.length}レースは記録しない: ` +
      late.map((x) => `${x.r.venue}${x.r.race_no}R(${DL.get(x.r.race_id)})`).join(' '))
  }
}
// ★--from HH:MM … その時刻より前に締切のレースは、今回は足さない・書き換えない。
//   本人の指定「10時からのレースで予想を更新して」（2026-09-13）に対応するため追加。
//   朝のうちに作り直すと、まだ締切前の早いレースまで買い目が入れ替わってしまうので、それを防ぐ。
{
  const _fi = argv.indexOf('--from')
  const FROM = _fi > -1 ? argv[_fi + 1] : null
  if (FROM) {
    const early = picks.filter((x) => (DL.get(x.r.race_id) ?? '00:00') < FROM)
    for (const x of early) picks.splice(picks.indexOf(x), 1)
    if (early.length) console.log(FROM + 'より前に締切の ' + early.length + 'レースは今回は触らない')
  }
}
console.log(`${DATE}　${checked}レースを判定　→ 買い ${picks.length}本（1点${RULE.unit}円）`)
// ⚠ INSERT OR REPLACE だと再記録で hit/payout が消える（haishin側で実際に消した）。
//   買い目の中身だけ入れ替えて、結果は残す。
const ins = db.prepare(`INSERT INTO b2_daily
  (race_id,date,venue,race_no,deadline,lane,racer,grade,p,hit,payout,odds_final,recorded_at)
  VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)
  ON CONFLICT(race_id) DO UPDATE SET
    date=excluded.date, venue=excluded.venue, race_no=excluded.race_no,
    deadline=excluded.deadline, lane=excluded.lane, racer=excluded.racer,
    grade=excluded.grade, p=excluded.p, recorded_at=excluded.recorded_at
  WHERE b2_daily.hit IS NULL`)
// ⚠ 最後の WHERE を外さないこと。結果が出た行の買い目を差し替えると、hit だけ残って嘘の記録になる。
const stamp = new Date().toISOString()
db.exec('BEGIN')
// ★選手名は racer_period から引く。programs.racer_name は番組表の4文字固定幅で切れている。
const qName = db.prepare(`SELECT name FROM racer_period WHERE racer_id = (SELECT racer_id FROM programs
  WHERE race_id = ? AND lane = ?) ORDER BY CASE WHEN period <= ? THEN 0 ELSE 1 END, period DESC LIMIT 1`)
for (const { r, t, g } of picks) {
  const nm = qName.get(r.race_id, t.lane, DATE.slice(0, 7))?.name ?? g.racer_name
  ins.run(r.race_id, DATE, r.venue, r.race_no, DL.get(r.race_id) ?? null,
    t.lane, nm, g.grade, t.p, stamp)
  console.log(`  ${r.venue}${r.race_no}R 締切${DL.get(r.race_id) ?? '-'}  ${t.lane}号艇 ${nm}（${g.grade}）確率${(t.p * 100).toFixed(1)}%`)
}
db.exec('COMMIT')
if (!picks.length) console.log('  （条件に合うレースなし。1日平均0.85本なので0本の日が大半）')
db.close()
