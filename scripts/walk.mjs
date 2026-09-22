// 過去レースを「月ごとにモデルを作り直して」全部予想し直す歩進検証。
//
//   node scripts/walk.mjs              最初の5ヶ月で学習し、残りを1ヶ月ずつ検証
//   node scripts/walk.mjs --first 4    学習に回す月数を変える
//
// ★なぜ1回の期間分割では足りないか
//   model5 は「2026-05-19以降」だけで検証していた。たまたまその期間に合っただけの
//   可能性を排除できない。月ごとに作り直せば、ほぼ全レースが未使用データになる。
//
// ★締切前に分からないものは使わない
//   進入コースではなく枠番を使う。進入が決まるのは締切後。
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
// ★--nowind: races.wave / races.wind_speed に由来する項目を外す。
//   これらは競走成績(Kファイル)の「レース時に記録された」風速・波高で、
//   締切前には確定していない。直前情報にも保存が無い。
//   入れたまま検証すると「荒れた水面で外枠が来る」を後から知って当てることになり、
//   高オッズ艇の成績が実際より良く出る。漏れの大きさを測るための切り替え。
const NOWIND = argv.includes('--nowind')
const T1 = flag('t1', 'walk1'), T3 = flag('t3', 'walk3')
const FROM = flag('from', null)
// ★--usecourse … 本番の進入コースをそのまま使う。**買う時点では分からないので実運用不可**。
//   「進入さえ分かっていればどこまで当たるのか」の上限を測るためだけに使う。
//   展示の進入はこの上限の何割を取れるか、という見方をする。
const USECOURSE = argv.includes('--usecourse')
if (USECOURSE) console.log('⚠ 本番の進入コースを使用（上限測定用・実運用不可）')
const featCols = all(`PRAGMA table_info(feat)`).map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !(NOBF && c.startsWith('bf_')))
  .filter((c) => !(NOWIND && /^(waveb_|windb_|nami5_|wl_|wake_)/.test(c)))
// ★rfeat＝レース単位の特徴量（racefeat.mjs が作る）
//   rankdiag.mjs で「崩れるのは全部レースの性質」と分かったのに、
//   feat は艇単位しか持っていなかった。相対順位・拮抗度・前づけ危険度・
//   場の傾向（時点つき）をここで足す。
// ★--nolive … 直前情報に由来する項目を外す（朝一括で予想する運用を測るため）
//   ⚠ この2行は rfeatCols より**前**に置くこと。後ろに置くと参照時にエラーになり、
//     下の try/catch がそれを握り潰して rfeat が丸ごと空になる（2026-08-29に一度やった）。
const NOLIVE = argv.includes('--nolive')
const LIVEPAT = /^(ex_|exc_|exst_|tilt_|adj_|air_|water_|temp_|parts_)/
const rfeatCols = (() => {
  const cols = all(`PRAGMA table_info(rfeat)`).map((c) => c.name)
    .filter((c) => c !== 'race_id' && c !== 'lane')
    .filter((c) => !(NOLIVE && LIVEPAT.test(c)))
  if (!cols.length) throw new Error('rfeat が空。racefeat.mjs を先に走らせること')
  return cols
})()
if (rfeatCols.length) console.log(`レース単位の特徴量 ${rfeatCols.length} 項目を追加`)
if (FROM) console.log(`期間を ${FROM} 以降に限定`)
if (NOBF) console.log('直前情報(bf_*)を外して学習する')
if (NOWIND) console.log('レース時の風・波に由来する項目を外して学習する')
console.log(`特徴量 ${featCols.length} 項目`)

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const SQL = (`
  SELECT f.race_id, f.lane, f.course, r.date, r.jcd, r.grade, r.race_no, r.wave, r.wind_speed,
         r.deadline, r.day_no, r.series, r.title,
         r.wind_dir, e.rank_num, p.age, p.weight, p.win_rate_nat, p.top2_nat, p.win_rate_loc, p.top2_loc,
         p.branch AS racer_branch, p.grade AS racer_grade,
         p.motor_top2, p.boat_top2, p.hayami,
         ${featCols.map((c) => `f.${q(c)}`).join(', ')}${rfeatCols.length ? ', ' + rfeatCols.map((c) => `rf.${q(c)}`).join(', ') : ''}
  FROM feat f
  JOIN races r ON r.race_id = f.race_id
  ${rfeatCols.length ? 'LEFT JOIN rfeat rf ON rf.race_id = f.race_id AND rf.lane = f.lane' : ''}
  JOIN entries e ON e.race_id = f.race_id AND e.lane = f.lane
  LEFT JOIN programs p ON p.race_id = f.race_id AND p.lane = f.lane
  ${FROM ? "WHERE r.date >= '" + FROM + "'" : ''}
  ORDER BY r.date, f.race_id, f.lane`)

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
// ★2026-08-29 追加した3つ
//   winddir … 風向×コース。追い風か向かい風かは水面の向き次第で、場ごとに違う。
//     人が変換表を作ると間違えるので、**実績から補正値を学習させる**（jcdと同じ仕組み）。
//     風向は全222,671レースに入っているのに、風速しか使っていなかった。
//   rgrade  … 選手の級別(A1/A2/B1/B2)×コース。番組表にあるのに使っていなかった。
//     races.grade（SG/G1などレースの格）とは別物。
//   branch  … 選手の支部×コース。地元選手が水面を知っている効果を拾う。
const XTYPES = ['jcd', 'grade', 'wave', 'wind', 'winddir', 'rno', 'hour', 'day', 'len', 'left',
  'lenday', 'title', 'rgrade', 'branch']
  .filter((t) => !(NOWIND && (t === 'wave' || t === 'wind' || t === 'winddir')))

