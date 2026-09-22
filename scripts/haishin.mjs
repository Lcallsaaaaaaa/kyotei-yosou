// 配信用の予想を作る。買う判定とは別物。
//
//   node scripts/haishin.mjs --date 2026-08-31          その日の配信用を記録
//   node scripts/haishin.mjs --date 2026-08-31 --text   そのまま貼れる文面
//   node scripts/haishin.mjs --fill                     結果を照合
//   node scripts/haishin.mjs --report                   ためた分の成績
//   node scripts/haishin.mjs --date 2026-09-19 --text --n 2   3連複2点プランの文面
//   （絞りを変える: --conf 0.7364 で1日23本、--conf 0.6948 で38本、--conf 0.8040 で8本）
//
// ★3連複2点プラン（2026-09-19に追加）
//   記録は今までどおり4点ぶん入れ、2点プランは**その上位2点を見せるだけ**にした。
//   別のテーブルを作らないので、過去の記録がそのまま2点の実績として読める。
//   選び方（自信度0.7645以上）は4点のときと同じ。上位2点の合計で選び直す案も測ったが、
//   回収率は 0.50以上で84.1%・0.55以上で82.0% と、今のまま(83.1%)とほぼ同じだった。
//
// ★買う判定とどう違うか
//   買う判定（b2.mjs → b2_daily）… 単勝1点。オッズを使わず級別の看板の歪みを突く。
//   配信用（これ → haishin_daily）… 3連複4点と3連単4点。見せるためのもの。
//                                 **回収はマイナス。買うものではない。**
//   狙うものが逆なので、テーブルも画面も分ける。
//
// ★3連単の中身＝確率の高い順に上位4点（2026-09-01に本人の指定で確定）
//   自信度0.7645以上の2,261レースで実測（本番モデル）：
//     上位4点そのまま  **的中45.73%** ← これが最大
//     3点＋穴          的中42.33%（穴が当たると平均1,743円・最高19,680円）
//   確率の高い順に4点取るのが的中率としては数学的に最大になる。
//   穴を混ぜると必ず下がるので、的中率を見せる形では入れない。
//   （穴を入れる版も一度作ったが、本人の指定で上位4点に戻した）
//
// ★絞り方（2026-08-31に測って決めた）
//   自信度 = 3連複の上位4点の確率の合計。**朝の時点で分かる**。
//   ⚠ 数字は**本番モデル(model5.json → pred3)**で測ること。歩進検証(wi3)で測ると
//     的中率は同じだが**確率の鋭さが違うので閾値がずれる**（実際に一度やった。
//     wi3の上位10%は0.8282だが、本番では同じ値が上位2.8%＝1日4本になった）。
//   学習後の22,614レース（147日・split=calib/test）で測った：
//     絞りなし      1日153.8本  3連複4点 63.70%  3連単4点 30.53%
//     上位25%       1日 38.5本           77.41%           41.70%
//     上位15%       1日 23.1本           80.69%           44.25%
//     上位10%(既定) 1日 15.4本           82.62%           45.73%   ← 回収率も最良
//     上位 5%       1日  7.7本           83.47%           46.95%
//   点数を増やすと的中は上がるが回収は下がる（3連複6点で90.49%／75.7%）。
//
//   ⚠ 最初は「モデルの上位3点＝市場の上位3点」で絞る案だった（3連複4点 69.46%）。
//     これは**朝には判定できない**。3連単オッズは翌日にしか取っていないため。
//     さらに自信度絞りのほうが同じ本数で +7.43pt 上だったので、市場は使わない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

// 自信度の足切り。0.7645＝本番モデルの上位10%（1日15.4本）。
// ⚠ この値は pred3（本番モデルの出力）から出したもの。wi3 の区切りとは別物。
const CONF = Number(flag('conf', '0.7645'))
const PTS = 4   // 3連複・3連単とも4点。5点以上は的中が上がるが本数が増える。
// ★文面に出す点数（--n 2 で3連複2点プラン）。記録はいつも4点ぶん入れる。
//   2点プランは「4点の記録の上位2点を見せているだけ」なので、
//   記録を作り直さずに済み、過去の実績もそのまま使える（2026-09-19）。
const NPT = Math.min(PTS, Math.max(1, Number(flag('n', String(PTS)))))
// 本番モデルの検証データ（学習外175日・2,689レース）で測った点数別の実測。
const REF = { 1: ['37.3%', '84.9%'], 2: ['58.9%', '83.1%'], 3: ['74.0%', '83.1%'], 4: ['82.5%', '81.7%'] }

