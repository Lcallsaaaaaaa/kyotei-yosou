// 特定の場の全レースを予想して記録する（GI・SGなどの単発企画用）。
//
//   node scripts/spot.mjs --date 2026-09-04 --jcd 9          その日の津の全レースを記録
//   node scripts/spot.mjs --date 2026-09-04 --jcd 9 --text   そのまま貼れる文面
//   node scripts/spot.mjs --fill --date 2026-09-04           結果を照合
//   node scripts/spot.mjs --report                           ためた分の成績
//
// ★通常の配信（haishin_daily）とは分ける
//   通常の配信は「自信度0.7645以上のレースだけ」を選んで出している。
//   こちらは**場を指定して全レース**出すので、当たりにくいレースも入る。
//   混ぜると配信の的中率が濁るので、テーブルも画面も別にする。
//   **/seiseki（配信の実績）には入れない。**
//
// ★中身は配信と同じ形
//   3連複4点＋3連単4点。確率の高い順。買い方を変えると比較できなくなる。
//
// ⚠ 全レース出すので的中率は下がる。絞りなしの実測は
//   3連複4点 63.70% / 3連単4点 30.53%（自信度で絞ると82.62% / 45.73%）。
//   企画物として出す前提で、通常配信の数字と並べて語らないこと。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const PTS = 4

db.exec(`
  CREATE TABLE IF NOT EXISTS spot_daily (
    race_id TEXT NOT NULL, date TEXT NOT NULL, jcd INTEGER, venue TEXT, race_no INTEGER,
    deadline TEXT, series TEXT, day_no INTEGER, conf REAL,
    kind TEXT NOT NULL, rank INTEGER NOT NULL, combo TEXT NOT NULL, p REAL,
    hit INTEGER, payout REAL, recorded_at TEXT,
    PRIMARY KEY (race_id, kind, rank)
  );
  CREATE INDEX IF NOT EXISTS idx_spot_date ON spot_daily(date);
`)

if (argv.includes('--report')) {
  const d = db.prepare(`SELECT COUNT(DISTINCT date) d, COUNT(DISTINCT race_id) r,
    COUNT(DISTINCT CASE WHEN hit IS NOT NULL THEN race_id END) done FROM spot_daily`).get()
  console.log(`企画（場指定）の実績：${d.d}日 / ${d.r}レース / 結果が出た ${d.done}レース`)
  if (!d.done) { db.close(); process.exit(0) }
  console.log('\n  券種   点数   的中     回収率')
  for (const [kind, nm] of [['sanrenpuku', '3連複'], ['sanrentan', '3連単']]) {
    for (const pts of [1, 2, 3, 4]) {
      const r = db.prepare(`SELECT COUNT(DISTINCT race_id) races, COUNT(*) bets,
        COUNT(DISTINCT CASE WHEN hit=1 THEN race_id END) hits,
        SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret
        FROM spot_daily WHERE kind=? AND rank<=? AND hit IS NOT NULL`).get(kind, pts)
      if (!r.bets) continue
      console.log(`  ${nm} ${String(pts).padStart(4)}点 ${String(r.hits).padStart(4)}/${r.races} ` +
        `(${(r.hits / r.races * 100).toFixed(1)}%) ${(r.ret / (r.bets * 100) * 100).toFixed(1).padStart(7)}%`)
    }
  }
  console.log('\n  ⚠ 全レース出しているので、配信（自信度で絞ったもの）の数字とは別。並べて語らないこと。')
  db.close(); process.exit(0)
}

