// 買い方の「型」ごとの買い目を、その日のぶんだけ記録する。
//
//   node scripts/patterns.mjs                     今日ぶん
//   node scripts/patterns.mjs --date 2026-10-05
//   node scripts/patterns.mjs --dry               記録せずに何が出るかだけ見る
//   node scripts/patterns.mjs --report            貯まった実績を集計する
//
// ★なにを出すか（2026-10-06・実測にもとづく設計）
//   同じモデルから、狙いの違う買い目を出し分ける。
//   **レースの性格（自信度）で出す型を変える**のが要点。
//   全レースに5つ並べるのは間違いで、大穴を自信度の高いレースに出すと
//   回収が 83.6% → 57.3% に壊れる（本命が来るレースで本命を外す券になる）。
//
//   歩進検証45,340レースの実測（前半/後半）：
//
//   ■ 自信度の上位50%に出す型（22,669レース）
//     本命 3連単4点   的中 36.4/37.9%　回収 83.9/83.7%　平均  902円　最高  6,710円
//     本命 3連複4点   的中 71.4/73.6%　回収 80.0/81.2%　平均  445円　最高  4,510円
//     堅実 3連複2点   的中 49.1/50.7%　回収 82.7/82.6%　平均  331円　最高  1,970円
//   ■ 自信度の下位50%に出す型（22,671レース）
//     大穴 3連単4点   的中  4.4/ 4.5%　回収 83.6/85.2%　平均7,592円　最高110,690円
//                     万舟（1万円以上）が 113レースに1回
//     中穴 3連単4点   的中  8.6/ 8.9%　回収 74.6/76.0%　平均3,441円　最高 36,710円
//
//   ★固い型の範囲を上位10%→上位50%に広げた（2026-10-06 本人判断）
//     上位10%（1日15本）だと**穴の型ばかり出てきて固い型がめったに出ない**。
//     広げても前半後半とも揃っていて、3連複と堅実はむしろ回収が上がる：
//       本命3連単 87.9/86.5% → 83.9/83.7%（的中は45%→36%に下がる）
//       本命3連複 78.5/77.5% → 80.0/81.2%
//       堅実      84.6/84.7% → 82.7/82.6%
//     ⚠ 広げたぶん**的中率は下がる**。画面の数字も入れ替えること（api.mjs の META）。
//
//   ⚠ 中穴は全型の最下位（74〜76%）。大穴と同じレースに出して回収が9pt低い。
//     「中間の選択肢」としてだけ残している。やめる判断もあり。
//   ⚠ **どの型も回収100%未満**。控除率25%の床（[[boatrace-hitrate-vs-roi]]）。
//     画面に出すときは的中率と回収率を必ず並べること。最高配当だけ出すのは不誠実。
//
// ★自信度 = 3連複の上位4組の確率の合計。
//   足切りは **本番側（pred3）の分位点** で出す（[[boatrace-model-vs-walk]]）。
//   検証側（wi3）の 0.8273 を流用しないこと。本番は確率の鋭さが違う。
//
// ★記録の決まり（haishin.mjs と同じ）
//   ・締切を過ぎたレースは足さない・書き換えない（後出しになる）
//   ・結果が出た行（hit が入っている行）は書き換えない（歴史なので）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DRY = argv.includes('--dry')
const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const DATE = flag('date', TODAY)

// ★足切りは本番側（pred3・4,211レース）の分位点で出した（2026-10-06）。
//   検証側（wi3）の値を流用しないこと。確率の鋭さが違って本数がずれる
//   （[[boatrace-model-vs-walk]]）。本番側の分位点：
//     下から10% 0.4687 ／ 25% 0.5423 ／ 50% 0.6151 ／ 75% 0.6991 ／ 90% 0.7672
//   上位10%の境目 0.7672 は haishin.mjs の 0.7645 とほぼ同じ＝物差しが合っている。
// ★★振り分けは「本命の1着確率」で決める（2026-10-09に自信度から変更）
//   ⚠ 自信度は「**3着までを絞り込めるか**」の目安で、「**1着が堅いか**」ではない。
//     そのせいで画面の中で言っていることが食い違った。実機で見つけた実例
//     （鳴門12R・2026-10-09）：
//       展開予想：「イン逃げ濃厚」本線は1号艇 逃げ 85.8%
//       AI予想  ：「このレースは荒れやすいとみています」＋**本命を外す**大穴
//     1着確率85.8%でも2着3着が割れていれば自信度は0.54にしかならない。
//     **同じページで矛盾したことを言う＝商品として成立しない。**
//
//   本命の1着確率なら、画面に出ている「本線 X号艇 NN%」と同じ物差しなので
//   食い違いようがない。歩進検証45,340レースで測り直すと全部が前後で揃う：
//     本命 3連単4点（55%以上・25,965）的中 35.5/36.5%　回収 82.1/81.6%　平均  909円
//     本命 3連複4点（55%以上）        的中 65.5/66.6%　回収 79.5/79.8%　平均  483円
//     堅実 3連複2点（55%以上）        的中 43.5/44.2%　回収 81.3/81.1%　平均  370円
//     中穴 3連単4点（55%未満・19,375）的中 14.1/14.1%　回収 78.8/80.8%　平均2,258円
//     大穴 3連単4点（55%未満）        的中  6.1/ 6.5%　回収 79.7/76.8%　平均4,952円
//   自信度で振り分けると、大穴は本命が堅い帯で**的中1.2%・回収66〜99%**と暴れていた
//   （当たりが稀すぎて数字が意味を持たない）。測り直しは scripts/oana-split.mjs。
const FAV_HI = Number(flag('fav', '0.55'))   // 本命の1着確率がこれ以上＝堅い型

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 30000')
db.exec(`CREATE TABLE IF NOT EXISTS patterns_daily (
  race_id TEXT NOT NULL, date TEXT NOT NULL, venue TEXT, race_no INTEGER, deadline TEXT,
  conf REAL,
  pattern TEXT NOT NULL,       -- honmei_tan / honmei_fuku / kenjitsu / chuana / oana
  kind TEXT NOT NULL,          -- sanrentan / sanrenpuku
  rank INTEGER NOT NULL, combo TEXT NOT NULL, p REAL,
  hit INTEGER, payout REAL, recorded_at TEXT,
  PRIMARY KEY (race_id, pattern, rank))`)