db.exec(`
  CREATE TABLE IF NOT EXISTS haishin_daily (
    race_id TEXT NOT NULL, date TEXT NOT NULL, venue TEXT, race_no INTEGER, deadline TEXT,
    conf REAL,
    kind TEXT NOT NULL,          -- sanrentan / sanrenpuku
    rank INTEGER NOT NULL, combo TEXT NOT NULL, p REAL,
    ana INTEGER,                 -- 1なら穴（当てにいく3点とは別枠）
    hit INTEGER, payout REAL, recorded_at TEXT,
    PRIMARY KEY (race_id, kind, rank)
  );
  CREATE INDEX IF NOT EXISTS idx_hd_date ON haishin_daily(date);
`)
// ★後から足した列。既存のテーブルにも入れる。
for (const c of ['ana INTEGER']) try { db.exec('ALTER TABLE haishin_daily ADD COLUMN ' + c) } catch { /* すでにある */ }

if (argv.includes('--report')) {
  const d = db.prepare(`SELECT COUNT(DISTINCT date) d, COUNT(DISTINCT race_id) r FROM haishin_daily`).get()
  console.log(`配信用の実績：${d.d}日 / ${d.r.toLocaleString()}レース`)
  console.log('※ 100点貯まるまでは実績で判断しない。以下は途中経過。\n')
  console.log('  券種   点数  レース数   的中率   平均払戻    回収率')
  for (const [kind, nm] of [['sanrenpuku', '3連複'], ['sanrentan', '3連単']]) {
    for (const pts of [1, 2, 3, 4, 5, 6]) {
      const r = db.prepare(`SELECT COUNT(DISTINCT race_id) races, COUNT(*) bets,
        SUM(COALESCE(hit,0)) hits, SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret
        FROM haishin_daily WHERE kind=? AND rank<=? AND hit IS NOT NULL`).get(kind, pts)
      if (!r.bets) continue
      console.log(`  ${nm} ${String(pts).padStart(4)}点 ${String(r.races).padStart(8)} ${(r.hits / r.races * 100).toFixed(2).padStart(7)}% ${(r.hits ? r.ret / r.hits : 0).toFixed(0).padStart(8)}円 ${(r.ret / (r.bets * 100) * 100).toFixed(2).padStart(8)}%`)
    }
    console.log('')
  }
  db.close(); process.exit(0)
}

