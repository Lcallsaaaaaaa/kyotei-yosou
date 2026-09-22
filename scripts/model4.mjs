// 集めた全特徴量で「1着になる艇」を当てるモデルを作り、期間を分けて検証する。
//
//   node scripts/model4.mjs                    学習と検証
//   node scripts/model4.mjs --top 40           効いている項目を40件表示
//
// ★何をしているか
//   1レース6艇のうちどれが1着かを当てる問題。各艇に強さ s を出し、
//   確率は softmax(s) とする（条件付きロジット＝Plackett-Luceの1着部分）。
//   これは「6艇の中での比較」なので、艇ごとの確率を足すと1になる。
//   ※ 過去に艇ごとの1着率をそのまま足して合計1.38になった失敗をした。
//     比較の枠組みを持たない指標を確率として扱ってはいけない。
//
// ★検証のしかた
//   期間で切る。前を学習、後ろを検証。同じ期間で測ると必ず良く見える。
//   特徴量は derive.mjs が「そのレース時点まで」で作っているので未来は混ざらない。
//
// ★比較対象
//   コースだけのモデル（コース1〜6のダミーのみ）を土台とする。
//   全部入りがこれを上回らなければ、集めたデータは予想に効いていない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const TOPN = Number(flag('top', 30))

// ---------- 読み込み ----------
// ★--morning ＝ 朝（02:00）に実在する入力だけで学習する。理由は model5.mjs の同じ箇所を参照。
//   要点だけ: predict.mjs は無い特徴量を**学習時の平均値**で埋める（predict.mjs:341）。
//   直前情報も波高帯成績も無い02:00に「平均的な展示だった」ことにして予想していた。
const MORNING = argv.includes('--morning')
const NOMORN = /^(bf_|waveb_|windb_|nami5_)/
const featCols = all(`PRAGMA table_info(feat)`).map((c) => c.name)
  .filter((c) => !(MORNING && NOMORN.test(c)))
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
console.log(`特徴量 ${featCols.length} 項目`)

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const rows = all(`
  SELECT f.race_id, f.lane, f.course, r.date, r.jcd, r.grade, r.race_no, r.wave, r.wind_speed,
         r.deadline, r.day_no, r.series, r.title,
         e.rank_num, p.age, p.weight, p.win_rate_nat, p.top2_nat, p.win_rate_loc, p.top2_loc,
         p.motor_top2, p.boat_top2, p.hayami,
         ${featCols.map((c) => `f.${q(c)}`).join(', ')}
  FROM feat f
  JOIN races r ON r.race_id = f.race_id
  JOIN entries e ON e.race_id = f.race_id AND e.lane = f.lane
  LEFT JOIN programs p ON p.race_id = f.race_id AND p.lane = f.lane
  ORDER BY r.date, f.race_id, f.lane`)
console.log(`${rows.length.toLocaleString()} 行`)

// 番組表の項目も入れる（年齢・体重・級別・当地勝率など。ユーザー指摘の「人の側」）
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami']
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
  for (let i = 0; i < progCols.length; i++) { const x = r[progCols[i]]; v[featCols.length + i] = x == null ? NaN : x }
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

// ---------- 期間を3つに分ける ----------
// ★補正（キャリブレーション）を検証期間で作ってはいけない。
//   それをやると「補正後にぴったり合う」のは当たり前で、実力を測ったことにならない。
//   学習 → 補正 → 検証 の3つに分け、検証期間は最後まで一度も見ない。
const dates = [...new Set(usable.map((g) => g.date))].sort()
const cut1 = dates[Math.floor(dates.length * 0.60)]
const cut2 = dates[Math.floor(dates.length * 0.75)]
const train = usable.filter((g) => g.date < cut1)
const calib = usable.filter((g) => g.date >= cut1 && g.date < cut2)
const test = usable.filter((g) => g.date >= cut2)
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

