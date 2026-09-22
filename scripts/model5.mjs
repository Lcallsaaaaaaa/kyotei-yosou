// 着順そのもの（1着・2着・3着）を予測する。3連単を売るためのモデル。
//
//   node scripts/model5.mjs
//
// ★なぜ作り直したか
//   model4.mjs は1着しか予測せず、2着3着は Plackett-Luce で機械的に展開していた。
//   その結果、3連単の組み合わせ単位では市場に何も足せなかった（混ぜた係数 市場0.996 / モデル0.066）。
//   3連単のオッズには市場参加者の2着3着の見立てが直接入っている。
//   1着の強さから機械的に割り振るだけでは、そこに勝てない。
//
// ★どう変えたか
//   Plackett-Luce の各段階に**別々の係数**を持たせる。
//     1着の選ばれやすさ  s1 = w1・x
//     1着が抜けた後の2着 s2 = w2・x
//     2着まで抜けた後の3着 s3 = w3・x
//   「1着になる力」と「2着に粘る力」は違うはずで、実際モーターの伸びや
//   ST、コースの効き方は着順ごとに意味が変わる。同じ係数を使い回す理由がない。
//
// ★検証のしかたは model4 と同じ
//   学習→補正→検証の3期間に分け、検証期間は買い方を決めるのに一切使わない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const TOPN = Number(flag('top', 30))

// ---------- 読み込み ----------
// ★--morning ＝ 朝（02:00）に実在する入力だけで学習する。
//   2026-09-06に見つけた食い違い：学習は races.wave / wind_speed を使うが、これは
//   競走成績(Kファイル)＝レース後の値。02:00バッチの predict.mjs --nobefore は
//   波高・風速の取得ごと飛ばすので、本番は常に「不明」になる。
//   学習期間には波高NULLのレースが**0本**＝モデルは「不明」を一度も見ていない。
//   その結果、検証 的中81.0%/回収96.2% に対し前向き実測は 73.2%/86.5% まで落ちた
//   （grade を埋めた後の数字。grade だけでは差の1/3しか埋まらなかった）。
//   落とすもの:
//     bf_*      直前情報（展示タイム・チルト・部品交換・体重・気温・水温）
//     waveb_*   その選手の「その波高帯」の成績 … 波高が要る
//     windb_*   その選手の「その風速帯」の成績 … 風速が要る
//     nami5_*   波5cm以上かどうかの成績     … 波高が要る
//     条件補正の wave / wind
//   ⚠ 展示を入れても1着的中は変わらない（57.18%対57.38%・2026-08-31実測）が、
//     それは全体の話。**高確率帯の較正は別**で、そこが商品になる部分。
const MORNING = argv.includes('--morning')
const NOMORN = /^(bf_|waveb_|windb_|nami5_)/
const featCols = all(`PRAGMA table_info(feat)`).map((c) => c.name)
  .filter((c) => !(MORNING && NOMORN.test(c)))
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
console.log(`特徴量 ${featCols.length} 項目`)

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
// ⚠ ここを all() で受けてはいけない。345,300行×194列のJSオブジェクトを丸ごと抱えると
//   Float64Array と合わせて5GBを超え、必ず OOM で落ちる（2026-09-06に3.5GBと5.1GBの
//   両方で "Reached heap limit" を出した。この機械は総メモリ7.8GBで常時2.5GB使用中）。
//   ⚠ 上限を上げても下げても直らない。**行オブジェクトを溜めないこと**が唯一の対処。
//   iterate() で1行ずつ受け、その場で Float64Array に変換して捨てる（下の「レース単位に
//   まとめる」を参照）。SQL文だけをここに置く。
const ROWSQL = `
  SELECT f.race_id, f.lane, f.course, r.date, r.jcd, r.grade, r.race_no, r.wave, r.wind_speed,
         r.deadline, r.day_no, r.series, r.title,
         e.rank_num, p.age, p.weight, p.win_rate_nat, p.top2_nat, p.win_rate_loc, p.top2_loc,
         p.motor_top2, p.boat_top2, p.hayami,
         p.grade AS pgrade, p.branch AS pbranch, f.racer_id AS rid,
         ${featCols.map((c) => `f.${q(c)}`).join(', ')}
  FROM feat f
  JOIN races r ON r.race_id = f.race_id
  JOIN entries e ON e.race_id = f.race_id AND e.lane = f.lane
  LEFT JOIN programs p ON p.race_id = f.race_id AND p.lane = f.lane
  ORDER BY r.date, f.race_id, f.lane`