if (argv.includes('--fill')) {
  const only = flag('date')
  const rows = only
    ? db.prepare(`SELECT race_id, kind, rank, combo FROM spot_daily WHERE hit IS NULL AND date=?`).all(only)
    : db.prepare(`SELECT race_id, kind, rank, combo FROM spot_daily WHERE hit IS NULL`).all()
  if (!rows.length) { console.log('照合するものなし'); db.close(); process.exit(0) }
  const IDS = [...new Set(rows.map((r) => r.race_id))]
  const inq = IDS.map(() => '?').join(',')
  const PAY = new Map(), WIN = new Map()
  const put = (rid, k, c, a) => { if (c && a != null) PAY.set(rid + '|' + k + '|' + c, a) }
  try {
    for (const r of db.prepare(`SELECT race_id, lane1, lane2, lane3, sanrentan, sanrentan_pay,
        sanrenpuku, sanrenpuku_pay FROM result_live WHERE status='ok' AND race_id IN (${inq})`).all(...IDS)) {
      WIN.set(r.race_id, { 1: r.lane1, 2: r.lane2, 3: r.lane3 })
      put(r.race_id, 'sanrentan', r.sanrentan, r.sanrentan_pay)
      put(r.race_id, 'sanrenpuku', r.sanrenpuku, r.sanrenpuku_pay)
    }
  } catch { /* result_live がまだ無い */ }
  for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
      WHERE bet_type IN ('sanrentan','sanrenpuku') AND amount IS NOT NULL AND race_id IN (${inq})`).all(...IDS))
    PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
  for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
      WHERE rank_num BETWEEN 1 AND 3 AND race_id IN (${inq})`).all(...IDS)) {
    let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
    a[r.rank_num] = r.lane
  }
  const upd = db.prepare(`UPDATE spot_daily SET hit=?, payout=? WHERE race_id=? AND kind=? AND rank=?`)
  let n = 0
  db.exec('BEGIN')
  for (const r of rows) {
    const w = WIN.get(r.race_id)
    if (!w || !w[1] || !w[2] || !w[3]) continue
    const truth = r.kind === 'sanrentan' ? `${w[1]}-${w[2]}-${w[3]}` : [w[1], w[2], w[3]].sort().join('-')
    const hit = r.combo === truth ? 1 : 0
    const pay = hit ? (PAY.get(r.race_id + '|' + r.kind + '|' + r.combo) ?? null) : 0
    if (hit && pay == null) continue
    upd.run(hit, pay, r.race_id, r.kind, r.rank); n++
  }
  db.exec('COMMIT')
  console.log(`埋めた ${n} / 対象 ${rows.length}`)
  db.close(); process.exit(0)
}

// ---------- 記録 ----------
const DATE = flag('date') || new Date().toISOString().slice(0, 10)