/** そのレース・その艇が属する条件を、種類ごとに1つ返す */
const XKEY = (r) => {
  // ★進入コースではなく枠番を使う。進入が決まるのは締切後で、買う時点では分からない。
  //   実測でも進入=枠番は約85%しか一致しない。実進入を使うと検証結果が実際より良く出る。
  const c = USECOURSE ? (r.course ?? r.lane) : r.lane
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
    // ★風向×コース。追い風か向かい風かは場ごとに違うので、変換表は作らず実績から学ぶ。
    //   風速の帯と組にすると細かくなりすぎるので、まず風向だけ。
    winddir: `${r.wind_dir ?? 'x'}|${c}`,
    // ★選手の級別×コース。A1がインを取ったときと B2 がインを取ったときは意味が違う。
    rgrade: `${r.racer_grade ?? 'x'}|${c}`,
    // ★支部×コース。地元の水面を知っているかどうか。
    branch: `${r.racer_branch ?? 'x'}|${c}`,
    _course: c,
  }
}

// 使う項目＝特徴量＋番組表＋コースダミー＋条件ごとの補正値（種類ごとに1つ）
const NAMES = [...featCols, ...rfeatCols, ...progCols, ...[1, 2, 3, 4, 5, 6].map((c) => `_course${c}`),
  ...XTYPES.map((t) => `adj_${t}`)]
const D = NAMES.length
const XOFF = featCols.length + rfeatCols.length + progCols.length + 6
console.log(`  条件補正 ${XTYPES.length} 項目（合計 ${D} 項目）`)

const vec = (r) => {
  const v = new Float32Array(D)
  // ⚠ 並びは NAMES と必ずそろえること（featCols → rfeatCols → progCols → コースダミー → adj）。
  //   2026-08-27まで rfeat をここに書いておらず、番組表の値が rfeat の位置に入り、
  //   コースダミーもずれ、rfeat の39項目は**全部ゼロのまま**だった。
  //   racefeat.mjs が作った相対順位・場×時間帯・展示タイム・展示進入は一度も使われていない。
  //   検証結果が「新項目を足しても小数点以下まで同じ」になって気づいた。
  let k = 0
  for (let i = 0; i < featCols.length; i++) { const x = r[featCols[i]]; v[k++] = x == null ? NaN : x }
  for (let i = 0; i < rfeatCols.length; i++) { const x = r[rfeatCols[i]]; v[k++] = x == null ? NaN : x }
  for (let i = 0; i < progCols.length; i++) { const x = r[progCols[i]]; v[k++] = x == null ? NaN : x }
  // ★進入コースではなく枠番を使う。進入が決まるのは締切後で、買う時点では分からない。
  //   実測でも進入=枠番は約85%しか一致しない。実進入を使うと検証結果が実際より良く出る。
  const c = USECOURSE ? (r.course ?? r.lane) : r.lane
  if (c >= 1 && c <= 6) v[k + c - 1] = 1
  return v
}

