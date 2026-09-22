// これから走るレースを予想する。
//
//   node scripts/predict.mjs --date 2026-08-19            その日の全レース
//   node scripts/predict.mjs --date 2026-08-19 --jcd 12   場を絞る
//   node scripts/predict.mjs --date 2026-08-19 --buy      買い目だけ出す
//
// ★過去の検証と何が違うか
//   feat テーブルは「結果のあるレース」からしか作れない。
//   これから走るレースには結果が無いので、同じ集計を番組表から作り直す必要がある。
//   ここでは全履歴を日付順に積み上げ、対象日の直前の状態を特徴量として使う。
//
// ★締切前に分からないものは使わない
//   進入コースは締切後にしか決まらないので**枠番**を使う。
//   実際の進入と枠番が一致するのは約85%。実進入を使うと成績が実際より良く出る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DATE = flag('date')
const JCD = flag('jcd') ? Number(flag('jcd')) : null
const BUYONLY = argv.includes('--buy')
// ★学習時と同じ特徴量で予想する（2026-09-14から既定）。--legacy-serve で修正前の作り方に戻せる（比較用）。
//   修正前は ①過去成績を2022-08-18から全部数えていた（学習は2025-08-18から）
//            ②条件補正のうち hour/len/left/lenday を「不明」、title を全部「予選」で渡していた
//   9/7〜9/13 の1,020レース（新モデルの学習外）を両方で予想して実際の結果で比べた：
//     1着logloss 1.1683→1.1457（日単位ブートストラップで改善確率100%）・1着的中は差なし
//     無料枠 予想86.0%→実際81.6% が 84.8%→83.0%・回収94.9%→95.5%
//     配信 23.6R/日→13.3R/日・3連複4点 81.8%→89.2%・3連単4点 42.4%→51.6%
const MATCH_TRAIN = !argv.includes('--legacy-serve')
// ★--dump-feats パス … 採点直前の特徴量をJSONで書き出す（学習側 feat テーブルとの突き合わせ用）
const DUMP_FEATS = flag('dump-feats')
// ★--hist-lag N … 対象日の直前 N 日ぶんの結果を使わない（2026-09-14追加・検証用）。
//   02:00 の時点では前日の結果（Kファイル）がまだ無い。06:00 以降は入っていることがある。
//   その差だけを取り出して「2時の予想と6時の予想のどちらが当たるか」を過去日で測るために使う。
const HIST_LAG = Number(flag('hist-lag') ?? 0)
if (!DATE) { console.error('--date 2026-08-19 が必要'); process.exit(1) }
const HIST_TO = (() => { const t = new Date(DATE + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - HIST_LAG); return t.toISOString().slice(0, 10) })()

// ★モデルは2本ある。レースごとに使い分ける（2026-09-06）。
//   model5.json      … 朝モデル。02:00に実在する入力だけで学習（bf_* と波・風なし）
//   model5-full.json … フルモデル。直前情報と波・風も使う
//
//   なぜ2本要るか:
//     predict.mjs は無い項目を**学習時の平均値**で埋める（下の vecOf）。
//     フルモデル1本だけだと、展示が出ていない朝の時点で「平均的な展示だった・
//     平均的な波だった」ことにして予想することになり、高確率帯の確率が過大になる。
//     実際それで検証96.3%に対し前向き実測86.5%まで落ちた。
//   朝モデル1本だけにすると、今度は直前情報が取れている場面でそれを捨てることになる。
//   だから**そのレースに実際に直前情報があるかどうか**で選ぶ。開催名や時刻では決めない。
const loadModel = (p) => {
  const M = JSON.parse(readFileSync(p, 'utf8'))
  return { M, D: M.names.length, W: M.w.map((a) => Float64Array.from(a)),
    mean: Float64Array.from(M.mean), sd: Float64Array.from(M.sd),
    enc: Object.fromEntries(M.xtypes.map((t) => [t, new Map(M.encoders[t])])),
    XOFF: M.xoff }
}
const MORN = loadModel(join(ROOT, 'data', 'model5.json'))
const FULLP = join(ROOT, 'data', 'model5-full.json')
const FULL = existsSync(FULLP) ? loadModel(FULLP) : null
const M = MORN.M          // 番組表の項目名など、モデル共通のものはこちらを見る
const featIdx = new Map(M.featCols.map((c, i) => [c, i]))
console.log(`モデル: 朝 ${MORN.D}項目 / 学習は ${M.trainedTo} まで` +
  (FULL ? `　＋ 直前情報あり用 ${FULL.D}項目` : '　（直前情報あり用は未作成）'))

const VENUE = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国',
  'びわこ', '住之江', '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

// 支部と開催場の対応（地元判定）。学習側と同じ表を使うこと。
const BRANCH_JCD = { 群馬: 1, 埼玉: 2, 東京: 3, 静岡: 6, 愛知: 7, 三重: 9, 福井: 10, 滋賀: 11,
  大阪: 12, 兵庫: 13, 徳島: 14, 香川: 15, 岡山: 16, 広島: 17, 山口: 18, 福岡: 22, 佐賀: 23, 長崎: 24 }

// 期別成績。★レース月より厳密に前の期だけを使う（同月の期はまだ公表されていない可能性がある）
const PERIODS = new Map()
for (const r of all(`SELECT period, racer_id, sex, height, win_rate, top2_rate, starts
  FROM racer_period ORDER BY racer_id, period`)) {
  let a = PERIODS.get(r.racer_id); if (!a) { a = []; PERIODS.set(r.racer_id, a) }
  a.push(r)
}
const periodOf = (id, date) => {
  const a = PERIODS.get(id); if (!a) return null
  const ym = date.slice(0, 7)
  let best = null
  for (const x of a) { if (x.period < ym) best = x; else break }
  return best
}