// 番組表の項目も入れる（年齢・体重・級別・当地勝率など。ユーザー指摘の「人の側」）
// ★級別(A1/A2/B1/B2)・支部・期別成績を足した
//   級別の1着率は A1 27.2% / A2 20.6% / B1 10.9% / B2 5.0% と5倍以上開くのに入れていなかった。
//   勝率経由で間接的には効くが、級別そのものは「その期の格付け」という別の情報。
//   期別成績(racer_period)は25年分76,684行あるのに一度も使っていなかった。
//   ★レース日より前に確定している期のものだけを引く（未来の期を引くと結果が混ざる）。
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami',
  'rsex', 'rheight', 'rwin', 'rtop2', 'rstarts',
  '_gA1', '_gA2', '_gB1', '_gB2', '_jimoto']
// ★掛け合わせのダミーを入れる
//   bias.mjs で調べたところ、場・グレード・波・風・レース番号・日目を**単独**で見ると
//   系統的なずれは無かった。ずれは全部「コースとの掛け合わせ」に出ていた：
//     G1の1コース +14.3pt / 戸田の1コース −12.9pt / 風6m以上の1コース −8.3pt
//     女子戦の1コース −5.0pt / 波6-9cmの1コース −7.9pt
//   選手ごとの当地成績は入れていたが、**水面そのものの性質**（戸田は1コースが飛ばない等）を
//   表す項目が無かった。だから条件×コースの組を明示的に入れる。
//
// ★開催の日程とレースの格
//   「第4日」だけでは意味が決まらない。4日制なら最終日、6日制ならまだ中盤で走る動機が違う。
//   開催の総日数は 4日制118 / 5日制139 / 6日制490 / 7日制28 開催と割れているので、
//   **総日数・残り日数・何割進んだか**を持たないと第N日は解釈できない。
//   さらに title には 優勝戦818 / 準優勝戦2237 / ドリーム戦322 / 選抜戦1119 が入っているのに
//   これらを一切使っていなかった。予選と優勝戦を同じものとして扱っていたことになる。
//   進入固定（836レース）も、前づけが起きない＝コースが枠番で決まるという強い条件。
const seriesLen = new Map()
for (const r of all(`SELECT jcd, series, MAX(day_no) d FROM races WHERE series IS NOT NULL GROUP BY jcd, series`))
  seriesLen.set(`${r.jcd}:${r.series}`, r.d)

/** タイトルからレースの格を判定する。複数該当しうるので配列で返す */
const titleFlags = (t) => {
  const s = String(t ?? '')
  const f = []
  if (/優勝戦/.test(s) && !/準優/.test(s)) f.push('yusho')
  if (/準優/.test(s)) f.push('junyu')
  if (/予選/.test(s)) f.push('yosen')
  if (/ドリーム/.test(s)) f.push('dream')
  if (/選抜/.test(s)) f.push('senbatsu')
  if (/特選|特賞/.test(s)) f.push('tokusen')
  if (/進入固定/.test(s)) f.push('shinnyukotei')
  if (!f.length) f.push('ippan')
  return f
}

// ---------- 期別成績（レース日より前に確定した期だけを引く） ----------
// ★期は YYYY-04 / YYYY-10 の半期。レースと同じ月の期はまだ公表されていない可能性があるので、
//   **レース月より厳密に前**の期だけを使う。ここを緩めると未来の成績が混ざる。
//   25年分76,684行あるのに一度も使っていなかったデータ。
const PERIODS = new Map()
for (const r of all(`SELECT period, racer_id, sex, height, win_rate, top2_rate, starts
  FROM racer_period ORDER BY racer_id, period`)) {
  let a = PERIODS.get(r.racer_id); if (!a) { a = []; PERIODS.set(r.racer_id, a) }
  a.push(r)
}
const periodOf = (racerId, date) => {
  const a = PERIODS.get(racerId); if (!a) return null
  const ym = date.slice(0, 7)
  let best = null
  for (const x of a) { if (x.period < ym) best = x; else break }
  return best
}
console.log(`  期別成績 ${PERIODS.size} 選手ぶんを読み込み`)

