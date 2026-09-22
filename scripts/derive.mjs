// 公式データだけから、選手・モーター・条件別の集計を全部作る。
//
//   node scripts/derive.mjs            全期間を作り直す
//   node scripts/derive.mjs --verify   日和の実データと突合して正しさを確認する
//
// ★なぜ自前で作るのか
//   日和（kyoteibiyori.com）は同じ集計を提供しているが、2026/08/18にIP遮断され使えなくなった。
//   ただし日和が持っているのは公式データの集計にすぎず、
//   実際に日和の数値を自前計算で再現できることを確認済み：
//     波5cm超の2連対率 r=0.997 / 3連対率 r=0.998 / 勝率 r=0.988 / 走数 r=0.998
//   よって外部サイトに依存する必要はない。しかも自前なら公式ファイルがある限り何年でも遡れる。
//
// ★設計：そのレースの締切時点までの情報だけで作る
//   レースを日付順に1本ずつ流し、**結果を数える前に**その時点の集計を特徴量として書き出す。
//   後から全期間を集計して割り当てると、未来の結果が混ざって
//   バックテストの成績が実際より良く出てしまう。順序を守ることが唯一の防ぎ方。
//
// ★出す集計（ユーザー指定の掛け合わせ：場×グレード×選手×モーター×コース×水面と風×レース番号×時間）
//   選手：全体／コース別／当地／当地×コース／グレード別／波帯／風帯／レース番号帯／時間帯／日目
//         決まり手（取った側）／やられ方（取られた側）／直近10走・30走／今節
//   モーター：全体／当地／直近／展示タイム
//   ボート、進入（枠なり率・平均進入コース）、事故（F・L・失格）

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)
const argv = process.argv.slice(2)
// ★学習に使う期間の下限。既定は直近1年。
//   4年分に広げたことがあるが、**競艇は制度（番組編成・級別・水面改修など）が変わる**ため、
//   古いデータで学習すると現在と違う構造を覚える。直近1年に限る。
const FROM_DATE = (() => { const i = argv.indexOf('--from'); return i > -1 ? argv[i+1] : '2025-08-18' })()
console.log('学習に使う期間: ' + FROM_DATE + ' 以降')

// ---------- 区分の定義（推測せず、実データの分布に合わせて切る） ----------
const waveBucket = (w) => (w == null ? 'x' : w <= 2 ? 'a' : w <= 5 ? 'b' : w <= 9 ? 'c' : 'd')
const windBucket = (w) => (w == null ? 'x' : w <= 1 ? 'a' : w <= 3 ? 'b' : w <= 5 ? 'c' : 'd')
const rnoBucket = (r) => (r <= 4 ? 'a' : r <= 8 ? 'b' : 'c')
// 引き波耐性の集計に使う粗い区分
// ★区分は実データの標本数から決めた。
//   当初 lo/mid/hi の3分割にしたが、hi(6cm以上)は年2,765レースしかなく
//   選手1人あたり平均5走。これでは3連対率が推定できず、全件NULLになった。
//   2分割（0-2cm / 3cm以上）なら1人あたり36〜58走あり、率として意味を持つ。
const waveCoarse = (w) => (w == null ? 'x' : w <= 2 ? 'lo' : 'rough')
const laneGroup = (l) => (l <= 3 ? 'in' : 'out')
const hourOf = (t) => { const m = String(t ?? '').match(/^(\d{1,2}):/); return m ? Number(m[1]) : null }
const dayBucket = (d, isLast) => (d === 1 ? 'first' : isLast ? 'last' : 'mid')
// 競艇の勝率＝1着10点 2着8点 3着6点 4着4点 5着2点 6着1点 の平均（日和の勝率と一致を確認済み）
const PTS = [0, 10, 8, 6, 4, 2, 1]

// ---------- 集計を貯める入れもの ----------
// 「回数・1着・2着以内・3着以内・得点・ST合計・ST件数」を1組として扱う
const mk = () => ({ n: 0, w1: 0, w2: 0, w3: 0, pt: 0, st: 0, stn: 0, ex: 0, exn: 0 })
const bump = (a, rank, st, ex) => {
  a.n++
  if (rank >= 1 && rank <= 6) { a.pt += PTS[rank]; if (rank === 1) a.w1++; if (rank <= 2) a.w2++; if (rank <= 3) a.w3++ }
  if (st != null && st > 0) { a.st += st; a.stn++ }
  if (ex != null && ex > 0) { a.ex += ex; a.exn++ }
}
/** 入れ子のMapから、無ければ作って返す */
const gk = (m, k) => { let v = m.get(k); if (!v) { v = mk(); m.set(k, v) } return v }