// ---------- 履歴を積み上げて、対象日の直前の状態を作る ----------
// derive.mjs と同じ積み上げ方。ここでは対象日より前の結果だけを使う。
const PTS = [0, 10, 8, 6, 4, 2, 1]
const mk = () => ({ n: 0, w1: 0, w2: 0, w3: 0, pt: 0, st: 0, stn: 0, ex: 0, exn: 0 })
const bump = (a, rank, st, ex) => {
  a.n++
  if (rank >= 1 && rank <= 6) { a.pt += PTS[rank]; if (rank === 1) a.w1++; if (rank <= 2) a.w2++; if (rank <= 3) a.w3++ }
  if (st != null && st > 0) { a.st += st; a.stn++ }
  if (ex != null && ex > 0) { a.ex += ex; a.exn++ }
}
const gk = (m, k) => { let v = m.get(k); if (!v) { v = mk(); m.set(k, v) } return v }
const R = (a, pfx, o) => {
  if (!a || !a.n) return
  o[`${pfx}_n`] = a.n; o[`${pfx}_p1`] = a.w1 / a.n; o[`${pfx}_p2`] = a.w2 / a.n
  o[`${pfx}_p3`] = a.w3 / a.n; o[`${pfx}_sho`] = a.pt / a.n
  if (a.stn) o[`${pfx}_st`] = a.st / a.stn
  if (a.exn) o[`${pfx}_ex`] = a.ex / a.exn
}
const waveBk = (w) => (w == null ? 'x' : w <= 2 ? 'a' : w <= 5 ? 'b' : w <= 9 ? 'c' : 'd')
const windBk = (w) => (w == null ? 'x' : w <= 1 ? 'a' : w <= 3 ? 'b' : w <= 5 ? 'c' : 'd')
const rnoBk = (r) => (r <= 4 ? 'a' : r <= 8 ? 'b' : 'c')
// ★条件補正のキー。model5.mjs の hourBk / XKEY の title と**まったく同じ作り**にすること。
//   食い違うと、学習した補正値と違う値を引いてしまう（2026-09-14に実際にそうなっていた）。
const hourBk = (t) => { const m = String(t ?? '').match(/^(\d{1,2}):/); return m ? m[1] : 'x' }
const titleKey = (s0) => {
  const s = String(s0 ?? '')
  const f = []
  if (/優勝戦/.test(s) && !/準優/.test(s)) f.push('yusho')
  if (/準優/.test(s)) f.push('junyu')
  if (/予選/.test(s)) f.push('yosen')
  if (/ドリーム/.test(s)) f.push('dream')
  if (/選抜/.test(s)) f.push('senbatsu')
  if (/特選|特賞/.test(s)) f.push('tokusen')
  if (/進入固定/.test(s)) f.push('shinnyukotei')
  if (!f.length) f.push('ippan')
  return ['yusho', 'junyu', 'dream', 'senbatsu', 'tokusen', 'shinnyukotei', 'yosen', 'ippan'].find((x) => f.includes(x))
}
const hourOf = (t) => { const m = String(t ?? '').match(/^(\d{1,2}):/); return m ? Number(m[1]) : null }

const lastDay = new Map()
for (const r of all(`SELECT jcd, series, MAX(day_no) d FROM races WHERE series IS NOT NULL GROUP BY jcd, series`))
  lastDay.set(`${r.jcd}:${r.series}`, r.d)

const P = new Map(), MO = new Map(), BO = new Map()
const newP = () => ({ all: mk(), course: new Map(), venue: new Map(), venueCourse: new Map(), grade: new Map(),
  wave: new Map(), wind: new Map(), rno: new Map(), hour: new Map(), day: new Map(), nami5: mk(),
  kimete: new Map(), yarare: new Map(), recent: [], f: 0, l: 0, dq: 0,
  entrySum: 0, entryN: 0, wakunari: 0, series: null })
const getP = (id) => { let v = P.get(id); if (!v) { v = newP(); P.set(id, v) } return v }
const getM = (j, n) => { const k = `${j}:${n}`; let v = MO.get(k); if (!v) { v = { all: mk(), course: new Map(), recent: [] }; MO.set(k, v) } return v }
const getB = (j, n) => { const k = `${j}:${n}`; let v = BO.get(k); if (!v) { v = mk(); BO.set(k, v) } return v }

const _t0=Date.now()
// ★履歴を数え始める日を、学習側（derive.mjs が feat を作った起点）に揃える（既定。--legacy-serve で旧挙動）。
//   2026-09-14に判明：derive.mjs は 2025-08-18 から数え、ここは 2022-08-18 から全部数えていた。
//   同じ艇で all_n が 学習側180走 ／ ここ788走（＝実際の出走数そのもの）。
//   モデルは「1年分の成績」で学習したのに、本番では「4年分の成績」を入れて予想していた。
//   特徴量のずれの約8割がこの「回数」系の項目（all_n・grade_n・コース別・モーター・ボート等）。
//   起点は feat テーブルの最古日から取るので、derive.mjs の --from を変えても自動で揃う。
const HIST_FROM = MATCH_TRAIN
  ? all(`SELECT MIN(r.date) d FROM feat f JOIN races r ON r.race_id = f.race_id`)[0].d
  : '0000-00-00'
console.log('履歴を積み上げ中...' + (MATCH_TRAIN ? `（${HIST_FROM} から。学習側と同じ起点）` : ''))
const hist = all(`
  SELECT e.race_id, e.lane, e.racer_id, e.rank_num, e.course, e.st, e.exhibition,
         e.motor_no, e.boat_no, e.st_flag,
         r.date, r.jcd, r.race_no, r.grade, r.wave, r.wind_speed, r.deadline, r.day_no, r.series, r.kimarite
  FROM entries e JOIN races r ON r.race_id = e.race_id
  WHERE r.date >= ? AND r.date < ? ORDER BY r.date, r.deadline, e.race_id, e.lane`, HIST_FROM, HIST_TO)
