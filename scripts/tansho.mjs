// 無料公開する枠。単勝1点だけ。
//
//   node scripts/tansho.mjs --date 2026-09-06          その日ぶんを記録
//   node scripts/tansho.mjs --date 2026-09-06 --text   そのまま貼れる文面
//   node scripts/tansho.mjs --fill --date 2026-09-06   結果を照合
//   node scripts/tansho.mjs --report                   ためた分の成績
//   （絞りを変える: --p 0.70 で1日46.9本、--p 0.60 で74.2本、--p 0.85 で少数）
//
// ★何を出すか
//   1着確率がいちばん高い艇の確率が 0.80 以上のレースだけ、その1艇を単勝1点。
//   **オッズを一切使わない**ので、番組表が出た時点＝前日夜に確定する。
//
// ★なぜ単勝なのか（2026-09-06に本人の指定）
//   無料で配るので「見て分かる」ことが第一。単勝1点は説明がいらない。
//   3連複4点・3連単4点（haishin.mjs）は見栄えの枠で、券種が違う。
//
// ★実測（朝モデル model5.json --morning → pred3・23,892レース／154日・split=calib/test）
//     P(1着)≥0.80   1日16.8本  的中80.0%  平均配当117円  回収93.4%
//     P(1着)≥0.79   1日18.5本  的中79.5%  平均配当117円  回収93.2%
//     P(1着)≥0.70   1日44.0本  的中75.6%  回収93.2%
//     P(1着)≥0.60   1日71.4本  的中71.7%  回収93.2%
//
// ★⚠ 2026-09-06に **96.3% → 93.4% へ下方修正した**。前の数字は使ってはいけない。
//   旧モデルは races.wave / wind_speed と直前情報(bf_*)を学習に使っていたが、これらは
//   02:00 の予想時点で存在しない。predict.mjs は無い項目を**学習時の平均値**で埋めるので
//   （predict.mjs:341）、「平均的な展示だった・平均的な波だった」ことにして予想していた。
//   02:00に実在する入力だけで学習し直した結果が上の93.4%。これが本当に出せる数字。
//   同じ15日を測ると 旧モデル実測86.5% / 朝モデル88.7%（95%範囲 79.7〜96.1%）で、
//   検証93.7%との差はばらつきの範囲に収まった。
//
// ★⚠ 回収93.4%は「増える」ではない。買い続ければ減る。
//   平均配当が117円＝当たっても手元に増えるのは17円しかない。
//   単勝の市場平均は67.8%（控除率32.2%）なので**市場よりは25.6pt上**、という意味しかない。
//   この但し書きを画面と文面から外さないこと。
//
// ★⚠ 選ばれる艇の98.9%は1号艇。
//   「1号艇を機械的に買う」だけでも単勝89.9%まで行く。差は正味わずか。
//   独自性を売りにするなら、モデルが1号艇以外を指した場面を別に見せること。
//
// ★⚠ 閾値は **pred3（本番の model5.json の出力）** で出すこと。
//   model4 の pred で出すと本命が92.8%しか一致せず、確率が平均0.042ずれる。
//   予想JSONの races[].first は model5 の出力なので、pred3 側と比べてよい。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

const MINP = Number(flag('p', '0.80'))

db.exec(`
  CREATE TABLE IF NOT EXISTS tansho_daily (
    race_id TEXT PRIMARY KEY, date TEXT NOT NULL, venue TEXT, race_no INTEGER, deadline TEXT,
    lane INTEGER NOT NULL, racer TEXT, p REAL,
    hit INTEGER, payout REAL, recorded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_td_date ON tansho_daily(date);
`)
// ★どのモデルで出した行かを残す。2026-09-06にモデルを入れ替えたので、
//   これが無いと前向きの記録が新旧混ざって読めなくなる。
//   full-leaky … 波高・風速・直前情報を学習に使い、本番では平均値で埋めていた旧モデル
//   morning    … 02:00に実在する入力だけで学習した現行モデル
for (const c of ['model TEXT']) try { db.exec('ALTER TABLE tansho_daily ADD COLUMN ' + c) } catch { /* すでにある */ }
db.exec(`UPDATE tansho_daily SET model='full-leaky' WHERE model IS NULL AND date <= '2026-09-06'`)