// 支部と開催場の対応。地元かどうかの判定に使う（水面への慣れ）。
const BRANCH_JCD = { 群馬:1, 埼玉:2, 東京:3, 静岡:6, 愛知:7, 三重:9, 福井:10, 滋賀:11,
  大阪:12, 兵庫:13, 徳島:14, 香川:15, 岡山:16, 広島:17, 山口:18, 福岡:22, 佐賀:23, 長崎:24 }
const waveBk = (w) => (w == null ? 'x' : w <= 2 ? 'a' : w <= 5 ? 'b' : w <= 9 ? 'c' : 'd')
const windBk = (w) => (w == null ? 'x' : w <= 1 ? 'a' : w <= 3 ? 'b' : w <= 5 ? 'c' : 'd')
const hourBk = (t) => { const m = String(t ?? '').match(/^(\d{1,2}):/); return m ? m[1] : 'x' }
const GRADES = [...new Set(all(`SELECT DISTINCT grade FROM races WHERE grade IS NOT NULL`).map((r) => r.grade))]

const TFLAGS = ['yusho', 'junyu', 'yosen', 'dream', 'senbatsu', 'tokusen', 'shinnyukotei', 'ippan']
const LENS = [1, 2, 3, 4, 5, 6, 7]

// ★ダミーではなく「1条件＝1数値」にする
//   最初は 場×コース などを自由なダミー1,290本として入れたが、
//   的中率が 54.8%→40.2%（発散）、希少ダミーを間引いても 51.4%（過学習）と、
//   どちらも土台を下回った。3.2万レースに対して自由な係数が多すぎる。
//
//   代わりに、条件ごとの「そのコースの標準からのずれ」を **学習期間だけで測り**、
//   1条件あたり1つの数値に圧縮する。係数は条件の種類ごとに1本だけになる。
//   件数の少ない条件は n/(n+K) で0に寄せる（縮小推定）ので、
//   「戸田の1コースは480件あるから効かせる、7日制10日目は少ないから効かせない」が自動で決まる。
// ★--morning のときは wave / wind を外す（02:00には波高も風速も分からない）
const XTYPES = ['jcd', 'grade', 'wave', 'wind', 'rno', 'hour', 'day', 'len', 'left', 'lenday', 'title']
  .filter((t) => !(MORNING && (t === 'wave' || t === 'wind')))

/** そのレース・その艇が属する条件を、種類ごとに1つ返す */
const XKEY = (r) => {
  // ★進入コースではなく枠番を使う。進入が決まるのは締切後で、買う時点では分からない。
  //   実測でも進入=枠番は約85%しか一致しない。実進入を使うと検証結果が実際より良く出る。
  const c = r.lane
  if (!(c >= 1 && c <= 6)) return null
  const len = seriesLen.get(`${r.jcd}:${r.series}`) ?? 'x'
  const left = len !== 'x' && r.day_no != null ? len - r.day_no : 'x'
  const tf = titleFlags(r.title)
  // 格は複数該当しうるが、優勝戦>準優>ドリーム>選抜>特選>進入固定>予選>一般 の順で1つに決める
  const t = ['yusho', 'junyu', 'dream', 'senbatsu', 'tokusen', 'shinnyukotei', 'yosen', 'ippan'].find((x) => tf.includes(x))
  return {
    jcd: `${r.jcd}|${c}`,
    grade: `${r.grade ?? 'x'}|${c}`,
    wave: `${waveBk(r.wave)}|${c}`,
    wind: `${windBk(r.wind_speed)}|${c}`,
    rno: `${r.race_no}|${c}`,
    hour: `${hourBk(r.deadline)}|${c}`,
    day: `${r.day_no ?? 'x'}|${c}`,
    len: `${len}|${c}`,
    left: `${left}|${c}`,
    lenday: `${len}-${r.day_no ?? 'x'}|${c}`,
    title: `${t}|${c}`,
    _course: c,
  }
}

// 使う項目＝特徴量＋番組表＋コースダミー＋条件ごとの補正値（種類ごとに1つ）
const NAMES = [...featCols, ...progCols, ...[1, 2, 3, 4, 5, 6].map((c) => `_course${c}`),
  ...XTYPES.map((t) => `adj_${t}`)]
const D = NAMES.length
const XOFF = featCols.length + progCols.length + 6
console.log(`  条件補正 ${XTYPES.length} 項目（合計 ${D} 項目）`)