console.log(`  [計測] SQL読み込み ${((Date.now()-_t0)/1000).toFixed(1)}秒`)
const _t1=Date.now()
let cur = null
const flushRace = (bs, m) => {
  const wb = waveBk(m.wave), nb = windBk(m.wind_speed), rb = rnoBk(m.race_no)
  const hr = hourOf(m.deadline)
  const isLast = m.day_no != null && lastDay.get(`${m.jcd}:${m.series}`) === m.day_no
  const dbk = m.day_no === 1 ? 'first' : isLast ? 'last' : 'mid'
  const nami5 = m.wave != null && m.wave >= 5
  for (const b of bs) {
    if (!b.racer_id) continue
    const p = getP(b.racer_id)
    const rank = b.rank_num, st = b.st, ex = b.exhibition, c = b.course
    bump(p.all, rank, st, ex)
    if (c) bump(gk(p.course, c), rank, st, ex)
    bump(gk(p.venue, m.jcd), rank, st, ex)
    bump(gk(p.venueCourse, `${m.jcd}:${b.lane}`), rank, st, ex)
    if (m.grade) bump(gk(p.grade, m.grade), rank, st, ex)
    bump(gk(p.wave, wb), rank, st, ex); bump(gk(p.wind, nb), rank, st, ex)
    bump(gk(p.rno, rb), rank, st, ex)
    if (hr != null) bump(gk(p.hour, hr), rank, st, ex)
    bump(gk(p.day, dbk), rank, st, ex)
    if (nami5) bump(p.nami5, rank, st, ex)
    if (m.kimarite) {
      if (rank === 1) p.kimete.set(m.kimarite, (p.kimete.get(m.kimarite) ?? 0) + 1)
      else if (c === 1) p.yarare.set(m.kimarite, (p.yarare.get(m.kimarite) ?? 0) + 1)
    }
    p.recent.push({ rank, st, course: c }); if (p.recent.length > 60) p.recent.shift()
    if (b.st_flag === 'F') p.f++; else if (b.st_flag === 'L') p.l++
    if (rank == null) p.dq++
    if (c) { p.entrySum += c; p.entryN++; if (c === b.lane) p.wakunari++ }
    const key = `${m.jcd}:${m.series}`
    if (!p.series || p.series.key !== key) p.series = { key, a: mk() }
    bump(p.series.a, rank, st, ex)
    const mo = getM(m.jcd, b.motor_no)
    bump(mo.all, rank, st, ex); bump(gk(mo.course, b.lane), rank, st, ex)
    mo.recent.push({ rank, ex }); if (mo.recent.length > 40) mo.recent.shift()
    bump(getB(m.jcd, b.boat_no), rank, st, ex)
  }
}
{
  let bs = []
  for (const x of hist) {
    if (!cur || cur.race_id !== x.race_id) { if (cur) flushRace(bs, cur); cur = x; bs = [] }
    bs.push(x)
  }
  if (cur) flushRace(bs, cur)
}
console.log(`  [計測] 積み上げループ ${((Date.now()-_t1)/1000).toFixed(1)}秒`)
console.log(`  ${hist.length.toLocaleString()} 行を反映（${DATE} より前）`)
const _t2=Date.now()

// ---------- 対象日の番組表から特徴量を作る ----------
const KIMARITE = ['逃げ', 'まくり', 'まくり差し', '差し', '抜き', '恵まれ']
const ymd = DATE.replace(/-/g, '')
const progs = all(`
  SELECT p.race_id, p.lane, p.racer_id, p.racer_name, p.age, p.weight,
         p.grade AS pgrade, p.branch AS pbranch,
         p.win_rate_nat, p.top2_nat, p.win_rate_loc, p.top2_loc,
         p.motor_no, p.motor_top2, p.boat_no, p.boat_top2, p.hayami,
         CAST(substr(p.race_id,10,2) AS INTEGER) jcd,
         CAST(substr(p.race_id,13,2) AS INTEGER) race_no
  FROM programs p WHERE substr(p.race_id,1,8) = ?
  ${JCD ? 'AND CAST(substr(p.race_id,10,2) AS INTEGER) = ' + JCD : ''}
  ORDER BY p.race_id, p.lane`, ymd)
if (!progs.length) { console.error(`${DATE} の番組表がありません`); process.exit(1) }

// ★選手名は racer_period から引く（2026-09-11）。
//   programs.racer_name は番組表(Bファイル)の**4文字固定幅**で、長い名前が切れている。
//   テーブル全体で5文字以上が0件（「鈴木結平太」→「鈴木結平」「石渡翔一郎」→「石渡翔一」）。
//   予想JSON → 無料枠・B2の記録・画面にそのまま出るので、ここで直す。
//   レース月以前の期を優先する（改名が未来から漏れないように）。無ければ最新の期。
const FULLNAME = new Map()
{
  const q = db.prepare(`SELECT name FROM racer_period WHERE racer_id = ?
    ORDER BY CASE WHEN period <= ? THEN 0 ELSE 1 END, period DESC LIMIT 1`)
  for (const g of progs) if (g.racer_id != null && !FULLNAME.has(g.racer_id)) {
    const n = q.get(g.racer_id, DATE.slice(0, 7))?.name
    if (n) FULLNAME.set(g.racer_id, n)
  }
}

// 開催情報（グレード・シリーズ）は直近のracesから引く。今日ぶんは無いので前日までの同一場から推定。
const ctx = new Map()
for (const r of all(`SELECT jcd, grade, series, day_no, date FROM races WHERE date < ? ORDER BY date`, HIST_TO))
  ctx.set(r.jcd, r)