if (argv.includes('--report')) {
  const d = db.prepare(`SELECT COUNT(DISTINCT date) d, COUNT(*) r,
    SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) done FROM tansho_daily`).get()
  console.log(`無料枠（単勝1点・P(1着)>=${MINP}）の実績：${d.d}日 / 記録${d.r.toLocaleString()}本 / 照合済み${(d.done ?? 0).toLocaleString()}本`)
  console.log('※ 100点貯まるまでは実績で判断しない。以下は途中経過。\n')
  const r = db.prepare(`SELECT COUNT(*) bets, SUM(hit) hits,
    SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret,
    MAX(CASE WHEN hit=1 THEN payout ELSE 0 END) top
    FROM tansho_daily WHERE hit IS NOT NULL`).get()
  if (!r.bets) { console.log('  まだ照合できた行がない'); db.close(); process.exit(0) }
  console.log(`  ${r.bets.toLocaleString()}本　的中 ${(r.hits / r.bets * 100).toFixed(2)}%　` +
    `平均配当 ${(r.hits ? r.ret / r.hits : 0).toFixed(0)}円　回収 ${(r.ret / (r.bets * 100) * 100).toFixed(2)}%`)
  // ★いちばん高い配当を1本抜いた回収率も必ず出す。1本の大穴で見かけが変わるため。
  if (r.bets > 1)
    console.log(`  最高配当 ${r.top.toLocaleString()}円 を1本抜くと 回収 ${((r.ret - r.top) / ((r.bets - 1) * 100) * 100).toFixed(2)}%`)
  console.log('\n  日別')
  for (const x of db.prepare(`SELECT date, COUNT(*) b, SUM(hit) h,
      SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret
      FROM tansho_daily WHERE hit IS NOT NULL GROUP BY date ORDER BY date`).all())
    console.log(`    ${x.date}  ${String(x.b).padStart(3)}本  的中${String(x.h).padStart(3)}  ` +
      `回収 ${(x.ret / (x.b * 100) * 100).toFixed(1).padStart(6)}%  収支 ${(x.ret - x.b * 100 >= 0 ? '+' : '')}${(x.ret - x.b * 100).toLocaleString()}円`)
  db.close(); process.exit(0)
}