if (argv.includes('--fill')) {
  // ★情報源は2つ。Kファイル由来(entries/payouts)が正で、当日はそれが無いので
  //   公式の結果ページ由来(result_live)で先に埋める。翌日Kファイルが来たら上書きする。
  //   ⚠ 当日取りを payouts/entries に混ぜないこと。「いつの情報か」が分からなくなる。
  //
  // ★--date を付けるとその日だけ照合する（15分ごとの当日運用はこちら）。
  //   付けないと payouts 223万行・entries 134万行を全走査する。それを15分ごとに
  //   回したら他の処理とロックを取り合って詰まった（2026-08-31に実際に2本詰めた）。
  //
  // ★--recheck を付けると、埋め済みの行も入れ直す。
  //   当日は公式の結果ページ（速報）で埋めている。翌朝に競走成績(Kファイル)が来たら
  //   それで検算する。速報の取り違えが残ったままにならないようにするため。
  const ONLY = flag('date')
  const RECHECK = argv.includes('--recheck')
  const cond = RECHECK ? '1=1' : 'hit IS NULL'
  const rows = ONLY
    ? db.prepare(`SELECT race_id, kind, rank, combo, hit FROM haishin_daily WHERE ${cond} AND date=?`).all(ONLY)
    : db.prepare(`SELECT race_id, kind, rank, combo, hit FROM haishin_daily WHERE ${cond}`).all()
  if (!rows.length) { console.log(`照合するものなし${ONLY ? `（${ONLY}）` : ''}`); db.close(); process.exit(0) }
  const IDS = [...new Set(rows.map((r) => r.race_id))]
  const inq = IDS.map(() => '?').join(',')
  const PAY = new Map()
  const WIN = new Map()
  const put = (rid, k, combo, amt) => { if (combo && amt != null) PAY.set(rid + '|' + k + '|' + combo, amt) }
  let live = 0
  try {
    for (const r of db.prepare(`SELECT race_id, lane1, lane2, lane3, sanrentan, sanrentan_pay,
        sanrenpuku, sanrenpuku_pay FROM result_live WHERE status='ok' AND race_id IN (${inq})`).iterate(...IDS)) {
      WIN.set(r.race_id, { 1: r.lane1, 2: r.lane2, 3: r.lane3 }); live++
      put(r.race_id, 'sanrentan', r.sanrentan, r.sanrentan_pay)
      put(r.race_id, 'sanrenpuku', r.sanrenpuku, r.sanrenpuku_pay)
    }
  } catch { /* result_live がまだ無い＝当日取りを使っていない。Kファイルだけで進める */ }
  // Kファイル由来を後に入れて上書きする（こちらが正）
  for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
      WHERE bet_type IN ('sanrentan','sanrenpuku') AND amount IS NOT NULL
        AND race_id IN (${inq})`).iterate(...IDS))
    PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
  let kfile = 0
  for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
      WHERE rank_num BETWEEN 1 AND 3 AND race_id IN (${inq})`).iterate(...IDS)) {
    let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a); kfile++ }
    a[r.rank_num] = r.lane   // 当日取りの値があっても、Kファイルの値で上書きする
  }
  console.log(`未照合 ${IDS.length}レース　結果の元：当日取り ${live} ／ 競走成績のみ ${kfile}`)
  const upd = db.prepare(`UPDATE haishin_daily SET hit=?, payout=? WHERE race_id=? AND kind=? AND rank=?`)
  let n = 0, changed = 0
  db.exec('BEGIN')
  for (const r of rows) {
    const w = WIN.get(r.race_id)
    if (!w || !w[1] || !w[2] || !w[3]) continue     // 中止・失格などで3着まで揃わない
    const truth = r.kind === 'sanrentan' ? `${w[1]}-${w[2]}-${w[3]}` : [w[1], w[2], w[3]].sort().join('-')
    const hit = r.combo === truth ? 1 : 0
    const pay = hit ? (PAY.get(r.race_id + '|' + r.kind + '|' + r.combo) ?? null) : 0
    if (hit && pay == null) continue                 // 払戻がまだ入っていない
    if (r.hit != null && r.hit !== hit) changed++    // 速報と競走成績が食い違った
    upd.run(hit, pay, r.race_id, r.kind, r.rank); n++
  }
  db.exec('COMMIT')
  console.log(`埋めた ${n.toLocaleString()} / 対象だった ${rows.length.toLocaleString()}`)
  if (changed) console.log(`⚠ 速報と競走成績が食い違った行 ${changed}件（競走成績で上書き済み）`)
  db.close(); process.exit(0)
}

// ★ conf 列を後から足した回。空だったので作り直し済み（2026-08-31）。
const DATE = flag('date') || new Date().toISOString().slice(0, 10)
const f = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(f)) { console.error(`${f} がありません。先に predict.mjs --trio --json --out を走らせること`); process.exit(1) }
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

// ★3連単は「当てにいく3点＋穴1点」で組む（2026-08-31に本人の指定で変更）
//   穴＝上位3点に出てこない艇を1着に置く、いちばん確率の高い組。
//   オッズを使わないので朝に決まる。
//   本番モデルで実測（自信度0.7645以上・2,261レース）：
//     3点だけ    的中38.08%
//     穴1点      的中 4.25%・平均払戻1,743円・最高19,680円
//     4点合計    的中42.33%・回収84.8%
//   単純な上位4点なら的中45.73%なので、**的中を3.4pt落として大きい配当を狙う形**。
//   ⚠ 穴は中央値7位・上位90%で13位。predict.mjs が24点保存していないと拾えない。
const all = []
for (const r of (j.races ?? [])) {
  const fu = r.sanrenpuku ?? [], ta = r.sanrentan ?? []
  if (fu.length < PTS || ta.length < PTS) continue
  all.push({ r, conf: fu.slice(0, 4).reduce((a, b) => a + b.p, 0),
    fu: fu.slice(0, PTS), ta: ta.slice(0, PTS) })
}
// ★当日の記録では、締切を過ぎたレースを**足さない・書き換えない**。
//   2026-09-11 08:50 に作り直したら、08:44締切の鳴門1Rが新たに入った。
//   締切後に出した予想は誰も買えないので、記録に入れたら「後出し」になる。
//   ⚠ hit IS NULL のガード（下の upsert）だけでは足りない。締切後・結果前の
//     行はまだ hit が NULL なので、買い目が書き換わってしまう。
//   ⚠ 日付は toISOString(UTC) で比べないこと。深夜0〜9時に前日と判定される。
const _d = new Date()
const _today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
const _now = _d.toTimeString().slice(0, 5)
const late = (x) => DATE === _today && (DL.get(x.r.race_id) ?? '00:00') <= _now
const cand = all.filter((x) => x.conf >= CONF)
const skipped = cand.filter(late)
const picked = cand.filter((x) => !late(x)).sort((a, b) => b.conf - a.conf)
if (skipped.length) console.log(`締切を過ぎた ${skipped.length}レースは記録しない: ` +
  skipped.map((x) => `${x.r.venue}${x.r.race_no}R(${DL.get(x.r.race_id)})`).join(' '))
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
console.log(`${DATE}　全${all.length}レース中 ${picked.length}レースが対象（自信度 ${CONF} 以上）`)