// 集計値を「率」に直す。走数が少ないものは率が暴れるので走数もそのまま出す。
const R = (a, pfx, out) => {
  if (!a || !a.n) return
  out[`${pfx}_n`] = a.n
  out[`${pfx}_p1`] = a.w1 / a.n
  out[`${pfx}_p2`] = a.w2 / a.n
  out[`${pfx}_p3`] = a.w3 / a.n
  out[`${pfx}_sho`] = a.pt / a.n
  if (a.stn) out[`${pfx}_st`] = a.st / a.stn
  if (a.exn) out[`${pfx}_ex`] = a.ex / a.exn
}

if (argv.includes('--verify')) {
  // 日和から取れた分と突合する（日和の値を正解として、自前計算がどれだけ合うか）
  const corr = (p) => {
    const n = p.length
    if (n < 30) return null
    const mx = p.reduce((a, b) => a + b[0], 0) / n, my = p.reduce((a, b) => a + b[1], 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2 }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null
  }
  console.log('=== 自前計算 vs 日和（日和が取れた分だけで答え合わせ） ===\n')
  console.log('  項目                        相関r    自前平均   日和平均   件数')
  const pairs = [
    ['course1_p1', 'course1_1_ave', 'コース1 1着率'],
    ['course1_p2', 'course1_2_ave', 'コース1 2連対率'],
    ['course1_p3', 'course1_3_ave', 'コース1 3連対率'],
    ['course1_n', 'course1_shinnyu', 'コース1 進入数'],
    ['course4_p1', 'course4_1_ave', 'コース4 1着率'],
    ['course4_n', 'course4_shinnyu', 'コース4 進入数'],
    ['nami5_sho', 'nami5_rank1', '波5cm超 勝率'],
    ['nami5_p2', 'nami5_rank2', '波5cm超 2連対率'],
    ['nami5_p3', 'nami5_rank3', '波5cm超 3連対率'],
    ['nami5_n', 'nami5_shinnyuu', '波5cm超 走数'],
    ['all_st', 'ave_start', '平均ST'],
  ]
  for (const [mine, theirs, label] of pairs) {
    const rows = all(`SELECT f."${mine}" a, b."${theirs}" c FROM feat f
      JOIN bf b ON b.race_id=f.race_id AND b.lane=f.lane
      WHERE f."${mine}" IS NOT NULL AND b."${theirs}" IS NOT NULL AND b."${theirs}" > 0`)
    if (rows.length < 30) { console.log(`  ${label.padEnd(22)} 件数不足 (${rows.length})`); continue }
    // 単位が違う項目があるので、比で倍率を推定してから比べる
    const ma = rows.reduce((s, x) => s + x.a, 0) / rows.length
    const mc = rows.reduce((s, x) => s + x.c, 0) / rows.length
    const c = corr(rows.map((x) => [x.a, x.c]))
    console.log(`  ${label.padEnd(22)} ${c === null ? '  -  ' : (c >= 0 ? ' ' : '') + c.toFixed(3)}   ${ma.toFixed(3).padStart(9)} ${mc.toFixed(3).padStart(10)} ${String(rows.length).padStart(6)}`)
  }
  db.close(); process.exit(0)
}

// ---------- 本体 ----------
console.log('=== 公式データから全集計を作る（時点を守って積み上げる） ===')

// 開催の最終日を先に割り出す（「最終日」の判定に要る）
const lastDay = new Map()
for (const r of all(`SELECT jcd, series, MAX(day_no) d FROM races WHERE series IS NOT NULL GROUP BY jcd, series`))
  lastDay.set(`${r.jcd}:${r.series}`, r.d)

const rows = all(`
  SELECT e.race_id, e.lane, e.racer_id, e.rank_num, e.course, e.st, e.exhibition,
         e.motor_no, e.boat_no, e.st_flag,
         r.date, r.jcd, r.race_no, r.grade, r.wave, r.wind_speed, r.wind_dir,
         r.deadline, r.day_no, r.series, r.kimarite
  FROM entries e JOIN races r ON r.race_id = e.race_id
  WHERE r.date >= ?
  ORDER BY r.date, r.deadline, e.race_id, e.lane`, FROM_DATE)
console.log(`  対象 ${rows.length.toLocaleString()} 行`)

// レース単位にまとめ直す（決まり手の付け替えに、同レースの全艇が要る）
const races = []
{
  let cur = null
  for (const x of rows) {
    if (!cur || cur.race_id !== x.race_id) { cur = { race_id: x.race_id, meta: x, boats: [] }; races.push(cur) }
    cur.boats.push(x)
  }
}
console.log(`  ${races.length.toLocaleString()} レースを日付順に処理`)

