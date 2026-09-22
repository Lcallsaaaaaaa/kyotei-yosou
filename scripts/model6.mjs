// 2着・3着を「誰が先に決まったか」を見て予測するモデル。
//
//   node scripts/model6.mjs --from 2026-03-01 --first 3 --t1 wc1 --t3 wc3
//
// ★これまでの欠陥
//   1着・2着・3着に別々の係数を持たせてはいたが、
//   **2着を選ぶときに「誰が1着だったか」を見ていなかった**。
//   競艇では4号艇がまくって勝てば1号艇は3〜4着に沈み、
//   1号艇が逃げれば2号艇が差して2着に来る。1着の顔ぶれで2着以下の構図が変わる。
//   これを見ないPlackett-Luceは、競艇の構造を無視している。
//   実際そのせいで3連単は市場に勝てず、単勝だけ勝てていた。
//
// ★足したもの（学習期間だけで作る）
//   cond_a : 2着を選ぶとき = P(自分が2着 | 1着が誰か) の対数オッズ
//            3着を選ぶとき = P(自分が3着 | 1着が誰か)
//   cond_b : 3着を選ぶとき = P(自分が3着 | 2着が誰か)
//   どちらも「1着の枠 × 自分の枠」の36通りを実測し、件数で縮小して使う。
//
// ★検証は walk.mjs と同じ手順
//   月ごとに作り直し、その月より前のデータだけで学習する。
//   実測でも進入=枠番は約85%しか一致せず、実進入を使うと成績が実際より良く出る。
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
// --nobf を付けると直前情報(bf_*)を外す。入れた場合と外した場合を同じ期間で比べるため。
const NOBF = argv.includes('--nobf')
const T1 = flag('t1', 'walk1'), T3 = flag('t3', 'walk3')
const FROM = flag('from', null)
const featCols = all(`PRAGMA table_info(feat)`).map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !(NOBF && c.startsWith('bf_')))
if (FROM) console.log(`期間を ${FROM} 以降に限定`)
if (NOBF) console.log('直前情報(bf_*)を外して学習する')
console.log(`特徴量 ${featCols.length} 項目`)

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const rows = all(`
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
  ${FROM ? "WHERE r.date >= '" + FROM + "'" : ''}
  ORDER BY r.date, f.race_id, f.lane`)
console.log(`${rows.length.toLocaleString()} 行`)

// 番組表の項目も入れる（年齢・体重・級別・当地勝率など。ユーザー指摘の「人の側」）
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
const XTYPES = ['jcd', 'grade', 'wave', 'wind', 'rno', 'hour', 'day', 'len', 'left', 'lenday', 'title']

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
const races = []
{
  let cur = null
  for (const r of rows) {
    if (!cur || cur.race_id !== r.race_id) { cur = { race_id: r.race_id, date: r.date, boats: [] }; races.push(cur) }
    cur.boats.push({ x: vec(r), y: r.rank_num === 1 ? 1 : 0, lane: r.lane, course: r.course, k: XKEY(r) })
  }
}
// 6艇そろっていて1着が1つだけのレースだけ使う（欠場等を除く）
const usable = races.filter((g) => g.boats.length === 6 && g.boats.filter((b) => b.y).length === 1)
console.log(`使えるレース ${usable.length.toLocaleString()} / ${races.length.toLocaleString()}`)


// ---------- 歩進検証（月ごとにモデルを作り直す） ----------
// ★これが「過去レースの予想テスト全部」の本体
//   1回だけ期間を切って測ると、たまたまその期間に合っただけかもしれない。
//   月ごとに「その月より前のデータだけ」で学習し直し、その月を予想する。
//   1年ぶん繰り返せば、ほぼ全レースが未使用データとして検証される。
//
// ★条件補正と標準化は最初の学習窓だけで決める
//   毎月作り直すには元の値を持ち回る必要があり、記憶が足りない（197項目×33万行）。
//   最初の窓だけで決めるぶんには未来が混ざらないので、検証としては正しい。
const months = [...new Set(usable.map((g) => g.date.slice(0, 7)))].sort()
const FIRST = Number(flag('first', 5))
const folds = months.slice(FIRST)
console.log(`\n${months[0]} 〜 ${months[months.length - 1]}  最初の${FIRST}ヶ月で学習し、残り${folds.length}ヶ月を検証`)