db.exec('CREATE INDEX IF NOT EXISTS idx_patterns_daily_date ON patterns_daily(date)')

// ---------- 集計 ----------
if (argv.includes('--report')) {
  const LABEL = { honmei_tan: '本命 3連単4点', honmei_fuku: '本命 3連複4点',
    kenjitsu: '堅実 3連複2点', chuana: '中穴 3連単4点', oana: '大穴 3連単4点' }
  const rows = db.prepare(`SELECT pattern, race_id, rank, hit, payout FROM patterns_daily
    WHERE hit IS NOT NULL ORDER BY pattern, race_id, rank`).all()
  const span = db.prepare('SELECT MIN(date) a, MAX(date) b, COUNT(DISTINCT date) d, COUNT(DISTINCT race_id) r FROM patterns_daily').get()
  console.log(`■ 型ごとの実績　${span.a} 〜 ${span.b}（${span.d}日・${span.r}レース）`)
  if (!rows.length) { console.log('  まだ結果の出た記録がありません（夜のバッチの後にもう一度）'); db.close(); process.exit(0) }
  const g = new Map()
  for (const r of rows) {
    const k = r.pattern + '|' + r.race_id
    if (!g.has(k)) g.set(k, { pattern: r.pattern, n: 0, hit: 0, ret: 0 })
    const x = g.get(k); x.n++
    if (r.hit) { x.hit = 1; x.ret = Math.max(x.ret, r.payout ?? 0) }
  }
  const agg = new Map()
  for (const x of g.values()) {
    if (!agg.has(x.pattern)) agg.set(x.pattern, { races: 0, bets: 0, hit: 0, ret: 0, best: 0, man: 0 })
    const a = agg.get(x.pattern)
    a.races++; a.bets += x.n; a.hit += x.hit; a.ret += x.ret
    if (x.ret > a.best) a.best = x.ret
    if (x.ret >= 10000) a.man++
  }
  console.log('')
  console.log('  型              レース   的中      回収      平均配当    最高配当   万舟')
  for (const [p, a] of agg) {
    const avg = a.hit ? a.ret / a.hit : 0
    console.log(`  ${(LABEL[p] ?? p).padEnd(16)}${String(a.races).padStart(5)}  `
      + `${(a.hit / a.races * 100).toFixed(1).padStart(5)}%  `
      + `${(a.ret / (a.bets * 100) * 100).toFixed(1).padStart(6)}%  `
      + `${Math.round(avg).toLocaleString().padStart(8)}円  ${a.best.toLocaleString().padStart(8)}円  `
      + (a.man ? `${Math.round(a.races / a.man)}レースに1回` : '―'))
  }
  console.log('')
  console.log('※ 検証値は patterns.mjs の冒頭。ここは**前向きの実測**なので、ずれたら検証値を疑う')
  db.close(); process.exit(0)
}

// ---------- 予想を読む ----------
const F = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(F)) { console.log(`${F} がありません（朝のバッチがまだ）`); db.close(); process.exit(0) }
const j = JSON.parse(readFileSync(F, 'utf8'))

// 締切
const DL = new Map()
for (const r of db.prepare('SELECT race_id, deadline FROM races WHERE date=?').all(DATE))
  if (r.deadline) DL.set(r.race_id, r.deadline)
try {
  for (const r of db.prepare('SELECT race_id, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL').all(DATE))
    if (!DL.get(r.race_id)) DL.set(r.race_id, r.deadline)
} catch { /* race_meta がまだ無い */ }

const parts = (c) => c.split('-').map(Number)
const toFuku = (c) => parts(c).slice().sort((a, b) => a - b).join('-')