// ---------- 学習（条件付きロジット、L2つき） ----------
function fit(list, use, { lr = 0.3, epochs = 60, l2 = 2e-4 } = {}) {
  const w = new Float64Array(D)
  const idx = use ?? [...Array(D).keys()]
  const g = new Float64Array(D)
  const m = new Float64Array(D), v = new Float64Array(D)  // Adam
  let t = 0
  for (let ep = 0; ep < epochs; ep++) {
    g.fill(0)
    let ll = 0
    for (const race of list) {
      const s = race.boats.map((b) => { let z = 0; for (const i of idx) z += w[i] * b.x[i]; return z })
      const mx = Math.max(...s)
      const ex = s.map((z) => Math.exp(z - mx))
      const sum = ex.reduce((a, b) => a + b, 0)
      const p = ex.map((e) => e / sum)
      for (let k = 0; k < 6; k++) {
        const d = p[k] - race.boats[k].y
        if (race.boats[k].y) ll += Math.log(Math.max(p[k], 1e-12))
        const x = race.boats[k].x
        for (const i of idx) g[i] += d * x[i]
      }
    }
    t++
    const n = list.length
    for (const i of idx) {
      const gi = g[i] / n + l2 * w[i]
      m[i] = 0.9 * m[i] + 0.1 * gi
      v[i] = 0.999 * v[i] + 0.001 * gi * gi
      w[i] -= lr * (m[i] / (1 - 0.9 ** t)) / (Math.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8)
    }
    if (ep === epochs - 1 || ep % 20 === 19) console.log(`    epoch ${ep + 1}  学習logloss ${(-ll / n).toFixed(4)}`)
  }
  return w
}

/** そのレースの6艇の確率を出す。T は温度（1で素のまま、大きいほど自信を弱める） */
function probs(w, race, idx, T = 1) {
  const s = race.boats.map((b) => { let z = 0; for (const i of idx) z += w[i] * b.x[i]; return z / T })
  const mx = Math.max(...s)
  const ex = s.map((z) => Math.exp(z - mx))
  const sum = ex.reduce((a, b) => a + b, 0)
  return ex.map((e) => e / sum)
}

/**
 * 温度スケーリング。強さを T で割ってから softmax する。
 *
 * ★なぜ保序回帰ではなくこれなのか
 *   最初は保序回帰で艇ごとの確率を実績に寄せたが、**悪化した**（logloss 1.1914→1.1944）。
 *   6艇の合計を1に戻す正規化が、寄せた分を打ち消してしまうため。
 *   温度スケーリングは softmax の中に入るので正規化と喧嘩しない。
 *   調整するのは T ひとつだけなので、少ない補正データでも壊れにくい。
 */
function fitTemperature(w, list, idx) {
  const logl = (T) => {
    let ll = 0
    for (const race of list) {
      const p = probs(w, race, idx, T)
      for (let k = 0; k < 6; k++) if (race.boats[k].y) ll += Math.log(Math.max(p[k], 1e-12))
    }
    return -ll / list.length
  }
  let best = 1, bl = Infinity
  for (let T = 0.6; T <= 2.5; T += 0.02) { const v = logl(T); if (v < bl) { bl = v; best = T } }
  return { T: best, ll: bl }
}

/**
 * 予測確率を実績に合わせる（保序回帰＝PAV法）。
 * 直線で補正すると端が合わない。過去に p→1.478p−0.286 という直線補正を使ったが、
 * 直線は「70%以上だけ甘い」ような曲がり方を表現できない。
 * 保序回帰は「順序は変えず、値だけ実績に寄せる」ので、この形に合う。
 */
function fitIsotonic(pairs) {
  pairs.sort((a, b) => a[0] - b[0])
  const blocks = pairs.map(([p, y]) => ({ x: p, sum: y, n: 1 }))
  for (let i = 1; i < blocks.length;) {
    if (blocks[i - 1].sum / blocks[i - 1].n <= blocks[i].sum / blocks[i].n) { i++; continue }
    blocks[i - 1].sum += blocks[i].sum; blocks[i - 1].n += blocks[i].n; blocks[i - 1].x = blocks[i].x
    blocks.splice(i, 1)
    if (i > 1) i--
  }
  const xs = blocks.map((b) => b.x), ys = blocks.map((b) => b.sum / b.n)
  return (p) => {
    if (p <= xs[0]) return ys[0]
    if (p >= xs[xs.length - 1]) return ys[ys.length - 1]
    let lo = 0, hi = xs.length - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= p) lo = m; else hi = m }
    const t = (p - xs[lo]) / (xs[hi] - xs[lo] || 1)
    return ys[lo] + t * (ys[hi] - ys[lo])
  }
}

function evaluate(w, list, use, T = 1) {
  const idx = use ?? [...Array(D).keys()]
  let ll = 0, hit = 0
  const buckets = new Map()
  for (const race of list) {
    const p = probs(w, race, idx, T)
    let best = 0
    for (let k = 1; k < 6; k++) if (p[k] > p[best]) best = k
    if (race.boats[best].y) hit++
    for (let k = 0; k < 6; k++) {
      if (race.boats[k].y) ll += Math.log(Math.max(p[k], 1e-12))
      const bk = Math.min(9, Math.floor(p[k] * 10))
      const e = buckets.get(bk) ?? { n: 0, s: 0, w: 0 }
      e.n++; e.s += p[k]; e.w += race.boats[k].y
      buckets.set(bk, e)
    }
  }
  return { ll: -ll / list.length, acc: hit / list.length, buckets }
}