const initTrain = usable.filter((g) => g.date.slice(0, 7) < months[FIRST])
console.log(`初期学習窓 ${initTrain.length.toLocaleString()}レース`)

const SHRINK_K = 200
const encoders = {}
{
  const courseAgg = new Map(), keyAgg = {}
  for (const t of XTYPES) keyAgg[t] = new Map()
  for (const g of initTrain) for (const b of g.boats) {
    if (!b.k) continue
    const ca = courseAgg.get(b.k._course) ?? { n: 0, w: 0 }
    ca.n++; ca.w += b.y; courseAgg.set(b.k._course, ca)
    for (const t of XTYPES) { const m = keyAgg[t]; const e = m.get(b.k[t]) ?? { n: 0, w: 0 }; e.n++; e.w += b.y; m.set(b.k[t], e) }
  }
  const lo = (p) => { const v = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(v / (1 - v)) }
  const courseLo = new Map([...courseAgg].map(([c, a]) => [c, lo(a.w / a.n)]))
  for (const t of XTYPES) {
    const m = new Map()
    for (const [k, e] of keyAgg[t]) {
      const c = Number(k.split('|')[1])
      m.set(k, (lo(e.w / e.n) - (courseLo.get(c) ?? 0)) * (e.n / (e.n + SHRINK_K)))
    }
    encoders[t] = m
  }
}
for (const g of usable) for (const b of g.boats) if (b.k) XTYPES.forEach((t, i) => { b.x[XOFF + i] = encoders[t].get(b.k[t]) ?? 0 })

{
  const mean = new Float64Array(D), sd = new Float64Array(D), cnt = new Float64Array(D)
  for (const g of initTrain) for (const b of g.boats) for (let i = 0; i < D; i++) { const v = b.x[i]; if (Number.isFinite(v)) { mean[i] += v; cnt[i]++ } }
  for (let i = 0; i < D; i++) mean[i] = cnt[i] ? mean[i] / cnt[i] : 0
  for (const g of initTrain) for (const b of g.boats) for (let i = 0; i < D; i++) { const v = b.x[i]; if (Number.isFinite(v)) sd[i] += (v - mean[i]) ** 2 }
  for (let i = 0; i < D; i++) sd[i] = cnt[i] > 1 ? Math.sqrt(sd[i] / cnt[i]) || 1 : 1
  for (const g of usable) for (const b of g.boats) for (let i = 0; i < D; i++) {
    const v = b.x[i]
    if (i >= XOFF) { b.x[i] = Number.isFinite(v) ? v : 0; continue }
    b.x[i] = Number.isFinite(v) ? (v - mean[i]) / sd[i] : 0
  }
}