const feats = []
for (const g of progs) {
  const p = getP(g.racer_id)
  const c = g.lane                       // ★締切前は枠番しか分からない
  const cx = ctx.get(g.jcd) ?? {}
  const o = { race_id: g.race_id, lane: g.lane, jcd: g.jcd, race_no: g.race_no,
    racer_name: FULLNAME.get(g.racer_id) ?? g.racer_name, grade: cx.grade ?? null, day_no: (cx.day_no ?? 0) + 1, series: cx.series ?? null }
  R(p.all, 'all', o)
  for (let k = 1; k <= 6; k++) R(p.course.get(k), `course${k}`, o)
  R(p.venue.get(g.jcd), 'tochi', o)
  R(p.venueCourse.get(`${g.jcd}:${g.lane}`), 'tochi_lane', o)
  R(p.grade.get(cx.grade), 'grade', o)
  // 波・風は直前情報で後から入るので、ここでは一旦空。取得後に埋め直す。
  R(p.rno.get(rnoBk(g.race_no)), 'rnob', o)
  R(p.day.get('mid'), 'dayb', o)
  R(p.nami5, 'nami5', o)
  let kt = 0; for (const [k, v] of p.kimete) { o[`kimete_${k}`] = v; kt += v }
  o.kimete_total = kt
  let yt = 0; for (const [k, v] of p.yarare) { o[`yarare_${k}`] = v; yt += v }
  o.yarare_total = yt
  for (const w of [10, 30]) {
    const r = p.recent.slice(-w); if (!r.length) continue
    o[`r${w}_n`] = r.length
    o[`r${w}_p1`] = r.filter((x) => x.rank === 1).length / r.length
    o[`r${w}_p3`] = r.filter((x) => x.rank >= 1 && x.rank <= 3).length / r.length
    const rr = r.filter((x) => x.rank)
    o[`r${w}_rank`] = rr.length ? rr.reduce((a, x) => a + x.rank, 0) / rr.length : null
    const sts = r.filter((x) => x.st != null && x.st > 0)
    if (sts.length) o[`r${w}_st`] = sts.reduce((a, x) => a + x.st, 0) / sts.length
  }
  if (p.series) { const s = p.series.a
    o.konsetsu_n = s.n
    if (s.n) { o.konsetsu_sho = s.pt / s.n; if (s.stn) o.konsetsu_st = s.st / s.stn; if (s.exn) o.konsetsu_ex = s.ex / s.exn } }
  o.f_count = p.f; o.l_count = p.l; o.dq_count = p.dq
  o.jiko_ritsu = p.all.n ? (p.f + p.l + p.dq) / p.all.n : null
  if (p.entryN) { o.entry_ave = p.entrySum / p.entryN; o.wakunari_rate = p.wakunari / p.entryN }
  const mo = getM(g.jcd, g.motor_no)
  R(mo.all, 'motor', o); R(mo.course.get(g.lane), 'motor_lane', o)
  if (mo.recent.length) {
    const r = mo.recent.slice(-20)
    o.motor_r20_n = r.length
    o.motor_r20_p1 = r.filter((x) => x.rank === 1).length / r.length
    o.motor_r20_p3 = r.filter((x) => x.rank >= 1 && x.rank <= 3).length / r.length
    const ex = r.filter((x) => x.ex)
    if (ex.length) o.motor_r20_ex = ex.reduce((a, x) => a + x.ex, 0) / ex.length
  }
  R(getB(g.jcd, g.boat_no), 'boat', o)
  // ★番組表由来の項目。学習側(model5.mjs)と同じ作り方にしないと意味がずれる。
  //   級別ダミー・地元判定・期別成績は、学習側で後から足したもの。
  const pp = periodOf(g.racer_id, DATE)
  const derived = {
    _gA1: g.pgrade === 'A1' ? 1 : 0, _gA2: g.pgrade === 'A2' ? 1 : 0,
    _gB1: g.pgrade === 'B1' ? 1 : 0, _gB2: g.pgrade === 'B2' ? 1 : 0,
    _jimoto: BRANCH_JCD[g.pbranch] === g.jcd ? 1 : 0,
    rsex: pp?.sex ?? null, rheight: pp?.height ?? null,
    rwin: pp?.win_rate ?? null, rtop2: pp?.top2_rate ?? null, rstarts: pp?.starts ?? null,
  }
  for (const k of M.progCols) o[k] = (k in derived) ? derived[k] : (g[k] ?? null)
  o.weight = g.weight ?? null     // 調整重量の計算に使う
  o._p = p                        // 気象が判明したら波帯・風帯成績を引き直すのに使う
  o._lane = c
  feats.push(o)
}