if (argv.includes('--text')) {
  const TRIO_ONLY = NPT < PTS   // 点数を絞ったときは3連複だけの「プラン」として出す
  console.log('')
  for (const x of picked) {
    console.log(`【${x.r.venue}${x.r.race_no}R】締切 ${DL.get(x.r.race_id) ?? '-'}`)
    console.log(`  3連複  ${x.fu.slice(0, NPT).map((y) => y.combo.replace(/-/g, '=')).join('  ')}`)
    if (!TRIO_ONLY) console.log(`  3連単  ${x.ta.map((y) => y.combo).join('  ')}`)
    console.log('')
  }
  // ★2026-09-06に朝モデル（02:00に実在する入力だけ）へ入れ替えたので測り直した数字。
  //   旧モデルの 3連複82.6% / 3連単45.7% は、存在しない直前情報を平均値で埋めて出した値。
  if (TRIO_ONLY) {
    const [h, r] = REF[NPT]
    console.log(`※ 当てることを優先した予想です。過去の実測で3連複${NPT}点 ${h}。`)
    console.log(`※ 回収率は ${r} でマイナスです。買い続けると減ります。`)
    console.log(`※ 1レース${NPT * 100}円・1日${picked.length}レースなら ${picked.length * NPT * 100}円ぶん。`)
  } else {
    console.log('※ 当てることを優先した予想です。過去の実測で3連複4点 80.9%・3連単4点 44.1%。')
    console.log('※ 回収率はどちらもマイナス（3連複80.3%・3連単85.0%）。買い続けると減ります。')
  }
  db.close(); process.exit(0)
}

// ⚠ INSERT OR REPLACE にすると、再記録のたびに hit/payout が NULL に戻って
//   照合済みの結果が消える（2026-09-01に8/31の72点を消した）。
//   買い目の中身だけ入れ替えて、**結果は残す**。
const ins = db.prepare(`INSERT INTO haishin_daily
  (race_id,date,venue,race_no,deadline,conf,kind,rank,combo,p,ana,hit,payout,recorded_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
  ON CONFLICT(race_id,kind,rank) DO UPDATE SET
    date=excluded.date, venue=excluded.venue, race_no=excluded.race_no,
    deadline=excluded.deadline, conf=excluded.conf, combo=excluded.combo,
    p=excluded.p, ana=excluded.ana, recorded_at=excluded.recorded_at
  WHERE haishin_daily.hit IS NULL`)
// ⚠ 最後の WHERE を外さないこと。
//   結果が出た行の買い目を後から差し替えると、hit だけ前のまま残って
//   「この目で的中」と記録しつつ中身が別物、という嘘の記録になる。
//   走り終えたレースの予想は**歴史**なので、モデルを入れ替えても書き換えない。
const stamp = new Date().toISOString()
let n = 0
db.exec('BEGIN')
for (const x of picked) {
  const a = [x.r.race_id, DATE, x.r.venue, x.r.race_no, DL.get(x.r.race_id) ?? null, x.conf]
  x.ta.forEach((y, i) => { ins.run(...a, 'sanrentan', i + 1, y.combo, y.p, 0, stamp); n++ })
  x.fu.forEach((y, i) => { ins.run(...a, 'sanrenpuku', i + 1, y.combo, y.p, 0, stamp); n++ })
}
db.exec('COMMIT')
console.log(`記録 ${n}件（3連単${PTS}点・3連複${PTS}点 × ${picked.length}レース）`)
console.log(`文面:  node scripts/haishin.mjs --date ${DATE} --text`)
db.close()