// ---------- レース単位にまとめる ----------
// ★行の配列を作らず、1行ずつ受け取ってその場で数値ベクトルに変換する。
//   以前は all() で133万行のオブジェクトを配列に載せ、そこから
//   さらに特徴ベクトルを作っていたので**両方が同時にメモリに載り**、
//   実メモリ7.8GBの機械で無言のまま落ちていた（2026-08-26）。
//   iterate() なら1行ずつ流れるので、オブジェクトは即座に捨てられる。
const races = []
{
  let cur = null, n = 0
  for (const r of db.prepare(SQL).iterate()) {
    if (!cur || cur.race_id !== r.race_id) { cur = { race_id: r.race_id, date: r.date, boats: [] }; races.push(cur) }
    cur.boats.push({ x: vec(r), y: r.rank_num === 1 ? 1 : 0, lane: r.lane, course: r.course, k: XKEY(r) })
    if (++n % 200000 === 0) console.log(`  ${n.toLocaleString()} 行`)
  }
  console.log(`${n.toLocaleString()} 行`)
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

// ★--lanedelta … 案Dの「枠ごとに効き方が違う」という考えを、旧モデルの上に足す。
//   案Dは条件補正を素のダミーに置き換えてしまい、まるごと入れ替えたので負けた。
//   ここでは条件補正9項目はそのまま残し、係数だけを
//       その艇の係数 = 共通の係数 + その枠ぶんのずらし
//   に分ける。ずらしは歩幅を小さく・罰則を強くして、外枠の癖だけを拾わせる。
const LANEDELTA = argv.includes(String.fromCharCode(45,45)+'lanedelta')
const LRD = Number(flag('lrd', 0.05))
const L2D = Number(flag('l2d', 0.01))
if (LANEDELTA) console.log(`枠ごとの差分あり（歩幅 ${LRD} / 罰則 ${L2D}）`)

/**
 * 段階ごとの係数を学習する。
 * --lanedelta のときは W[st] を「共通 B[st]」＋「枠ごとの差分 Dl[st][枠]」に分け、
 * 差分だけ歩幅を小さく・罰則を強くする。
 * ⚠ 共通と差分に同じ勾配を同じ歩幅で入れると合計が2倍動いて壊れる（実測で33%まで落ちた）。
 *   差分の歩幅は共通の1/5にしてある。
 */
function fitPL(races, { lr = 0.25, epochs = 70, l2 = 3e-4 } = {}) {
  const W = [0, 1, 2].map(() => new Float64Array(D))
  const MM = [0, 1, 2].map(() => new Float64Array(D))
  const VV = [0, 1, 2].map(() => new Float64Array(D))
  const Dl = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const MD = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const VD = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const dot = (st, b) => {
    const x = b.x, w = W[st]
    let z = 0
    if (LANEDELTA) { const d2 = Dl[st][b.lane - 1]; for (let d = 0; d < D; d++) z += (w[d] + d2[d]) * x[d] }
    else for (let d = 0; d < D; d++) z += w[d] * x[d]
    return z
  }
  for (let ep = 1; ep <= epochs; ep++) {
    const G = [0, 1, 2].map(() => new Float64Array(D))
    const GD = LANEDELTA ? [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D))) : null
    for (const race of races) {
      const bs = race.boats
      const laneIdx = new Map(bs.map((b, i) => [b.lane, i]))
      const gone = new Set()
      for (let st = 0; st < 3; st++) {
        const g = G[st]
        const cand = []
        for (let i = 0; i < bs.length; i++) if (!gone.has(i)) cand.push(i)
        const s = cand.map((i) => dot(st, bs[i]))
        const mx = Math.max(...s)
        const ex = s.map((z) => Math.exp(z - mx))
        const sum = ex.reduce((a, b) => a + b, 0)
        const pick = laneIdx.get(race.ord[st]); if (pick === undefined) break
        const pos = cand.indexOf(pick); if (pos < 0) break
        for (let k = 0; k < cand.length; k++) {
          const q = ex[k] / sum, b = bs[cand[k]], x = b.x
          const coef = (cand[k] === pick ? q - 1 : q)
          if (LANEDELTA) { const gd = GD[st][b.lane - 1]
            for (let d = 0; d < D; d++) { const v = coef * x[d]; g[d] += v; gd[d] += v } }
          else for (let d = 0; d < D; d++) g[d] += coef * x[d]
        }
        gone.add(pick)
      }
    }
    const n = races.length
    const step = (w, m, v, gr, pen, rate) => {
      for (let d = 0; d < D; d++) {
        const gi = gr[d] / n + pen * w[d]
        m[d] = 0.9 * m[d] + 0.1 * gi
        v[d] = 0.999 * v[d] + 0.001 * gi * gi
        w[d] -= rate * (m[d] / (1 - 0.9 ** ep)) / (Math.sqrt(v[d] / (1 - 0.999 ** ep)) + 1e-8)
      }
    }
    for (let st = 0; st < 3; st++) {
      step(W[st], MM[st], VV[st], G[st], l2, lr)
      if (LANEDELTA) for (let L = 0; L < 6; L++) step(Dl[st][L], MD[st][L], VD[st][L], GD[st][L], L2D, LRD)
    }
  }
  if (LANEDELTA) {
    // 呼び出し側は W[st] を1本の係数として使うので、枠ごとに足したものを返す
    return { W, Dl, lane: true }
  }
  return W
}