// ★--auto ＝ その日のグレードレースを自動で拾う（毎日2時のバッチはこれを使う）
//   対象は G1・SG・G2 だけ。G3は1号艇のA1率が13〜21%で一般戦(20.9%)と同水準なので
//   「グレードレース」として分ける意味がない（SG/G1は98.5%・G2は76.7%）。
//
// ⚠ races.grade は使えない。races は競走成績(Kファイル)から作られるので
//   **まだ走っていない当日のレコードが存在しない**（最初 races を見る作りにして、
//   当日が必ず「開催なし」になった。2026-09-06に津のG1を取り逃した）。
//   判定は**開催名(series)**から行う。番組表は前日に出るので当日でも当日朝でも引ける。
//   同じ判定を grade.mjs が過去分にかけており、1号艇のA1率で検算済み。
const GRADES = ['SG', 'G1', 'G2']
/** 開催名からグレードを見る。grade.mjs の判定と揃えること */
function gradeOf(series) {
  const s = String(series ?? '')
  if (!s) return null
  // SG＝賞金王・グランプリ・オールスター・記念以外の全国大会
  if (/グランプリ|賞金王|オールスター|笹川賞|ダービー|クラシック|オーシャンカップ|メモリアル/.test(s)) return 'SG'
  // G1＝周年記念・地区選手権・女子G1 など
  if (/周年記念|地区選手権|女子リーグ|クイーンズクライマックス|マスターズチャンピオン|レディースチャンピオン/.test(s)) return 'G1'
  if (/モーターボート大賞|G2|ＧⅡ/.test(s)) return 'G2'
  return null
}
if (argv.includes('--auto')) {
  // まず番組表から当日の開催と開催名を拾う（当日でも引ける）
  // ⚠ programs に jcd 列は無い。race_id が「YYYYMMDD-JJ-RR」なので切り出す。
  const cand = db.prepare(`SELECT DISTINCT CAST(substr(race_id,10,2) AS INTEGER) jcd
    FROM programs WHERE substr(race_id,1,8)=?`).all(DATE.replace(/-/g, '')).map((r) => r.jcd)
  const rows = []
  for (const jcd of cand) {
    // 開催名は races に無いことがあるので、予想JSONから取る
    const sj = join(ROOT, 'data', `predict-${DATE}.json`)
    let series = null
    if (existsSync(sj)) {
      const jj = JSON.parse(readFileSync(sj, 'utf8'))
      series = (jj.races ?? []).find((r) => r.jcd === jcd)?.series ?? null
    }
    if (!series) series = db.prepare(`SELECT series FROM races WHERE date=? AND jcd=? LIMIT 1`).get(DATE, jcd)?.series ?? null
    const g = gradeOf(series)
    if (!g || !GRADES.includes(g)) continue
    // ★開催名だけでは誤判定する。「あきんど倶楽部30周年記念杯」は団体の周年で一般戦だった
    //   （2026-09-05に実際に拾ってしまった）。grade.mjs と同じく**1号艇のA1率**で検算する。
    //   実測ではSG/G1が98.5%、G3以下と一般は13〜21%と綺麗に分かれる。
    const a1 = db.prepare(`SELECT
      SUM(CASE WHEN grade='A1' THEN 1 ELSE 0 END) a1, COUNT(*) n
      FROM programs WHERE substr(race_id,1,8)=? AND substr(race_id,10,2)=? AND lane=1`)
      .get(DATE.replace(/-/g, ''), String(jcd).padStart(2, '0'))
    const rate = a1 && a1.n ? a1.a1 / a1.n : 0
    if (rate < 0.6) {
      console.log(`  （除外）${series} … 1号艇のA1率 ${(rate * 100).toFixed(0)}% で格上ではない`)
      continue
    }
    rows.push({ jcd, grade: g, series, a1: rate })
  }
  if (!rows.length) { console.log(`${DATE} はグレードレース(${GRADES.join('/')})の開催なし`); db.close(); process.exit(0) }
  const { spawnSync } = await import('node:child_process')
  for (const r of rows) {
    console.log(`--- ${r.grade}　${r.series ?? ''}（jcd=${r.jcd}）---`)
    // ⚠ import.meta.url は日本語パスを%エンコードするので、URLのpathnameをそのまま渡すと
    //   モジュールが見つからない。必ず fileURLToPath を通すこと（実際に踏んだ）。
    const a = spawnSync(process.execPath, [fileURLToPath(import.meta.url),
      '--date', DATE, '--jcd', String(r.jcd),
      // --from は子プロセスにも渡す（渡さないと --auto のときだけ時刻の絞りが効かない）
      ...(argv.includes('--from') ? ['--from', argv[argv.indexOf('--from') + 1]] : [])], { encoding: 'utf8' })
    process.stdout.write(a.stdout || '')
    if (a.status !== 0) process.stderr.write(a.stderr || '')
  }
  db.close(); process.exit(0)
}

const JCD = Number(flag('jcd'))
if (!JCD) { console.error('--jcd を指定するか --auto を使うこと（例: 津=9）'); process.exit(1) }
const f = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(f)) { console.error(`${f} がありません`); process.exit(1) }
const j = JSON.parse(readFileSync(f, 'utf8'))
const races = (j.races ?? []).filter((r) => r.jcd === JCD)
if (!races.length) { console.error(`${DATE} に jcd=${JCD} の開催がありません`); process.exit(1) }

const DL = new Map()
// ★締切の取り方（2026-09-21に直した）
//   以前は races に1件でもあれば公式から取らなかった。9/21は15時の処理で当日の races に
//   156レース中25件だけ入っていて、残り131レースの締切が不明のまま「99:99＝まだ先」扱いになり、
//   15:41に走った朝バッチが**締切後のレースまで記録した**。
//   → races・race_meta・公式の順に、レースごとに足りない分を埋める。
//   → それでも分からない当日のレースは「締切済み」とみなして記録しない（下の late / early）。
for (const r of db.prepare(`SELECT race_id, deadline FROM races WHERE date=?`).all(DATE)) if (r.deadline) DL.set(r.race_id, r.deadline)
try { for (const r of db.prepare(`SELECT race_id, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL`).all(DATE)) if (!DL.get(r.race_id)) DL.set(r.race_id, r.deadline) } catch { /* race_meta がまだ無い */ }
if ((races).some((r) => !DL.get(r.race_id))) {   // 足りないレースがあれば公式から取る
  const S = await import('./strategy.mjs')
  const M = await S.deadlines(DATE.replace(/-/g, ''), [JCD])
  for (const r of races) { const d = M.get(JCD)?.[r.race_no - 1]; if (d) DL.set(r.race_id, d) }
}