const vec = (r) => {
  const v = new Float64Array(D)
  for (let i = 0; i < featCols.length; i++) { const x = r[featCols[i]]; v[i] = x == null ? NaN : x }
  for (let i = 0; i < progCols.length; i++) {
    const k = progCols[i]
    let x
    if (k === '_gA1') x = r.pgrade === 'A1' ? 1 : 0
    else if (k === '_gA2') x = r.pgrade === 'A2' ? 1 : 0
    else if (k === '_gB1') x = r.pgrade === 'B1' ? 1 : 0
    else if (k === '_gB2') x = r.pgrade === 'B2' ? 1 : 0
    else if (k === '_jimoto') x = BRANCH_JCD[r.pbranch] === r.jcd ? 1 : 0   // 支部と開催場が同じ＝地元
    else if (k[0] === 'r' && ['rsex', 'rheight', 'rwin', 'rtop2', 'rstarts'].includes(k)) {
      const pp = periodOf(r.rid, r.date)
      x = pp ? { rsex: pp.sex, rheight: pp.height, rwin: pp.win_rate, rtop2: pp.top2_rate, rstarts: pp.starts }[k] : null
    }
    else x = r[k]
    v[featCols.length + i] = x == null ? NaN : x
  }
  // ★進入コースではなく枠番を使う。進入が決まるのは締切後で、買う時点では分からない。
  //   実測でも進入=枠番は約85%しか一致しない。実進入を使うと検証結果が実際より良く出る。
  const c = r.lane
  if (c >= 1 && c <= 6) v[featCols.length + progCols.length + c - 1] = 1
  return v
}

// ---------- レース単位にまとめる ----------
// ★1行ずつ受けて、その場で Float64Array に変換して行オブジェクトを捨てる。
//   all() で全行を配列に持つと OOM で落ちる（上の ROWSQL のコメントを参照）。
const races = []
{
  let cur = null, n = 0
  for (const r of db.prepare(ROWSQL).iterate()) {
    n++
    if (!cur || cur.race_id !== r.race_id) { cur = { race_id: r.race_id, date: r.date, boats: [] }; races.push(cur) }
    cur.boats.push({ x: vec(r), y: r.rank_num === 1 ? 1 : 0, lane: r.lane, course: r.course, k: XKEY(r) })
  }
  console.log(`${n.toLocaleString()} 行`)
}
// 6艇そろっていて1着が1つだけのレースだけ使う（欠場等を除く）
const usable = races.filter((g) => g.boats.length === 6 && g.boats.filter((b) => b.y).length === 1)
console.log(`使えるレース ${usable.length.toLocaleString()} / ${races.length.toLocaleString()}`)

// ---------- 期間を3つに分ける ----------
// ★補正（キャリブレーション）を検証期間で作ってはいけない。
//   それをやると「補正後にぴったり合う」のは当たり前で、実力を測ったことにならない。
//   学習 → 補正 → 検証 の3つに分け、検証期間は最後まで一度も見ない。
const dates = [...new Set(usable.map((g) => g.date))].sort()
// ★--train-to / --calib-to / --test-to で期間を指定できる（2026-09-14）。
//   指定しなければ従来どおり 60% / 75% で切る。
//   毎日の再学習で「直近を検証に残し、その手前まで学習する」切り方にするために使う。
//   ⚠ 補正(calib)期間は実際には何の補正にも使っていない。2つめの検証期間であり、
//     閾値（無料枠0.80・配信0.7645）を出す元になる。
const cut1 = flag('train-to') ?? dates[Math.floor(dates.length * 0.60)]
const cut2 = flag('calib-to') ?? dates[Math.floor(dates.length * 0.75)]
const testTo = flag('test-to') ?? null
const train = usable.filter((g) => g.date < cut1)
const calib = usable.filter((g) => g.date >= cut1 && g.date < cut2)
const test = usable.filter((g) => g.date >= cut2 && (!testTo || g.date <= testTo))
console.log(`学習 ${train.length.toLocaleString()}レース (〜${cut1})`)
console.log(`補正 ${calib.length.toLocaleString()}レース (${cut1}〜${cut2})`)
console.log(`検証 ${test.length.toLocaleString()}レース (${cut2}〜)\n`)