// --- 選手の入れもの ---
const P = new Map()
const newP = () => ({
  all: mk(),
  course: new Map(),      // コース → 集計
  venue: new Map(),       // 場 → 集計
  venueCourse: new Map(), // 場:コース → 集計
  grade: new Map(),       // グレード → 集計
  wave: new Map(),        // 波帯 → 集計
  wind: new Map(),        // 風帯 → 集計
  rno: new Map(),         // レース番号帯 → 集計
  hour: new Map(),        // 時間（1時間刻み） → 集計
  day: new Map(),         // 初日/中日/最終日 → 集計
  nami5: mk(),            // 波5cm超（日和と同じ切り方）
  // ★引き波耐性 × 外枠
  //   1マークで4〜6号艇は先行艇の引き波を越えなければならない。水面が荒れていれば
  //   その負荷はさらに増す。「波に強い選手が外枠に入ったとき」という条件は、
  //   波の成績とコースの成績を別々に入れても表現できない（線形モデルは掛け算をしない）。
  //   実測では 波耐性↔外枠適性 r=+0.328（z=9.99）と有意だったのに、
  //   モデルには入れていなかった。ここで明示的に作る。
  //   キーは「波帯:枠グループ」の6通り。lo=0-2cm / mid=3-5cm / hi=6cm以上、in=1-3枠 / out=4-6枠
  wl: new Map(),
  kimete: new Map(),      // 決まり手（勝った時）
  yarare: new Map(),      // やられ方（1コースで負けた時）
  recent: [],             // 直近の着順・ST・コース
  f: 0, l: 0, dq: 0,      // フライング・出遅れ・失格
  entrySum: 0, entryN: 0, wakunari: 0, // 進入（平均進入コース・枠なり率）
  series: null,           // 今節（節が変わったらリセット）
})
const getP = (id) => { let v = P.get(id); if (!v) { v = newP(); P.set(id, v) } return v }

// --- モーター・ボートの入れもの（場ごとに番号が振られるので場と対にする） ---
const M = new Map(), B = new Map()
const getM = (jcd, no) => { const k = `${jcd}:${no}`; let v = M.get(k); if (!v) { v = { all: mk(), course: new Map(), recent: [] }; M.set(k, v) } return v }
const getB = (jcd, no) => { const k = `${jcd}:${no}`; let v = B.get(k); if (!v) { v = mk(); B.set(k, v) } return v }

// ★列は先に確定させてテーブルを作り、1レースぶんずつ書き出す。
//   33万行を配列に貯めてから書こうとしてメモリが尽きた（ヒープ2GB到達）。
//   列数が多いので、行を持ち回らずその場で流すこと。
const KIMARITE = ['逃げ', 'まくり', 'まくり差し', '差し', '抜き', '恵まれ']
const RATE_KEYS = ['n', 'p1', 'p2', 'p3', 'sho', 'st', 'ex']
const GROUPS = ['all', 'course1', 'course2', 'course3', 'course4', 'course5', 'course6',
  'tochi', 'tochi_lane', 'grade', 'waveb', 'windb', 'rnob', 'hourb', 'dayb', 'nami5',
  'motor', 'motor_lane', 'boat', 'wl']