function trioProbs(WW, race) {
  const bs = race.boats
  // --lanedelta のときは {W, Dl} が来る。艇ごとに「共通＋その枠の差分」で点数を出す。
  const lane = WW && WW.lane === true
  const W = lane ? WW.W : WW, Dl = lane ? WW.Dl : null
  const sc = [0, 1, 2].map((st) => bs.map((b) => {
    const x = b.x, w = W[st]
    let z = 0
    if (lane) { const d2 = Dl[st][b.lane - 1]; for (let d = 0; d < D; d++) z += (w[d] + d2[d]) * x[d] }
    else for (let d = 0; d < D; d++) z += w[d] * x[d]
    return z
  }))
  const soft = (idx, s) => { const m = Math.max(...idx.map((i) => s[i])); const e = idx.map((i) => Math.exp(s[i] - m)); const t = e.reduce((a, b) => a + b, 0); return e.map((x) => x / t) }
  const N = bs.length, idxAll = [...Array(N).keys()]
  const p1 = soft(idxAll, sc[0])
  const out = []
  for (let a = 0; a < N; a++) {
    const i2 = idxAll.filter((i) => i !== a), q2 = soft(i2, sc[1])
    for (let bi = 0; bi < i2.length; bi++) {
      const b = i2[bi]
      const i3 = idxAll.filter((i) => i !== a && i !== b), q3 = soft(i3, sc[2])
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

console.log('\n月        学習     検証    1着的中   3連単最有力   所要')
for (const mo of folds) {
  const tr = ok3(usable.filter((g) => g.date.slice(0, 7) < mo))
  const te = ok3(usable.filter((g) => g.date.slice(0, 7) === mo))
  if (tr.length < 3000 || !te.length) continue
  const t0 = Date.now()
  const W = fitPL(tr)
  let hit1 = 0, hit3 = 0
  db.exec('BEGIN')
  for (const race of te) {
    const { trios, p1 } = trioProbs(W, race)
    if (p1.reduce((a, b) => (b.p > a.p ? b : a)).y) hit1++
    if (trios.reduce((a, b) => (b.p > a.p ? b : a)).combo === race.ord.join('-')) hit3++
    for (const x of p1) i1.run(race.race_id, x.lane, mo, x.p, x.y)
    for (const x of trios) i3.run(race.race_id, x.combo, mo, x.p)
  }
  db.exec('COMMIT')
  console.log(`${mo}  ${String(tr.length).padStart(7)}  ${String(te.length).padStart(6)}   ${((hit1 / te.length) * 100).toFixed(2)}%      ${((hit3 / te.length) * 100).toFixed(2)}%     ${((Date.now() - t0) / 60000).toFixed(1)}分`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_${T3}_month ON ${T3}(month)`)
db.exec(`ANALYZE ${T1}`); db.exec(`ANALYZE ${T3}`)
console.log(`\n完了: ${T1} ${all(`SELECT COUNT(*) c FROM ${T1}`)[0].c.toLocaleString()}行 / ${T3} ${all(`SELECT COUNT(*) c FROM ${T3}`)[0].c.toLocaleString()}行`)
db.close()