// ---------- 当日の直前情報を取ってきて入れる ----------
// ★展示航走はレースの15〜20分前に公表される。締切前に手に入るので使ってよい。
//   展示順位は同じ枠でも1着率を20pt動かす（1号艇：展示1位62.6% / 展示6位42.5%）。
//   ここを埋めないと、モデルの一番強い項目を捨てて予想することになる。
//
// ★まだ発表されていないレースは空のまま
//   朝の時点では全レース未発表。レース直前に再実行すると埋まる。
//   埋まっていない項目は学習時の平均で補われる（＝情報なしとして扱われる）。
if (!argv.includes('--nobefore')) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const strip = (h) => h.replace(/<[^>]*>/g, '\t').replace(/&nbsp;/g, ' ').replace(/\t+/g, '\t')
  const ids = [...new Set(feats.map((o) => o.race_id))]
  console.log(`直前情報を取得中（${ids.length}レース）...`)
  const got = new Map()
  const CONC = 6
  for (let i = 0; i < ids.length; i += CONC) {
    await Promise.all(ids.slice(i, i + CONC).map(async (rid) => {
      const jcd = rid.slice(9, 11), rno = Number(rid.slice(12, 14)), hd = rid.slice(0, 8)
      try {
        const html = await (await fetch(
          `https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${rno}&jcd=${jcd}&hd=${hd}`,
          { signal: AbortSignal.timeout(20_000) })).text()
        // セルの並びは固定：[0]艇番 [1]写真 [2]選手名 [3]体重 [4]展示 [5]チルト [6]プロペラ [7]部品交換
        const boats = []
        for (const tb of html.match(/<tbody[\s\S]*?<\/tbody>/g) ?? []) {
          const cells = [...tb.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]).replace(/\s+/g, ' ').trim())
          if (cells.length < 8) continue
          const lane = Number(cells[0]); if (!(lane >= 1 && lane <= 6)) continue
          const nm = (s) => { const m = String(s ?? '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null }
          boats.push({ lane, weight: nm(cells[3]), ex: nm(cells[4]), tilt: nm(cells[5]),
            parts: cells[7] && /[^\s]/.test(cells[7]) ? 1 : 0 })
        }
        if (boats.length !== 6) return
        // ★気象は必ずラベルで取る。
        //   最初は /([\d.]+)m/ で拾って「風速5m」と読んだが、実際は3mだった。
        //   ページ内の別の数値を掴んでいた。範囲や順番で推測すると必ず誤る。
        const seg = html.slice(html.indexOf('weather1')).slice(0, 3000).replace(/<[^>]*>/g, '|')
        const pick = (label, unit) => {
          const m = seg.match(new RegExp(label + '[^\\d-]{0,40}(-?[\\d.]+)' + unit))
          return m ? Number(m[1]) : null
        }
        got.set(rid, { boats,
          air: pick('気温', '℃'), water: pick('水温', '℃'),
          wind: pick('風速', 'm'), wave: pick('波高', 'cm') })
      } catch { /* 未発表なら空のまま */ }
    }))
    await sleep(150)
  }
  // ★「取れた」の判定を展示タイクの有無で行うこと。
  //   最初は取得できたレース数だけ数えていたため、体重と気温しか無いページでも
  //   「展示が取れた」と報告してしまった。**無いものを有ると報告するのが最悪**。
  let filled = 0, withEx = 0
  // 気象は展示より先に出る。展示が無くても波・風は使える。
  for (const [rid, g] of got) for (const o of feats) if (o.race_id === rid) {
    const b = g.boats.find((x) => x.lane === o.lane)
    o.bf_air = g.air; o.bf_water = g.water
    o._wave = g.wave; o._wind = g.wind
    // ★波・風が分かったので、その帯での選手成績を引き直す。
    //   番組表だけの段階では不明として空にしてある。
    if (o._p) { R(o._p.wave.get(waveBk(g.wave)), 'waveb', o); R(o._p.wind.get(windBk(g.wind)), 'windb', o) }
    if (b) { o.bf_parts = b.parts; o.bf_weight = b.weight
      o.bf_wadj = b.weight != null && o.weight != null ? b.weight - o.weight : null }
  }
  for (const [rid, g] of got) {
    const valid = g.boats.filter((b) => b.ex && b.ex > 0)
    if (!valid.length) continue
    withEx++
    const mean = valid.reduce((a, b) => a + b.ex, 0) / valid.length
    const rank = new Map([...valid].sort((a, b) => a.ex - b.ex).map((b, i) => [b.lane, i + 1]))
    for (const o of feats) {
      if (o.race_id !== rid) continue
      const b = g.boats.find((x) => x.lane === o.lane); if (!b) continue
      o.bf_ex_time = b.ex && b.ex > 0 ? b.ex : null
      o.bf_ex_rank = rank.get(b.lane) ?? null
      o.bf_ex_dev = b.ex && b.ex > 0 ? b.ex - mean : null
      o.bf_tilt = b.tilt
      o.bf_parts = b.parts
      o.bf_weight = b.weight
      o.bf_wadj = b.weight != null && o.weight != null ? b.weight - o.weight : null
      o.bf_air = g.air
      o.bf_water = g.water
      o._wave = g.wave       // 波高（条件補正と選手の波帯成績に使う）
      o._wind = g.wind       // 風速
      if (o.bf_ex_rank != null) filled++
    }
  }
  console.log(`  ページ取得 ${got.size}/${ids.length}レース  うち展示タイムあり ${withEx}レース（${filled}艇）`)
  if (!withEx) console.log('  ⚠️ 展示タイムはまだ未発表です。体重・気温・水温・部品交換のみ反映しています。')
  else if (withEx < ids.length) console.log(`  ⚠️ ${ids.length - withEx}レースは展示未発表。直前に再実行してください。`)
}