const courseIdx = [1, 2, 3, 4, 5, 6].map((c) => NAMES.indexOf(`_course${c}`))
console.log('【土台】コースだけのモデル')
const wBase = fit(train, courseIdx, { epochs: 60 })
const eBase = evaluate(wBase, test, courseIdx)
console.log(`  検証 logloss ${eBase.ll.toFixed(4)}  的中率 ${(eBase.acc * 100).toFixed(2)}%\n`)

console.log('【全部入り】集めた全項目を入れたモデル')
const wFull = fit(train, null, { epochs: 120 })
const eFull = evaluate(wFull, test, null)
console.log(`  検証 logloss ${eFull.ll.toFixed(4)}  的中率 ${(eFull.acc * 100).toFixed(2)}%\n`)

// 補正期間だけを見て温度Tを決める（検証期間は見ない）
const allIdx = [...Array(D).keys()]
const { T, ll: tll } = fitTemperature(wFull, calib, allIdx)
console.log(`【補正】温度 T = ${T.toFixed(2)}（補正期間のlogloss ${tll.toFixed(4)}）`)
const eCal = evaluate(wFull, test, null, T)
console.log(`  検証 logloss ${eCal.ll.toFixed(4)}  的中率 ${(eCal.acc * 100).toFixed(2)}%\n`)

console.log('=== 結果（すべて検証期間＝一度も学習に使っていない期間） ===')
console.log(`  logloss  コースのみ ${eBase.ll.toFixed(4)} → 全部入り ${eFull.ll.toFixed(4)} → 補正後 ${eCal.ll.toFixed(4)}`)
console.log(`  的中率   ${(eBase.acc * 100).toFixed(2)}% → ${(eFull.acc * 100).toFixed(2)}% → ${(eCal.acc * 100).toFixed(2)}%`)

for (const [nm, e] of [['補正なし', eFull], ['補正あり', eCal]]) {
  console.log(`\n=== 予測確率の当たり具合（${nm}） ===`)
  console.log('  予測帯      件数    予測平均   実際      ずれ')
  let wsum = 0, wn = 0
  for (const b of [...e.buckets.keys()].sort((a, z) => a - z)) {
    const x = e.buckets.get(b)
    const pp = x.s / x.n, ac = x.w / x.n
    wsum += Math.abs(ac - pp) * x.n; wn += x.n
    console.log(`  ${(b * 10).toString().padStart(2)}〜${(b * 10 + 10).toString().padStart(3)}%  ${String(x.n).padStart(7)}   ${(pp * 100).toFixed(1).padStart(6)}%  ${(ac * 100).toFixed(1).padStart(6)}%  ${((ac - pp) * 100).toFixed(1).padStart(6)}pt`)
  }
  console.log(`  平均のずれ ${(wsum / wn * 100).toFixed(2)}pt`)
}

// ---------- 予測を保存する ----------
// ★毎回8分かけて学習し直すのは無駄。買い方の検討はここから何度でもやり直せるようにする。
//   split で学習/補正/検証のどれかが分かるので、検証期間だけを使う約束を守れる。
db.exec(`DROP TABLE IF EXISTS pred`)
db.exec(`CREATE TABLE pred (race_id TEXT NOT NULL, lane INTEGER NOT NULL, date TEXT,
  course REAL, p REAL, y INTEGER, split TEXT, PRIMARY KEY (race_id, lane))`)
const insP = db.prepare(`INSERT OR REPLACE INTO pred (race_id,lane,date,course,p,y,split) VALUES (?,?,?,?,?,?,?)`)
db.exec('BEGIN')
for (const [list, sp] of [[train, 'train'], [calib, 'calib'], [test, 'test']])
  for (const race of list) {
    const p = probs(wFull, race, allIdx, T)
    race.boats.forEach((b, k) => insP.run(race.race_id, b.lane, race.date, b.course, p[k], b.y, sp))
  }
db.exec('COMMIT')
db.exec('CREATE INDEX IF NOT EXISTS idx_pred_split ON pred(split, date)')
db.exec('ANALYZE pred')
console.log(`\n予測を pred に保存（${all('SELECT COUNT(*) c FROM pred')[0].c.toLocaleString()} 行）`)

console.log(`\n=== 効いている項目 上位${TOPN} ===`)
const rank = NAMES.map((n, i) => ({ n, w: wFull[i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, TOPN)
for (const r of rank) console.log(`  ${r.w >= 0 ? '+' : '−'}${Math.abs(r.w).toFixed(3).padStart(6)}  ${r.n}`)
db.close()