// ---------- 型の定義 ----------
// 同じ確率表から選ぶ。違うのは**どこを狙うか**だけ。
const PATTERNS = [
  ['honmei_tan', '本命 3連単4点', 'sanrentan', 'hi', (ta) => ta.slice(0, 4)],
  ['honmei_fuku', '本命 3連複4点', 'sanrenpuku', 'hi', (ta, fu) => fu.slice(0, 4)],
  ['kenjitsu', '堅実 3連複2点', 'sanrenpuku', 'hi', (ta, fu) => fu.slice(0, 2)],
  ['chuana', '中穴 3連単4点', 'sanrentan', 'lo', (ta) => {
    // いちばん確率の高い艇を1着から外し、2着か3着に置いた組だけ
    const top = parts(ta[0].combo)[0]
    return ta.filter((x) => { const [a, b, c] = parts(x.combo); return a !== top && (b === top || c === top) }).slice(0, 4)
  }],
  ['oana', '大穴 3連単4点', 'sanrentan', 'lo', (ta) => {
    const top = parts(ta[0].combo)[0]
    return ta.filter((x) => !parts(x.combo).includes(top)).slice(0, 4)
  }],
]

// ---------- レースごとに型を決める ----------
const _now = now.toTimeString().slice(0, 5)
const late = (rid) => DATE === TODAY && (DL.get(rid) ?? '00:00') <= _now

const out = []
let skipped = 0, noConf = 0
for (const r of (j.races ?? [])) {
  const ta = r.sanrentan ?? [], fu = r.sanrenpuku ?? []
  if (ta.length < 4 || fu.length < 4) { noConf++; continue }
  if (late(r.race_id)) { skipped++; continue }
  const conf = fu.slice(0, 4).reduce((a, b) => a + b.p, 0)   // 記録には残す（見比べ用）
  // ★本命の1着確率で振り分ける。画面の「本線 X号艇 NN%」と同じ物差し
  const fav = (r.first ?? []).slice().sort((a, b) => b.p - a.p)[0]
  if (!fav) { noConf++; continue }
  const zone = fav.p >= FAV_HI ? 'hi' : 'lo'
  for (const [key, label, kind, want, pick] of PATTERNS) {
    if (want !== zone) continue
    const buy = pick(ta, fu)
    if (!buy?.length) continue
    // 3連複の型は組を昇順に直して出す
    const combos = kind === 'sanrenpuku' ? buy.map((x) => ({ combo: toFuku(x.combo), p: x.p })) : buy
    out.push({ r, conf, fav: fav.p, key, label, kind, combos })
  }
}

const races = new Set(out.map((x) => x.r.race_id)).size
console.log(`${DATE}　型つきの買い目 ${races}レース（本命の1着確率 ${(FAV_HI * 100).toFixed(0)}%以上＝堅い型／未満＝穴の型）`)
if (skipped) console.log(`  締切を過ぎた ${skipped}レースは記録しません（後出しになる）`)
if (noConf) console.log(`  買い目が足りない ${noConf}レースは対象外`)

if (DRY || argv.includes('--text')) {
  const byRace = new Map()
  for (const x of out) {
    if (!byRace.has(x.r.race_id)) byRace.set(x.r.race_id, [])
    byRace.get(x.r.race_id).push(x)
  }
  for (const [rid, xs] of byRace) {
    const r = xs[0].r
    console.log('')
    console.log(`【${r.venue}${r.race_no}R】締切 ${DL.get(rid) ?? '-'}　自信度 ${xs[0].conf.toFixed(4)}`)
    for (const x of xs) console.log(`  ${x.label.padEnd(14)}${x.combos.map((y) => y.combo).join(' / ')}`)
  }
  console.log('')
  console.log(DRY ? '--dry なので記録しません' : '')
  db.close(); process.exit(0)
}

// ---------- 記録 ----------
// ⚠ 結果が出た行（hit が入っている行）は書き換えない。haishin.mjs と同じ決まり。
const ins = db.prepare(`INSERT INTO patterns_daily
  (race_id,date,venue,race_no,deadline,conf,pattern,kind,rank,combo,p,hit,payout,recorded_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
  ON CONFLICT(race_id,pattern,rank) DO UPDATE SET
    date=excluded.date, venue=excluded.venue, race_no=excluded.race_no,
    deadline=excluded.deadline, conf=excluded.conf, kind=excluded.kind,
    combo=excluded.combo, p=excluded.p, recorded_at=excluded.recorded_at
  WHERE patterns_daily.hit IS NULL`)
const stamp = new Date().toISOString()
let n = 0
db.exec('BEGIN')
for (const x of out) {
  const a = [x.r.race_id, DATE, x.r.venue, x.r.race_no, DL.get(x.r.race_id) ?? null, x.conf, x.key, x.kind]
  x.combos.forEach((y, i) => { ins.run(...a, i + 1, y.combo, y.p, stamp); n++ })
}
db.exec('COMMIT')
console.log(`記録 ${n}件（${races}レース）`)
console.log(`中身を見る:  node scripts/patterns.mjs --date ${DATE} --text`)
console.log(`実績を見る:  node scripts/patterns.mjs --report`)
db.close()