// ---------- 条件ごとの補正値を、学習期間だけで測る ----------
// ★検証期間の結果を使って作ってはいけない。使うと当然よく当たり、実力を測れない。
//   各条件について「そのコースの標準的な1着率」からのずれを対数オッズで測り、
//   件数に応じて n/(n+K) だけ効かせる。K=200。
//   例：戸田1コースは480件あるので 480/680 = 71% 効かせる。
//       7日制10日目のような希少な条件はほぼ0になり、悪さをしない。
const SHRINK_K = 200
const encoders = {}
{
  const courseAgg = new Map()   // コース → {n, w}
  const keyAgg = {}             // 種類 → キー → {n, w}
  for (const t of XTYPES) keyAgg[t] = new Map()
  for (const g of train) for (const b of g.boats) {
    if (!b.k) continue
    const ca = courseAgg.get(b.k._course) ?? { n: 0, w: 0 }
    ca.n++; ca.w += b.y; courseAgg.set(b.k._course, ca)
    for (const t of XTYPES) {
      const m = keyAgg[t]
      const e = m.get(b.k[t]) ?? { n: 0, w: 0 }
      e.n++; e.w += b.y; m.set(b.k[t], e)
    }
  }
  const lo = (p) => Math.log(Math.min(Math.max(p, 1e-4), 1 - 1e-4) / (1 - Math.min(Math.max(p, 1e-4), 1 - 1e-4)))
  const courseLo = new Map([...courseAgg].map(([c, a]) => [c, lo(a.w / a.n)]))
  for (const t of XTYPES) {
    const m = new Map()
    for (const [k, e] of keyAgg[t]) {
      const c = Number(k.split('|')[1])
      const raw = lo(e.w / e.n) - (courseLo.get(c) ?? 0)
      m.set(k, raw * (e.n / (e.n + SHRINK_K)))
    }
    encoders[t] = m
  }
  console.log(`  条件補正を作成: ${XTYPES.map((t) => `${t}=${encoders[t].size}`).join(' ')}`)
}
for (const g of usable) for (const b of g.boats) {
  if (!b.k) continue
  XTYPES.forEach((t, i) => { b.x[XOFF + i] = encoders[t].get(b.k[t]) ?? 0 })
}

// ---------- 標準化（学習期間だけで平均と分散を決める。検証期間を見てはいけない） ----------
const mean = new Float64Array(D), sd = new Float64Array(D), cnt = new Float64Array(D)
for (const g of train) for (const b of g.boats) for (let i = 0; i < D; i++) { const v = b.x[i]; if (Number.isFinite(v)) { mean[i] += v; cnt[i]++ } }
for (let i = 0; i < D; i++) mean[i] = cnt[i] ? mean[i] / cnt[i] : 0
for (const g of train) for (const b of g.boats) for (let i = 0; i < D; i++) { const v = b.x[i]; if (Number.isFinite(v)) sd[i] += (v - mean[i]) ** 2 }
for (let i = 0; i < D; i++) sd[i] = cnt[i] > 1 ? Math.sqrt(sd[i] / cnt[i]) || 1 : 1

// 欠測は平均で埋める（標準化後は0）。埋めたこと自体が情報なので、主要項目は欠測フラグも足したいが
// まずは全項目を素直に入れて、効くかどうかを見る。
// ★ダミー（0/1）は標準化しない。そのまま0/1で使う。
//   標準化すると希少なダミーほど値が巨大になり、学習が発散する。
const norm = (g) => {
  for (const b of g.boats) for (let i = 0; i < D; i++) {
    const v = b.x[i]
    if (i >= XOFF) { b.x[i] = Number.isFinite(v) ? v : 0; continue }  // 条件補正は既に対数オッズなので標準化しない
    b.x[i] = Number.isFinite(v) ? (v - mean[i]) / sd[i] : 0
  }
}
for (const g of usable) norm(g)