// ---------- ベクトル化してモデルを当てる ----------
// ★XOFF より前の項目は**すべて**標準化する。枠番のダミーも含む。
//   学習時 (model5.mjs の norm) が i >= XOFF だけを素通ししているので、
//   ダミーもそこでは標準化されている。予想側で生の0/1を入れると、
//   同じ係数でもまったく違う値になり、6号艇が71%になるような結果が出る。
const vecOf = (o, C) => {
  const { M, D, mean, sd, enc, XOFF } = C
  const v = new Float64Array(D)
  M.featCols.forEach((c, i) => { const x = o[c]; v[i] = x == null ? mean[i] : x })
  M.progCols.forEach((c, i) => { const j = M.featCols.length + i; const x = o[c]; v[j] = x == null ? mean[j] : x })
  const cbase = M.featCols.length + M.progCols.length
  for (let k = 0; k < 6; k++) v[cbase + k] = 0
  if (o._lane >= 1 && o._lane <= 6) v[cbase + o._lane - 1] = 1
  for (let i = 0; i < XOFF; i++) v[i] = (v[i] - mean[i]) / sd[i]
  const key = {
    jcd: `${o.jcd}|${o._lane}`, grade: `${o.grade ?? 'x'}|${o._lane}`,
    wave: `${waveBk(o._wave)}|${o._lane}`, wind: `${windBk(o._wind)}|${o._lane}`, rno: `${o.race_no}|${o._lane}`,
    // ★model5.mjs の XKEY と同じ値にする（2026-09-14から既定。--legacy-serve で旧挙動）。
    //   ⚠ キーだけ直しても食い違いは消えなかった（9/13：1着確率の差 平均5.75pt→5.01pt）。
    //     主因は過去成績を数え始める日のずれ（下の HIST_FROM）。両方そろえて 2.62pt まで縮んだ。
    ...(MATCH_TRAIN ? {
      hour: `${hourBk(o._deadline)}|${o._lane}`, day: `${o.day_no ?? 'x'}|${o._lane}`,
      len: `${o._len ?? 'x'}|${o._lane}`,
      left: `${o._len != null && o.day_no != null ? o._len - o.day_no : 'x'}|${o._lane}`,
      lenday: `${o._len ?? 'x'}-${o.day_no ?? 'x'}|${o._lane}`,
      title: `${titleKey(o._title)}|${o._lane}`,
    } : {
      hour: `x|${o._lane}`, day: `${o.day_no}|${o._lane}`,
      len: `x|${o._lane}`, left: `x|${o._lane}`, lenday: `x-${o.day_no}|${o._lane}`,
      title: `yosen|${o._lane}`,
    }),
  }
  M.xtypes.forEach((t, i) => { v[XOFF + i] = enc[t].get(key[t]) ?? 0 })
  return v
}
// ★条件補正に使うレース情報（締切・レース名・何日目・開催名・総日数）を、学習と同じ値で揃える。
//   過去日：races（競走成績）の値をそのまま使う。総日数も学習と同じ MAX(day_no)。
//   当日  ：racemeta.mjs（番組表＋出走一覧の日程）。当日は races に行がまだ無いため。
//   ⚠ これが無いと hour/len/left/lenday が「不明」、title が全部「予選」になり、
//     学習で測った確率と本番の確率が食い違う（2026-09-14に判明・修正）。
if (MATCH_TRAIN) {
  const META = new Map()
  const past = all(`SELECT race_id, jcd, deadline, title, day_no, series, grade FROM races WHERE date = ?`, DATE)
  if (past.length) {
    const lenQ = db.prepare(`SELECT MAX(day_no) m FROM races WHERE jcd = ? AND series = ?`)
    const cache = new Map()
    for (const r of past) {
      const k = r.jcd + ':' + r.series
      if (!cache.has(k)) cache.set(k, lenQ.get(r.jcd, r.series)?.m ?? null)
      META.set(r.race_id, { deadline: r.deadline, title: r.title, day_no: r.day_no, series: r.series, len: cache.get(k), grade: r.grade })
    }
  } else {
    const { ensureMeta } = await import('./racemeta.mjs')
    for (const [k, v] of await ensureMeta(DATE)) META.set(k, v)
  }
  // 当日で開催が替わった場（初日）は、前日の grade が別の開催のものなので引き直す
  const gQ = db.prepare(`SELECT grade FROM races WHERE jcd = ? AND series = ? AND grade IS NOT NULL ORDER BY date DESC LIMIT 1`)
  const hit = new Set(), noLen = new Set()
  for (const o of feats) {
    const m = META.get(o.race_id)
    if (!m) continue
    hit.add(o.race_id)
    o._deadline = m.deadline
    o._title = m.title
    o._len = m.len ?? null
    if (m.len == null) noLen.add(o.race_id)
    if (m.day_no != null) o.day_no = m.day_no
    if (m.grade !== undefined) o.grade = m.grade
    else if (m.series && m.series !== o.series) o.grade = gQ.get(o.jcd, m.series)?.grade ?? null
    if (m.series) o.series = m.series
  }
  const total = new Set(feats.map((o) => o.race_id)).size
  console.log(`  レース情報（締切・レース名・何日目・総日数）: ${hit.size}/${total}レース` +
    (noLen.size ? `（総日数が取れなかった ${noLen.size}レースは「不明」扱い）` : ''))
}
if (DUMP_FEATS) {
  const cols = [...MORN.M.featCols, ...MORN.M.progCols]
  writeFileSync(DUMP_FEATS, JSON.stringify(feats.map((o) => {
    const x = { race_id: o.race_id, lane: o.lane }
    for (const c of cols) x[c] = o[c] ?? null
    return x
  })))
  console.log(`  特徴量を書き出した: ${DUMP_FEATS}（${feats.length}艇・${cols.length}項目）`)
}
// ★そのレースがフルモデルの入力を**全部**持っているときだけフルモデルを使う。
//   展示タイムと波高の両方が要る。片方だけだと結局もう片方を平均値で埋めることになり、
//   直したはずの穴がそのまま残る。
const hasFull = (bs) => bs.every((o) => o.bf_ex_time != null) && bs.every((o) => o._wave != null)
const byRace = new Map()
for (const o of feats) { let g = byRace.get(o.race_id); if (!g) { g = []; byRace.set(o.race_id, g) } g.push({ ...o }) }
let nFull = 0
for (const [, bs] of byRace) {
  const C = (FULL && hasFull(bs)) ? FULL : MORN
  if (C === FULL) nFull++
  bs.C = C
  for (const b of bs) b.x = vecOf(b, C)
}
console.log(`  使ったモデル: 直前情報あり ${nFull}レース ／ 朝モデル ${byRace.size - nFull}レース`)