if (argv.includes('--fill')) {
  // ★情報源は2つ。Kファイル由来(entries/payouts)が正で、当日はそれが無いので
  //   公式の結果ページ由来(result_live)で先に埋める。翌日Kファイルが来たら上書きする。
  // ★--date を必ず付ける。付けないと payouts 223万行・entries 134万行を全走査して、
  //   15分ごとの実行が他とロックを取り合って詰まる（haishin.mjs で実際に2本詰めた）。
  const ONLY = flag('date')
  const RECHECK = argv.includes('--recheck')
  const cond = RECHECK ? '1=1' : 'hit IS NULL'
  const rows = ONLY
    ? db.prepare(`SELECT race_id, lane, hit FROM tansho_daily WHERE ${cond} AND date=?`).all(ONLY)
    : db.prepare(`SELECT race_id, lane, hit FROM tansho_daily WHERE ${cond}`).all()
  if (!rows.length) { console.log(`照合するものなし${ONLY ? `（${ONLY}）` : ''}`); db.close(); process.exit(0) }
  const IDS = [...new Set(rows.map((r) => r.race_id))]
  const inq = IDS.map(() => '?').join(',')
  const PAY = new Map()   // race_id|lane → 払戻
  const WIN = new Map()   // race_id → 1着の艇番
  let live = 0
  try {
    for (const r of db.prepare(`SELECT race_id, lane1, tansho, tansho_pay FROM result_live
        WHERE status='ok' AND race_id IN (${inq})`).iterate(...IDS)) {
      if (r.lane1 != null) { WIN.set(r.race_id, r.lane1); live++ }
      if (r.tansho && r.tansho_pay != null) PAY.set(r.race_id + '|' + r.tansho, r.tansho_pay)
    }
  } catch { /* result_live がまだ無い＝当日取りを使っていない。Kファイルだけで進める */ }
  // Kファイル由来を後に入れて上書きする（こちらが正）
  for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
      WHERE bet_type='tansho' AND amount IS NOT NULL AND race_id IN (${inq})`).iterate(...IDS))
    PAY.set(r.race_id + '|' + r.combo, r.amount)
  let kfile = 0
  for (const r of db.prepare(`SELECT race_id, lane FROM entries
      WHERE rank_num=1 AND race_id IN (${inq})`).iterate(...IDS)) { WIN.set(r.race_id, r.lane); kfile++ }
  console.log(`未照合 ${IDS.length}レース　結果の元：当日取り ${live} ／ 競走成績 ${kfile}`)
  const upd = db.prepare(`UPDATE tansho_daily SET hit=?, payout=? WHERE race_id=?`)
  let n = 0, changed = 0
  db.exec('BEGIN')
  for (const r of rows) {
    const w = WIN.get(r.race_id)
    if (w == null) continue                          // 中止・失格などで1着が決まっていない
    const hit = w === r.lane ? 1 : 0
    const pay = hit ? (PAY.get(r.race_id + '|' + String(r.lane)) ?? null) : 0
    if (hit && pay == null) continue                 // 払戻がまだ入っていない
    if (r.hit != null && r.hit !== hit) changed++    // 速報と競走成績が食い違った
    upd.run(hit, pay, r.race_id); n++
  }
  db.exec('COMMIT')
  console.log(`埋めた ${n.toLocaleString()} / 対象だった ${rows.length.toLocaleString()}`)
  if (changed) console.log(`⚠ 速報と競走成績が食い違った行 ${changed}件（競走成績で上書き済み）`)
  db.close(); process.exit(0)
}

// ここから記録モード
const DATE = flag('date') || new Date().toISOString().slice(0, 10)
const f = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(f)) {
  console.error(`${f} がありません。先に predict.mjs --trio --json --out を走らせること`)
  process.exit(1)
}
const j = JSON.parse(readFileSync(f, 'utf8'))

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
  for (const r of (j.races ?? [])) { const dl = M.get(r.jcd)?.[r.race_no - 1]; if (dl) DL.set(r.race_id, dl) }
}

const picked = []
for (const r of (j.races ?? [])) {
  const fi = r.first ?? []
  if (!fi.length) continue
  // ★ first は確率順に並んでいる前提にしない。並べ替えてから先頭を取る。
  const best = [...fi].sort((a, b) => b.p - a.p)[0]
  if (best.p < MINP) continue
  picked.push({ r, lane: best.lane, racer: best.name ?? null, p: best.p })
}
// ★当日の記録では、締切を過ぎたレースを**足さない・書き換えない**。
//   2026-09-11 08:50 に作り直したら、08:32締切の芦屋1Rが新たに入った。
//   締切後に出した予想は誰も買えないので、無料で配る画面に載せたら「後出し」になる。
//   ⚠ hit IS NULL のガードだけでは足りない（締切後・結果前の行は hit がまだ NULL）。
//   ⚠ 日付は toISOString(UTC) で比べないこと。深夜0〜9時に前日と判定される。
{
  const _d = new Date()
  const _today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
  const _now = _d.toTimeString().slice(0, 5)
  if (DATE === _today) {
    const late = picked.filter((x) => (DL.get(x.r.race_id) ?? '00:00') <= _now)
    for (const x of late) picked.splice(picked.indexOf(x), 1)
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
    const early = picked.filter((x) => (DL.get(x.r.race_id) ?? '00:00') < FROM)
    for (const x of early) picked.splice(picked.indexOf(x), 1)
    if (early.length) console.log(FROM + 'より前に締切の ' + early.length + 'レースは今回は触らない')
  }
}
picked.sort((a, b) => String(DL.get(a.r.race_id) ?? '').localeCompare(String(DL.get(b.r.race_id) ?? '')))
console.log(`${DATE}　全${(j.races ?? []).length}レース中 ${picked.length}レースが対象（P(1着) >= ${MINP}）`)

if (argv.includes('--text')) {
  console.log('')
  for (const x of picked)
    console.log(`【${x.r.venue}${x.r.race_no}R】締切 ${DL.get(x.r.race_id) ?? '-'}　単勝 ${x.lane}号艇 ${x.racer ?? ''}`)
  console.log('')
  console.log('※ 過去の実測で的中80.0%・回収93.4%。**回収はマイナスです。買い続ければ減ります。**')
  console.log('※ 当たっても平均配当117円＝手元に増えるのは17円です。')
  db.close(); process.exit(0)
}

// ⚠ INSERT OR REPLACE にすると、再記録のたびに hit/payout が NULL に戻って
//   照合済みの結果が消える（haishin_daily で 2026-09-01 に8/31の72点を消した）。
//   買い目の中身だけ入れ替えて、**結果は残す**。
const ins = db.prepare(`INSERT INTO tansho_daily
  (race_id,date,venue,race_no,deadline,lane,racer,p,hit,payout,recorded_at,model)
  VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?)
  ON CONFLICT(race_id) DO UPDATE SET
    date=excluded.date, venue=excluded.venue, race_no=excluded.race_no,
    deadline=excluded.deadline, lane=excluded.lane, racer=excluded.racer,
    p=excluded.p, recorded_at=excluded.recorded_at, model=excluded.model
  WHERE tansho_daily.hit IS NULL`)
// ⚠ 最後の WHERE を外さないこと。
//   結果が出た行の買い目を後から差し替えると、hit だけ前のまま残って
//   「1号艇と記録して的中、でも実際に買ったのは2号艇」という嘘の記録になる。
//   走り終えたレースの予想は**歴史**なので、モデルを入れ替えても書き換えない。
const now = new Date().toISOString()
db.exec('BEGIN')
for (const x of picked)
  ins.run(x.r.race_id, DATE, x.r.venue, x.r.race_no, DL.get(x.r.race_id) ?? null,
    x.lane, x.racer, x.p, now, 'morning')
db.exec('COMMIT')
console.log(`記録した ${picked.length}レース → tansho_daily`)
console.log(`画面: http://localhost:3940/tansho?date=${DATE}`)
db.close()