{
  const ord = new Map()
  for (const r of all(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`)) {
    let m = ord.get(r.race_id); if (!m) { m = {}; ord.set(r.race_id, m) }
    m[r.rank_num] = r.lane
  }
  for (const g of usable) { const m = ord.get(g.race_id); g.ord = m && m[1] && m[2] && m[3] ? [m[1], m[2], m[3]] : null }
}
const ok3 = (l) => l.filter((g) => g.ord)


// ---------- 条件付きの効き目を学習期間から測る ----------
// ★「1着が4号艇のとき、1号艇が2着になる確率」のような組み合わせを実測する。
//   枠は6通りなので 6×6=36 通り。件数が十分あるので安定して測れる。
//   全体の平均からのずれを対数オッズで持ち、件数で縮小する（walk.mjs の条件補正と同じ考え）。
const CK = 300
const lo = (p) => { const v = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(v / (1 - v)) }

function fitCond(races) {
  // [1着の枠][自分の枠] → 2着になった率 / 3着になった率
  const mk2 = () => Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => ({ n: 0, w: 0 })))
  const a2 = mk2(), a3 = mk2(), b3 = mk2()
  let base2 = { n: 0, w: 0 }, base3 = { n: 0, w: 0 }
  for (const g of races) {
    const [w1, w2, w3] = g.ord
    for (const b of g.boats) {
      if (b.lane === w1) continue
      // 2着の候補（1着以外の5艇）
      const e = a2[w1][b.lane]; e.n++; base2.n++
      if (b.lane === w2) { e.w++; base2.w++ }
      if (b.lane === w2) continue
      // 3着の候補（1着2着以外の4艇）
      const f = a3[w1][b.lane]; f.n++; base3.n++
      const h = b3[w2][b.lane]; h.n++
      if (b.lane === w3) { f.w++; h.w++; base3.w++ }
    }
  }
  const L2 = lo(base2.w / Math.max(base2.n, 1)), L3 = lo(base3.w / Math.max(base3.n, 1))
  const conv = (arr, L) => arr.map((row) => row.map((e) => (e.n ? (lo(e.w / e.n) - L) * (e.n / (e.n + CK)) : 0)))
  return { a2: conv(a2, L2), a3: conv(a3, L3), b3: conv(b3, L3) }
}

// ---------- 学習（条件付き項を足したPlackett-Luce） ----------
// 係数は D+2 本。最後の2本が cond_a / cond_b にかかる。
const DC = D + 2
const IA = D, IB = D + 1

/** 段階stで、既に決まった枠を踏まえた条件値を返す */
const condOf = (C, st, myLane, w1, w2) => {
  if (st === 0) return [0, 0]
  if (st === 1) return [C.a2[w1][myLane] ?? 0, 0]
  return [C.a3[w1][myLane] ?? 0, C.b3[w2][myLane] ?? 0]
}

function fitPL(races, C, { lr = 0.25, epochs = 70, l2 = 3e-4 } = {}) {
  const W = [0, 1, 2].map(() => new Float64Array(DC))
  const MM = [0, 1, 2].map(() => new Float64Array(DC))
  const VV = [0, 1, 2].map(() => new Float64Array(DC))
  for (let ep = 1; ep <= epochs; ep++) {
    const G = [0, 1, 2].map(() => new Float64Array(DC))
    for (const race of races) {
      const bs = race.boats
      const laneIdx = new Map(bs.map((b, i) => [b.lane, i]))
      const gone = new Set()
      const [o1, o2] = race.ord
      for (let st = 0; st < 3; st++) {
        const w = W[st], g = G[st]
        const cand = []
        for (let i = 0; i < bs.length; i++) if (!gone.has(i)) cand.push(i)
        const cv = cand.map((i) => condOf(C, st, bs[i].lane, o1, o2))
        const s = cand.map((i, k) => {
          let z = 0
          const x = bs[i].x
          for (let d = 0; d < D; d++) z += w[d] * x[d]
          return z + w[IA] * cv[k][0] + w[IB] * cv[k][1]
        })
        const mx = Math.max(...s)
        const ex = s.map((z) => Math.exp(z - mx))
        const sum = ex.reduce((a, b) => a + b, 0)
        const pick = laneIdx.get(race.ord[st]); if (pick === undefined) break
        const pos = cand.indexOf(pick); if (pos < 0) break
        for (let k = 0; k < cand.length; k++) {
          const q = ex[k] / sum, x = bs[cand[k]].x
          const coef = (cand[k] === pick ? q - 1 : q)
          for (let d = 0; d < D; d++) g[d] += coef * x[d]
          g[IA] += coef * cv[k][0]
          g[IB] += coef * cv[k][1]
        }
        gone.add(pick)
      }
    }
    const n = races.length
    for (let st = 0; st < 3; st++) for (let d = 0; d < DC; d++) {
      const gi = G[st][d] / n + l2 * W[st][d]
      MM[st][d] = 0.9 * MM[st][d] + 0.1 * gi
      VV[st][d] = 0.999 * VV[st][d] + 0.001 * gi * gi
      W[st][d] -= lr * (MM[st][d] / (1 - 0.9 ** ep)) / (Math.sqrt(VV[st][d] / (1 - 0.999 ** ep)) + 1e-8)
    }
  }
  return W
}

/**
 * 120通りの確率を出す。
 * ★条件付き項があるので、2着の確率は「その1着を仮定したとき」の値になる。
 *   つまり a を固定するたびに2着のsoftmaxを計算し直す必要がある。
 *   1着ごとに計算をやり直すぶん重いが、これをやらないと条件付きにした意味がない。
 */
function trioProbs(W, C, race) {
  const bs = race.boats
  const N = bs.length
  const base = [0, 1, 2].map((st) => bs.map((b) => {
    let z = 0
    const x = b.x
    for (let d = 0; d < D; d++) z += W[st][d] * x[d]
    return z
  }))
  const idxAll = [...Array(N).keys()]
  const soft = (idx, sc) => {
    const m = Math.max(...idx.map((i) => sc[i]))
    const e = idx.map((i) => Math.exp(sc[i] - m))
    const t = e.reduce((a, b) => a + b, 0)
    return e.map((x) => x / t)
  }
  const p1 = soft(idxAll, base[0])
  const out = []
  for (let a = 0; a < N; a++) {
    const w1 = bs[a].lane
    const i2 = idxAll.filter((i) => i !== a)
    const s2 = {}
    for (const i of i2) s2[i] = base[1][i] + W[1][IA] * (C.a2[w1][bs[i].lane] ?? 0)
    const q2 = soft(i2, s2)
    for (let bi = 0; bi < i2.length; bi++) {
      const b = i2[bi]
      const w2 = bs[b].lane
      const i3 = idxAll.filter((i) => i !== a && i !== b)
      const s3 = {}
      for (const i of i3) s3[i] = base[2][i] + W[2][IA] * (C.a3[w1][bs[i].lane] ?? 0) + W[2][IB] * (C.b3[w2][bs[i].lane] ?? 0)
      const q3 = soft(i3, s3)
      for (let ci = 0; ci < i3.length; ci++)
        out.push({ combo: `${bs[a].lane}-${bs[b].lane}-${bs[i3[ci]].lane}`, p: p1[a] * q2[bi] * q3[ci] })
    }
  }
  const t = out.reduce((a, x) => a + x.p, 0)
  for (const x of out) x.p /= t
  return { trios: out, p1: bs.map((b, i) => ({ lane: b.lane, p: p1[i], y: b.y })) }
}

db.exec(`DROP TABLE IF EXISTS ${T1}`)
db.exec(`CREATE TABLE ${T1} (race_id TEXT, lane INTEGER, month TEXT, p REAL, y INTEGER, PRIMARY KEY(race_id,lane))`)
db.exec(`DROP TABLE IF EXISTS ${T3}`)
db.exec(`CREATE TABLE ${T3} (race_id TEXT, combo TEXT, month TEXT, p REAL, PRIMARY KEY(race_id,combo))`)
const i1 = db.prepare(`INSERT OR REPLACE INTO ${T1} (race_id,lane,month,p,y) VALUES (?,?,?,?,?)`)
const i3 = db.prepare(`INSERT OR REPLACE INTO ${T3} (race_id,combo,month,p) VALUES (?,?,?,?)`)

console.log('\n月        学習     検証    1着的中   3連単最有力   cond係数(2着/3着)   所要')
for (const mo of folds) {
  const tr = ok3(usable.filter((g) => g.date.slice(0, 7) < mo))
  const te = ok3(usable.filter((g) => g.date.slice(0, 7) === mo))
  if (tr.length < 3000 || !te.length) continue
  const t0 = Date.now()
  const C = fitCond(tr)
  const W = fitPL(tr, C)
  let hit1 = 0, hit3 = 0
  db.exec('BEGIN')
  for (const race of te) {
    const { trios, p1 } = trioProbs(W, C, race)
    if (p1.reduce((a, b) => (b.p > a.p ? b : a)).y) hit1++
    if (trios.reduce((a, b) => (b.p > a.p ? b : a)).combo === race.ord.join('-')) hit3++
    for (const x of p1) i1.run(race.race_id, x.lane, mo, x.p, x.y)
    for (const x of trios) i3.run(race.race_id, x.combo, mo, x.p)
  }
  db.exec('COMMIT')
  console.log(`${mo}  ${String(tr.length).padStart(7)}  ${String(te.length).padStart(6)}   ${((hit1 / te.length) * 100).toFixed(2)}%      ${((hit3 / te.length) * 100).toFixed(2)}%       ${W[1][IA].toFixed(3)} / ${W[2][IA].toFixed(3)}      ${((Date.now() - t0) / 60000).toFixed(1)}分`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_${T3}_month ON ${T3}(month)`)
db.exec(`ANALYZE ${T1}`); db.exec(`ANALYZE ${T3}`)
console.log(`\n完了: ${T1} ${all(`SELECT COUNT(*) c FROM ${T1}`)[0].c.toLocaleString()}行 / ${T3} ${all(`SELECT COUNT(*) c FROM ${T3}`)[0].c.toLocaleString()}行`)
db.close()