function trio(bs) {
  const { W, D } = bs.C ?? MORN
  const sc = [0, 1, 2].map((st) => bs.map((b) => { let z = 0; for (let d = 0; d < D; d++) z += W[st][d] * b.x[d]; return z }))
  const soft = (idx, s) => { const m = Math.max(...idx.map((i) => s[i])); const e = idx.map((i) => Math.exp(s[i] - m)); const t = e.reduce((a, b) => a + b, 0); return e.map((x) => x / t) }
  const N = bs.length
  const idxAll = [...Array(N).keys()]
  const p1 = soft(idxAll, sc[0])
  const out = []
  for (let a = 0; a < N; a++) {
    const i2 = idxAll.filter((i) => i !== a); const q2 = soft(i2, sc[1])
    for (let bi = 0; bi < i2.length; bi++) {
      const b = i2[bi]
      const i3 = idxAll.filter((i) => i !== a && i !== b); const q3 = soft(i3, sc[2])
      for (let ci = 0; ci < i3.length; ci++)
        out.push({ combo: `${bs[a].lane}-${bs[b].lane}-${bs[i3[ci]].lane}`, p: p1[a] * q2[bi] * q3[ci] })
    }
  }
  const t = out.reduce((a, x) => a + x.p, 0)
  for (const x of out) x.p /= t
  return { trios: out, first: bs.map((b, i) => ({ lane: b.lane, name: b.racer_name, p: p1[i] })) }
}