const cols = [
  'racer_id', 'course',
  ...GROUPS.flatMap((g) => RATE_KEYS.map((k) => `${g}_${k}`)),
  ...KIMARITE.map((k) => `kimete_${k}`), 'kimete_total',
  ...KIMARITE.map((k) => `yarare_${k}`), 'yarare_total',
  ...[10, 30].flatMap((w) => [`r${w}_n`, `r${w}_p1`, `r${w}_p3`, `r${w}_rank`, `r${w}_st`]),
  'konsetsu_n', 'konsetsu_sho', 'konsetsu_st', 'konsetsu_ex',
  'f_count', 'l_count', 'dq_count', 'jiko_ritsu', 'entry_ave', 'wakunari_rate',
  'motor_r20_n', 'motor_r20_p1', 'motor_r20_p3', 'motor_r20_ex',
  'wake_gap', 'wake_rel', 'wake_out_hi_n',
]
const q = (k) => '"' + k.replace(/"/g, '""') + '"'
db.exec('DROP TABLE IF EXISTS feat')
db.exec(`CREATE TABLE feat (race_id TEXT NOT NULL, lane INTEGER NOT NULL,
  ${cols.map((c) => `${q(c)} REAL`).join(', ')}, PRIMARY KEY (race_id, lane))`)
const ins = db.prepare(`INSERT OR REPLACE INTO feat (race_id, lane, ${cols.map(q).join(',')})
  VALUES (?,?,${cols.map(() => '?').join(',')})`)
console.log(`  特徴量 ${cols.length} 項目`)

let processed = 0
let pending = 0
db.exec('BEGIN')
const emit = (o) => {
  ins.run(o.race_id, o.lane, ...cols.map((c) => (o[c] === undefined ? null : o[c])))
  if (++pending >= 20000) { db.exec('COMMIT'); db.exec('BEGIN'); pending = 0 }
}

for (const race of races) {
  const m = race.meta
  const wb = waveBucket(m.wave), nb = windBucket(m.wind_speed), rb = rnoBucket(m.race_no)
  const hr = hourOf(m.deadline)
  const isLast = m.day_no != null && lastDay.get(`${m.jcd}:${m.series}`) === m.day_no
  const db_ = dayBucket(m.day_no, isLast)
  const nami5 = m.wave != null && m.wave >= 5

  // ---- 1) まず「今の時点の集計」を特徴量として書き出す（結果はまだ数えない） ----
  for (const b of race.boats) {
    if (!b.racer_id) continue
    const p = getP(b.racer_id)
    const o = { race_id: b.race_id, lane: b.lane, racer_id: b.racer_id, course: b.course }

    R(p.all, 'all', o)
    // 出走コースは締切前には確定しないので、枠番のコース実績と、実際のコース実績の両方を出す
    for (let c = 1; c <= 6; c++) R(p.course.get(c), `course${c}`, o)
    R(p.venue.get(m.jcd), 'tochi', o)
    R(p.venueCourse.get(`${m.jcd}:${b.lane}`), 'tochi_lane', o)
    R(p.grade.get(m.grade), 'grade', o)
    R(p.wave.get(wb), 'waveb', o)
    R(p.wind.get(nb), 'windb', o)
    R(p.rno.get(rb), 'rnob', o)
    if (hr != null) R(p.hour.get(hr), 'hourb', o)
    R(p.day.get(db_), 'dayb', o)
    R(p.nami5, 'nami5', o)

    // ★引き波耐性
    //   (1) 今回の「波帯 × 枠グループ」でのその選手の実績。条件そのものを直接渡す。
    //   (2) 波が高いときに外枠でどれだけ落ちないか＝引き波を越える能力の指標。
    //       外枠で 波高 と 波低 の3連対率を比べる。差が小さい（0に近い）ほど波に強い。
    //   (3) 同じ波高でも内枠と外枠でどれだけ差が出るか。
    R(p.wl.get(`${waveCoarse(m.wave)}:${laneGroup(b.lane)}`), 'wl', o)
    {
      const g = (k) => p.wl.get(k)
      const p3 = (a) => (a && a.n >= 20 ? a.w3 / a.n : null)
      // ★p3 は集計オブジェクトを受け取る。キー文字列を直接渡すと a.n が undefined になり
      //   常に null を返す。それで wake_gap が全件NULLになっていた。必ず g() を通すこと。
      const oh = p3(g('rough:out')), ol = p3(g('lo:out')), ih = p3(g('rough:in'))
      if (oh != null && ol != null) o.wake_gap = oh - ol      // 外枠で波が高くても落ちないか
      if (oh != null && ih != null) o.wake_rel = oh - ih      // 波が高いとき外枠が内枠にどれだけ迫れるか
      o.wake_out_hi_n = g('rough:out')?.n ?? 0                   // 標本数（少なければ上2つは信用しない）
    }

    // 決まり手（取った側／取られた側）
    let kt = 0
    for (const [k, v] of p.kimete) { o[`kimete_${k}`] = v; kt += v }
    o.kimete_total = kt
    let yt = 0
    for (const [k, v] of p.yarare) { o[`yarare_${k}`] = v; yt += v }
    o.yarare_total = yt

    // 直近（10走・30走）
    for (const w of [10, 30]) {
      const r = p.recent.slice(-w)
      if (!r.length) continue
      o[`r${w}_n`] = r.length
      o[`r${w}_p1`] = r.filter((x) => x.rank === 1).length / r.length
      o[`r${w}_p3`] = r.filter((x) => x.rank >= 1 && x.rank <= 3).length / r.length
      o[`r${w}_rank`] = r.filter((x) => x.rank).reduce((a, x) => a + x.rank, 0) / (r.filter((x) => x.rank).length || 1)
      const sts = r.filter((x) => x.st != null && x.st > 0)
      if (sts.length) o[`r${w}_st`] = sts.reduce((a, x) => a + x.st, 0) / sts.length
    }

    // 今節（節が変わっていたらまだ空）
    if (p.series && p.series.key === `${m.jcd}:${m.series}`) {
      const s = p.series
      o.konsetsu_n = s.a.n
      if (s.a.n) { o.konsetsu_sho = s.a.pt / s.a.n; if (s.a.stn) o.konsetsu_st = s.a.st / s.a.stn; if (s.a.exn) o.konsetsu_ex = s.a.ex / s.a.exn }
    }

    o.f_count = p.f; o.l_count = p.l; o.dq_count = p.dq
    o.jiko_ritsu = p.all.n ? (p.f + p.l + p.dq) / p.all.n : null
    if (p.entryN) { o.entry_ave = p.entrySum / p.entryN; o.wakunari_rate = p.wakunari / p.entryN }

    // モーター・ボート
    const mo = getM(m.jcd, b.motor_no)
    R(mo.all, 'motor', o)
    R(mo.course.get(b.lane), 'motor_lane', o)
    if (mo.recent.length) {
      const r = mo.recent.slice(-20)
      o.motor_r20_n = r.length
      o.motor_r20_p1 = r.filter((x) => x.rank === 1).length / r.length
      o.motor_r20_p3 = r.filter((x) => x.rank >= 1 && x.rank <= 3).length / r.length
      const ex = r.filter((x) => x.ex)
      if (ex.length) o.motor_r20_ex = ex.reduce((a, x) => a + x.ex, 0) / ex.length
    }
    R(getB(m.jcd, b.boat_no), 'boat', o)

    emit(o)
  }

  // ---- 2) 結果を数える（ここから先は次のレース以降の特徴量になる） ----
  const winner = race.boats.find((x) => x.rank_num === 1)
  for (const b of race.boats) {
    if (!b.racer_id) continue
    const p = getP(b.racer_id)
    const rank = b.rank_num, st = b.st, ex = b.exhibition, c = b.course

    bump(p.all, rank, st, ex)
    if (c) bump(gk(p.course, c), rank, st, ex)
    bump(gk(p.venue, m.jcd), rank, st, ex)
    bump(gk(p.venueCourse, `${m.jcd}:${b.lane}`), rank, st, ex)
    if (m.grade) bump(gk(p.grade, m.grade), rank, st, ex)
    bump(gk(p.wave, wb), rank, st, ex)
    bump(gk(p.wind, nb), rank, st, ex)
    bump(gk(p.rno, rb), rank, st, ex)
    if (hr != null) bump(gk(p.hour, hr), rank, st, ex)
    bump(gk(p.day, db_), rank, st, ex)
    if (nami5) bump(p.nami5, rank, st, ex)
    bump(gk(p.wl, `${waveCoarse(m.wave)}:${laneGroup(b.lane)}`), rank, st, ex)

    if (m.kimarite) {
      if (rank === 1) p.kimete.set(m.kimarite, (p.kimete.get(m.kimarite) ?? 0) + 1)
      // 1コースで負けた＝どう取られたかが分かる（差された／まくられた等）
      else if (c === 1 && winner) p.yarare.set(m.kimarite, (p.yarare.get(m.kimarite) ?? 0) + 1)
    }

    p.recent.push({ rank, st, course: c })
    if (p.recent.length > 60) p.recent.shift()

    if (b.st_flag === 'F') p.f++
    else if (b.st_flag === 'L') p.l++
    if (rank == null) p.dq++

    if (c) { p.entrySum += c; p.entryN++; if (c === b.lane) p.wakunari++ }

    const key = `${m.jcd}:${m.series}`
    if (!p.series || p.series.key !== key) p.series = { key, a: mk() }
    bump(p.series.a, rank, st, ex)

    const mo = getM(m.jcd, b.motor_no)
    bump(mo.all, rank, st, ex)
    bump(gk(mo.course, b.lane), rank, st, ex)
    mo.recent.push({ rank, ex })
    if (mo.recent.length > 40) mo.recent.shift()
    bump(getB(m.jcd, b.boat_no), rank, st, ex)
  }

  if (++processed % 10000 === 0) console.log(`  ${processed.toLocaleString()} / ${races.length.toLocaleString()} レース`)
}

// ---------- 仕上げ ----------
db.exec('COMMIT')
db.exec('CREATE INDEX IF NOT EXISTS idx_feat_racer ON feat(racer_id)')
db.exec('ANALYZE feat')
console.log(`
完了: feat ${one('SELECT COUNT(*) c FROM feat').c.toLocaleString()} 行 × ${cols.length + 2} 列`)
console.log('答え合わせ: node scripts/derive.mjs --verify')
db.close()