const picks = []
for (const r of races) {
  const fu = r.sanrenpuku ?? [], ta = r.sanrentan ?? []
  if (fu.length < PTS || ta.length < PTS) continue
  picks.push({ r, conf: fu.slice(0, 4).reduce((a, b) => a + b.p, 0), fu: fu.slice(0, PTS), ta: ta.slice(0, PTS) })
}
picks.sort((a, b) => a.r.race_no - b.r.race_no)
// ★当日の記録では、締切を過ぎたレースを**足さない・書き換えない**（haishin/tansho と同じ）。
//   締切後に出した予想は誰も買えない。hit IS NULL のガードでは締切後・結果前の行を守れない。
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
if (argv.includes('--text')) {
  const h = picks[0]?.r
  console.log(`${DATE}　${h?.venue ?? ''}　${h?.series ?? ''}（${h?.day_no ?? '-'}日目）　全${picks.length}レース\n`)
  for (const x of picks) {
    console.log(`【${x.r.venue}${x.r.race_no}R】締切 ${DL.get(x.r.race_id) ?? '-'}　自信度 ${(x.conf * 100).toFixed(0)}`)
    console.log(`  3連複  ${x.fu.map((y) => y.combo.replace(/-/g, '=')).join('  ')}`)
    console.log(`  3連単  ${x.ta.map((y) => y.combo).join('  ')}`)
    console.log('')
  }
  console.log('※ 場を指定した全レース予想です。当たりにくいレースも含みます。')
  console.log('※ 通常の配信（自信度で絞ったもの）とは別枠で、実績にも入れていません。')
  db.close(); process.exit(0)
}

// ⚠ 再記録で hit/payout を消さないこと（haishin側で実際に消した）
const ins = db.prepare(`INSERT INTO spot_daily
  (race_id,date,jcd,venue,race_no,deadline,series,day_no,conf,kind,rank,combo,p,hit,payout,recorded_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
  ON CONFLICT(race_id,kind,rank) DO UPDATE SET
    date=excluded.date, deadline=excluded.deadline, series=excluded.series,
    day_no=excluded.day_no, conf=excluded.conf, combo=excluded.combo,
    p=excluded.p, recorded_at=excluded.recorded_at
  WHERE spot_daily.hit IS NULL`)
// ⚠ 最後の WHERE を外さないこと。
//   結果が出た行の買い目を後から差し替えると、hit だけ前のまま残って
//   「この目で的中」と記録しつつ中身が別物、という嘘の記録になる。
//   走り終えたレースの予想は**歴史**なので、モデルを入れ替えても書き換えない。
const stamp = new Date().toISOString()
let n = 0
db.exec('BEGIN')
for (const x of picks) {
  const a = [x.r.race_id, DATE, JCD, x.r.venue, x.r.race_no, DL.get(x.r.race_id) ?? null,
    x.r.series ?? null, x.r.day_no ?? null, x.conf]
  x.ta.forEach((y, i) => { ins.run(...a, 'sanrentan', i + 1, y.combo, y.p, stamp); n++ })
  x.fu.forEach((y, i) => { ins.run(...a, 'sanrenpuku', i + 1, y.combo, y.p, stamp); n++ })
}
db.exec('COMMIT')
console.log(`${DATE}　${picks[0].r.venue}　${picks[0].r.series ?? ''}（${picks[0].r.day_no ?? '-'}日目）`)
console.log(`記録 ${n}件（3連単${PTS}点・3連複${PTS}点 × ${picks.length}レース）`)
console.log(`文面:  node scripts/spot.mjs --date ${DATE} --jcd ${JCD} --text`)
db.close()