// ---------- 3連複と本命レース選定 ----------
// ★3連複は3連単120通りを並べ替え違いでまとめれば出る（1組=6通りの合計）。
//   「自信」は買う3点の的中確率の合計。これが高いレースほど堅い。
if (argv.includes('--trio')) {
  const rows = []
  for (const [rid, bs] of byRace) {
    bs.sort((a, b) => a.lane - b.lane)
    const { trios, first } = trio(bs)
    const box = new Map()
    for (const t of trios) {
      const k = t.combo.split('-').map(Number).sort((a, b) => a - b).join('=')
      box.set(k, (box.get(k) ?? 0) + t.p)
    }
    const top = [...box].sort((a, b) => b[1] - a[1]).slice(0, 3)

    // ★券種ごとの確率も出す。3連単120通りを畳めば全券種が作れる。
    //   検証で「2艇まで（単勝・複勝・2連複・拡連複）は市場に勝てるが、
    //   3艇の順序（3連単・3連複）では負ける」と分かったので、有料配信は前者を使う。
    const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v)

    // ★展開の見せ方「1-2=3,4」を作る（無料配信用）
    //   軸＝1着確率が最も高い艇。そこから2着・3着を条件付きで絞る。
    //   ※これは買い目ではない。実測で軸から流すと3連単103%・3連複94%になり、
    //     軸の単勝そのもの（145.5%）を大きく下回る。**買えば負ける。**
    //     読み物として「こう決まるかも」を示すだけ。数字を併記して誤解を防ぐこと。
    const axis = [...first].sort((a, b) => b.p - a.p)[0]?.lane
    let flow = null
    if (axis) {
      const s2 = new Map(), byS2 = new Map()
      for (const t of trios) {
        const [a, b, c] = t.combo.split('-').map(Number)
        if (a !== axis) continue
        add(s2, b, t.p)
        if (!byS2.has(b)) byS2.set(b, new Map())
        add(byS2.get(b), c, t.p)
      }
      const second = [...s2].sort((x, y) => y[1] - x[1])[0]
      if (second) {
        const thirds = [...(byS2.get(second[0]) ?? new Map())].sort((x, y) => y[1] - x[1]).slice(0, 2)
        const pAxis = first.find((f) => f.lane === axis)?.p ?? 0
        flow = {
          axis, second: second[0], thirds: thirds.map((t) => t[0]),
          text: `${axis}-${second[0]}=${thirds.map((t) => t[0]).join(',')}`,
          pAxis, pSecond: second[1],                         // 軸1着＆その2着 の確率
          p: thirds.reduce((a2, t) => a2 + t[1], 0),          // この2点が当たる確率
        }
      }
    }
    const nifuku = new Map(), kaku = new Map(), nitan = new Map(), fuku = new Map()
    for (const t of trios) {
      const [a, b, c] = t.combo.split('-').map(Number)
      add(nitan, `${a}-${b}`, t.p)
      add(nifuku, [a, b].sort((x, y) => x - y).join('-'), t.p)
      add(fuku, String(a), t.p); add(fuku, String(b), t.p)   // 複勝＝2着以内
      const s = [a, b, c].sort((x, y) => x - y)
      add(kaku, `${s[0]}-${s[1]}`, t.p); add(kaku, `${s[0]}-${s[2]}`, t.p); add(kaku, `${s[1]}-${s[2]}`, t.p)
    }
    const best = (m) => { const e = [...m].sort((a, b) => b[1] - a[1])[0]; return e ? { combo: e[0], p: e[1] } : null }

    // ★開催情報（グレード・節名・日目）も持たせる。娯楽枠の配信で使う。
    //   今日ぶんは races に無いので、同じ場の前日までの開催から引き継いでいる（ctx）。
    const _cx = ctx.get(bs[0].jcd) ?? {}
    rows.push({ rid, jcd: bs[0].jcd, rno: bs[0].race_no, top,
      grade: _cx.grade ?? null, series: _cx.series ?? null, day_no: (_cx.day_no ?? 0) + 1,
      conf: top.reduce((a, x) => a + x[1], 0),
      first: [...first].sort((a, b) => b.p - a.p), bs,
      // ★2着以内確率（複勝用）。fuku は上で3連単の組から畳んである。
      //   複勝は「下限2倍以上」で買うと 的中51.4% / 回収164.4%（歩進検証940点・月別8/8）。
      //   名前は first から引く（bs の項目名に依存しないようにする）
      flow,
      top2: [...fuku].map(([l, p]) => ({ lane: Number(l),
        name: first.find((f) => f.lane === Number(l))?.name, p })).sort((a, b) => b.p - a.p),
      bt: { nirentan: best(nitan), nirenpuku: best(nifuku), kakuren: best(kaku), fukusho: best(fuku) },
      // ★3連単・3連複の順位表（上位12点）。買うためではなく、
      //   ①2着3着のデータを日々ためて後でモデル改善に使う ②娯楽枠の配信に使う。
      //   単勝の判定には一切使わない。
      // ★24点まで保存する。12点だと配信用の「穴」が85%しか拾えなかった
      //   （穴は中央値7位・上位90%で13位・最大30位）。
      sanrentan: [...trios].sort((a, b) => b.p - a.p).slice(0, 24).map((t) => ({ combo: t.combo, p: t.p })),
      // ★1着の艇ごとの最良の組。配信用の「穴」は必ずここから取れる。
      //   上位24点だけだと1着が1・2号艇の組で埋まって、別の艇を1着にした組が
      //   1つも残らないことがある（実際に唐津3Rで起きた）。6艇ぶん必ず持っておく。
      firstBest: (() => {
        const b = new Map()
        for (const t of trios) {
          const l = Number(t.combo[0])
          if (!b.has(l) || t.p > b.get(l).p) b.set(l, { combo: t.combo, p: t.p })
        }
        return [...b].sort((x, y) => y[1].p - x[1].p).map(([lane, v]) => ({ lane, ...v }))
      })(),
      sanrenpuku: (() => {
        const m = new Map()
        for (const t of trios) { const k = t.combo.split('-').map(Number).sort((x, y) => x - y).join('-')
          m.set(k, (m.get(k) ?? 0) + t.p) }
        return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([combo, p]) => ({ combo, p }))
      })(),
      nirentanTop: [...nitan].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([combo, p]) => ({ combo, p })) })
  }
  rows.sort((a, b) => b.conf - a.conf)

  // ★--json を付けると機械可読な形で出す。serve.mjs（Webフォーム）が読む。
  //   フォーム用に予想ロジックを別実装すると、片方だけ直して食い違う事故が起きる。
  //   出力形式を足すだけにして、計算は1箇所に保つ。
  if (argv.includes('--json')) {
    console.log(`  [計測] 採点・出力 ${((Date.now() - _t2) / 1000).toFixed(1)}秒`)
    // ★--out が指定されていればファイルに書く。
    //   標準出力に168KBを流して process.exit() すると、Windowsでは
    //   書き込み完了前に終了処理が走りプロセスが固まる（8/23に17分ハング）。
    const OUT = flag('out')
    const payload = JSON.stringify({
      date: DATE, generatedAt: new Date().toISOString(),
      races: rows.map((r) => ({
        race_id: r.rid, jcd: r.jcd, venue: VENUE[r.jcd], race_no: r.rno,
        grade: r.grade, series: r.series, day_no: r.day_no,
        conf: r.conf,
        trio: r.top.map(([combo, p]) => ({ combo, p })),
        first: r.first.map((x) => ({ lane: x.lane, name: x.name, p: x.p })),
        top2: r.top2,
        flow: r.flow,
        bt: r.bt,
        sanrentan: r.sanrentan,
        sanrenpuku: r.sanrenpuku,
        nirentanTop: r.nirentanTop,
      })),
    })
    if (OUT) {
      writeFileSync(OUT, payload)
      console.log(`  [出力] ${OUT}（${payload.length.toLocaleString()}文字）`)
    } else {
      console.log(payload)
    }
    db.close()
    process.exit(0)
  }
  console.log(`\n===== ${DATE} 3連複3点予想（自信が高い順）${JCD ? ` ${VENUE[JCD]}のみ` : ''} =====`)
  console.log(`※ 自信＝3点の的中確率の合計。締切前に分かる情報のみ使用（進入は枠番で代用）\n`)
  for (const r of rows) {
    console.log(`■ ${VENUE[r.jcd]} ${r.rno}R   自信 ${(r.conf * 100).toFixed(1)}%`)
    console.log(`   3連複3点: ${r.top.map(([c, p]) => `${c} (${(p * 100).toFixed(1)}%)`).join('   ')}`)
    console.log(`   1着予想 : ${r.first.slice(0, 3).map((x) => `${x.lane}号艇 ${x.name}(${(x.p * 100).toFixed(0)}%)`).join(' / ')}`)
  }
  const best = rows[0]
  console.log(`\n★ 本命レース: ${VENUE[best.jcd]} ${best.rno}R（自信 ${(best.conf * 100).toFixed(1)}%）`)
  console.log(`   ${best.top.map(([c]) => c).join('  ')}`)
  db.close()
  process.exit(0)
}

console.log(`\n===== ${DATE} の予想  ${byRace.size} レース =====\n`)
const sorted = [...byRace.entries()].sort((a, b) => a[0].localeCompare(b[0]))
for (const [rid, bs] of sorted) {
  bs.sort((a, b) => a.lane - b.lane)
  const { trios, first } = trio(bs)
  const top = [...trios].sort((a, b) => b.p - a.p).slice(0, 6)
  const f = [...first].sort((a, b) => b.p - a.p)
  const jcd = bs[0].jcd, rno = bs[0].race_no
  if (BUYONLY) { console.log(`${VENUE[jcd]}${rno}R  ${top.slice(0, 3).map((t) => `${t.combo}(${(t.p * 100).toFixed(1)}%)`).join('  ')}`); continue }
  console.log(`■ ${VENUE[jcd]} ${rno}R`)
  console.log(`   1着予想: ${f.map((x) => `${x.lane}号艇 ${x.name}(${(x.p * 100).toFixed(1)}%)`).join(' / ')}`)
  console.log(`   3連単  : ${top.map((t) => `${t.combo} ${(t.p * 100).toFixed(2)}%`).join('  ')}`)
}
db.close()