// ---------- 着順を各レースに付ける ----------
// 1着・2着・3着が誰か。3着まで揃っていないレースは使えない。
{
  const ord = new Map()
  for (const r of all(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`)) {
    let m = ord.get(r.race_id); if (!m) { m = {}; ord.set(r.race_id, m) }
    m[r.rank_num] = r.lane
  }
  for (const g of usable) {
    const m = ord.get(g.race_id)
    g.ord = m && m[1] && m[2] && m[3] ? [m[1], m[2], m[3]] : null
  }
}
const ok3 = (l) => l.filter((g) => g.ord)
console.log(`3着まで確定しているレース ${ok3(usable).length.toLocaleString()} / ${usable.length.toLocaleString()}`)

// ---------- Plackett-Luce（段階ごとに別の係数） ----------
// 各段階で「まだ残っている艇の中から1つ選ばれる」形。段階ごとに係数を分ける。
function fitPL(list, { lr = 0.25, epochs = 100, l2 = 3e-4 } = {}) {
  const W = [new Float64Array(D), new Float64Array(D), new Float64Array(D)]
  const M = [new Float64Array(D), new Float64Array(D), new Float64Array(D)]
  const V = [new Float64Array(D), new Float64Array(D), new Float64Array(D)]
  const races = ok3(list)
  for (let ep = 1; ep <= epochs; ep++) {
    const G = [new Float64Array(D), new Float64Array(D), new Float64Array(D)]
    let ll = 0
    for (const race of races) {
      const bs = race.boats
      const laneIdx = new Map(bs.map((b, i) => [b.lane, i]))
      const gone = new Set()
      for (let st = 0; st < 3; st++) {
        const w = W[st], g = G[st]
        const cand = []
        for (let i = 0; i < bs.length; i++) if (!gone.has(i)) cand.push(i)
        const s = cand.map((i) => { let z = 0; const x = bs[i].x; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z })
        const mx = Math.max(...s)
        const ex = s.map((z) => Math.exp(z - mx))
        const sum = ex.reduce((a, b) => a + b, 0)
        const pick = laneIdx.get(race.ord[st])
        if (pick === undefined) break
        const pos = cand.indexOf(pick)
        if (pos < 0) break
        ll += Math.log(Math.max(ex[pos] / sum, 1e-12))
        // 勾配: 選ばれたものの x から、確率で重み付けした平均の x を引く
        for (let k = 0; k < cand.length; k++) {
          const q = ex[k] / sum
          const x = bs[cand[k]].x
          const coef = (cand[k] === pick ? q - 1 : q)
          for (let d = 0; d < D; d++) g[d] += coef * x[d]
        }
        gone.add(pick)
      }
    }
    const n = races.length
    for (let st = 0; st < 3; st++) {
      for (let d = 0; d < D; d++) {
        const gi = G[st][d] / n + l2 * W[st][d]
        M[st][d] = 0.9 * M[st][d] + 0.1 * gi
        V[st][d] = 0.999 * V[st][d] + 0.001 * gi * gi
        W[st][d] -= lr * (M[st][d] / (1 - 0.9 ** ep)) / (Math.sqrt(V[st][d] / (1 - 0.999 ** ep)) + 1e-8)
      }
    }
    if (ep % 20 === 0 || ep === epochs) console.log(`    epoch ${ep}  学習logloss(3着まで) ${(-ll / n).toFixed(4)}`)
  }
  return W
}

/** 120通りの確率を出す */
function trioProbs(W, race) {
  const bs = race.boats
  const sc = [0, 1, 2].map((st) => bs.map((b) => { let z = 0; const x = b.x; for (let d = 0; d < D; d++) z += W[st][d] * x[d]; return z }))
  const lane = bs.map((b) => b.lane)
  const out = []
  for (let a = 0; a < 6; a++) {
    const e1 = bs.map((_, i) => Math.exp(sc[0][i] - Math.max(...sc[0])))
    const s1 = e1.reduce((x, y) => x + y, 0)
    const p1 = e1[a] / s1
    for (let b = 0; b < 6; b++) {
      if (b === a) continue
      const c2 = [...Array(6).keys()].filter((i) => i !== a)
      const m2 = Math.max(...c2.map((i) => sc[1][i]))
      const e2 = c2.map((i) => Math.exp(sc[1][i] - m2))
      const s2 = e2.reduce((x, y) => x + y, 0)
      const p2 = e2[c2.indexOf(b)] / s2
      for (let c = 0; c < 6; c++) {
        if (c === a || c === b) continue
        const c3 = [...Array(6).keys()].filter((i) => i !== a && i !== b)
        const m3 = Math.max(...c3.map((i) => sc[2][i]))
        const e3 = c3.map((i) => Math.exp(sc[2][i] - m3))
        const s3 = e3.reduce((x, y) => x + y, 0)
        const p3 = e3[c3.indexOf(c)] / s3
        out.push({ combo: `${lane[a]}-${lane[b]}-${lane[c]}`, p: p1 * p2 * p3 })
      }
    }
  }
  return out
}

console.log('\n【段階別Plackett-Luce】1着・2着・3着に別々の係数を持たせる')
const W = fitPL(train, { epochs: 100 })

// 3連単の logloss で、機械展開版（model4のpred）と比べる
const winCombo = new Map()
for (const r of all(`SELECT race_id, combo FROM payouts WHERE bet_type='sanrentan'`)) winCombo.set(r.race_id, r.combo)
function evalTrio(list, label) {
  let ll = 0, n = 0, hit = 0
  for (const race of ok3(list)) {
    const w = winCombo.get(race.race_id); if (!w) continue
    const ps = trioProbs(W, race)
    const tot = ps.reduce((a, x) => a + x.p, 0)
    const m = new Map(ps.map((x) => [x.combo, x.p / tot]))
    ll += Math.log(Math.max(m.get(w) ?? 1e-12, 1e-12))
    let best = null
    for (const [c, p] of m) if (!best || p > best[1]) best = [c, p]
    if (best[0] === w) hit++
    n++
  }
  console.log(`  ${label}  3連単logloss ${(-ll / n).toFixed(4)}  最有力1点の的中率 ${((hit / n) * 100).toFixed(2)}%  (${n.toLocaleString()}レース)`)
}
evalTrio(test, '検証期間')

// ---------- 保存 ----------
// ★--no-pred3 … pred3 を書き換えない。
//   pred3 は「本番で使うモデルの出力」であって、閾値・分位点はここから出す。
//   直前情報あり用のフルモデルを学習するときに pred3 を上書きすると、
//   朝モデルで出した閾値と食い違う。だからフル側は JSON だけ作る。
const NOPRED3 = argv.includes('--no-pred3')
if (!NOPRED3) {
// ★--pred3-table で出力先を変えられる。比較用の学習で本番の pred3（閾値の元）を壊さないため。
const P3 = flag('pred3-table') ?? 'pred3'
if (!/^pred3[a-z0-9_]*$/.test(P3)) throw new Error('--pred3-table は pred3 で始まる英小文字・数字・_ だけ: ' + P3)
db.exec(`DROP TABLE IF EXISTS ${P3}`)
db.exec(`CREATE TABLE ${P3} (race_id TEXT NOT NULL, combo TEXT NOT NULL, p REAL, split TEXT,
  PRIMARY KEY (race_id, combo))`)
const ins = db.prepare(`INSERT OR REPLACE INTO ${P3} (race_id,combo,p,split) VALUES (?,?,?,?)`)
db.exec('BEGIN')
let nSaved = 0
for (const [list, sp] of [[calib, 'calib'], [test, 'test']])
  for (const race of ok3(list)) {
    const ps = trioProbs(W, race)
    const tot = ps.reduce((a, x) => a + x.p, 0)
    for (const x of ps) { ins.run(race.race_id, x.combo, x.p / tot, sp); if (++nSaved % 200000 === 0) { db.exec('COMMIT'); db.exec('BEGIN') } }
  }
db.exec('COMMIT')
db.exec(`CREATE INDEX IF NOT EXISTS idx_${P3}_split ON ${P3}(split)`)
db.exec(`ANALYZE ${P3}`)
console.log(`\n${P3} に保存 ${nSaved.toLocaleString()} 行`)
} else { console.log('\n--no-pred3 のため pred3 は触っていない') }

// ---------- これから走るレースの予想に使えるよう、モデルを丸ごと保存する ----------
// ★係数だけでは足りない。標準化の平均・分散と、条件補正の対応表も一緒に要る。
//   学習時と違う基準で標準化したら、同じ係数でもまったく違う予測になる。
// ★--out で保存先を変えられる。直前情報あり用のフルモデルは data/model5-full.json に置く。
const OUT = flag('out', null) ?? join(ROOT, 'data', 'model5.json')
writeFileSync(OUT, JSON.stringify({
  names: NAMES, featCols, progCols, xtypes: XTYPES,
  w: W.map((a) => [...a]), mean: [...mean], sd: [...sd], xoff: XOFF,
  encoders: Object.fromEntries(XTYPES.map((t) => [t, [...encoders[t]]])),
  trainedTo: cut1, calibTo: cut2, testTo, builtAt: new Date().toISOString(),
}))
console.log(OUT + ' にモデルを保存')
db.close()
