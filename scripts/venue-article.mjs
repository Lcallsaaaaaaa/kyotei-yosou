// 場ごとの攻略記事を、集めたデータだけで組み立てる。
//
//   node scripts/venue-article.mjs            きょうの当番の場を1つ（24日で一周）
//   node scripts/venue-article.mjs --jcd 1    場を指定して作る
//   node scripts/venue-article.mjs --all      24場ぶん一気に作る（最初の1回用）
//   node scripts/venue-article.mjs --jcd 1 --dry   書かずに中身だけ見る
//
// 書き出し先は content/venues/<場コード2けた>.md。
// これは **/venue/<場コード> の中に出る「人が書く枠」** で、いまは空のまま。
// 新しいURLを増やさないので、既存の攻略ページと食い合わない。
// 送信は sync-public.mjs（syncArticles → venueGuide の manual）が拾う。
//
// ★なぜ生成AIに文章を書かせないのか（2026-10-11）
//   Googleのスパムポリシー（2026-08-28更新）は
//   「ユーザーに付加価値を与えずに多数のページを生成するために生成AIツールを使うこと」を
//   大量生成コンテンツの不正使用として名指ししている。「どのように作成されたかにかかわらず」。
//   「役立つコンテンツ」の指針（2026-10-05更新）も
//   「人の監督や編集なしに生成AIで大量のテキストを作ることは、ほとんど労力をかけていないに等しい」と書いている。
//
//   そしてこのサイトの値打ちは**自前で測った数字**であって、文章の巧さではない。
//   2026-10-10、私が記憶で書いた記事の表は数字が全部違っていた（測り直して差し替えた）。
//   無人でそれをやれば、間違いがそのまま公開される。
//   → **文章は型。数字はSQL。** これなら嘘が入らないし、場ごとに中身が本当に変わる。
//
// ★数字の出し方の決まり
//   ・割合には必ず**母数（n）**を添える
//   ・「いちばん高い／低い」は、**選んだ時点で偏る**（最大と最小を同じ標本から選ぶため）。
//     2標本の差の検定で z>2.58（p<0.01）のときだけ言い切る。届かなければ表を出すだけにする
//   ・母数が足りないもの（MIN_N 未満）は出さない
import './prio.mjs'   // 予定タスク経由だと BelowNormal になる。自分で上げる
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'content', 'venues')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

export const VENUES = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国', 'びわこ', '住之江',
  '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

/** これ未満の母数では何も言わない。 */
export const MIN_N = 200

/** 決まり手の説明。表に並べるだけだと「恵まれって何？」「差しが無いのはおかしい」と読まれる（2026-10-11 本人指摘）。
 *  ⚠ 「逃げ」は**1コースの艇にしか使われない**。だから1コースの内訳は 逃げ／抜き／恵まれ の3つしか出ない。
 *     差し・まくり・まくり差しは、外のコースが内の艇を抜いたときの呼び方。表示の誤りではない。 */
export const KIMARITE_DESC = {
  逃げ: '1コースの艇が第1ターンマークを先頭で回り、そのまま1着',
  差し: '先に回った艇の内側を抜いて1着',
  まくり: '外から内の艇をまとめてかわして1着',
  まくり差し: '第1ターンで何艇かをまくり、先行した艇を内から差して1着',
  抜き: '第1ターンでは前に出られず、1周目の第2ターン以降で前の艇を抜いて1着',
  恵まれ: '前を走っていた艇がフライングや転覆などで外れ、繰り上がって1着',
}
/** 言い切ってよい差かどうか（2標本の割合の差・両側 p<0.01）。 */
export const Z_SURE = 2.58

const pct = (w, n) => (n ? (w / n) * 100 : null)
const f1 = (v) => (v == null ? '―' : v.toFixed(1))
const yen = (v) => (v == null ? '―' : Math.round(v).toLocaleString())

/** 2つの割合に本当に差があるか（プールした分散での z 検定）。 */
export function zDiff(w1, n1, w2, n2) {
  if (!n1 || !n2) return 0
  const p = (w1 + w2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  if (!se) return 0
  return Math.abs(w1 / n1 - w2 / n2) / se
}
export const isSure = (a, b) => zDiff(a.w, a.n, b.w, b.n) > Z_SURE

/** 一覧から「いちばん高い／低い」を、差が確かなときだけ返す。 */
export function extremes(rows, { minN = MIN_N } = {}) {
  const ok = rows.filter((r) => r.n >= minN)
  if (ok.length < 2) return null
  const s = [...ok].sort((a, b) => b.w / b.n - a.w / a.n)
  const hi = s[0], lo = s.at(-1)
  return isSure(hi, lo) ? { hi, lo, z: zDiff(hi.w, hi.n, lo.w, lo.n) } : null
}

/** 24日で一周。日付から当番の場を決める（同じ日なら何度流しても同じ）。 */
export function venueOfDay(date) {
  const days = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 86400e3)
  return (days % 24) + 1
}

// ---------- 集計 ----------
// 全国ぶんはどの場でも同じ。24場まわすとき毎回ひくと全表走査が24回になるので覚えておく。
const natCache = new Map()
const nat = (key, fn) => { if (!natCache.has(key)) natCache.set(key, fn()); return natCache.get(key) }

function gather(db, jcd) {
  const one = (sql, p = []) => db.prepare(sql).get(...p)
  const all = (sql, p = []) => db.prepare(sql).all(...p)
  const W = 'FROM entries e JOIN races r ON r.race_id = e.race_id'

  const span = one('SELECT MIN(date) a, MAX(date) b, COUNT(*) n FROM races WHERE jcd=?', [jcd])
  const byCourse = all(`SELECT e.course lane, COUNT(*) n,
      SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w,
      SUM(CASE WHEN e.rank_num<=2 THEN 1 ELSE 0 END) w2,
      SUM(CASE WHEN e.rank_num<=3 THEN 1 ELSE 0 END) w3
    ${W} WHERE r.jcd=? AND e.course BETWEEN 1 AND 6 GROUP BY e.course ORDER BY e.course`, [jcd])
  const natCourse = nat('course', () => all(`SELECT e.course lane, COUNT(*) n,
      SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w
    ${W} WHERE e.course BETWEEN 1 AND 6 GROUP BY e.course ORDER BY e.course`))
  const byYear = all(`SELECT substr(r.date,1,4) AS label, COUNT(*) n,
      SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w
    ${W} WHERE r.jcd=? AND e.course=1 GROUP BY substr(r.date,1,4) ORDER BY label`, [jcd])
  const byRaceNo = all(`SELECT r.race_no AS label, COUNT(*) n,
      SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w
    ${W} WHERE r.jcd=? AND e.course=1 GROUP BY r.race_no ORDER BY r.race_no`, [jcd])

  const band = (col, bands) => bands.map(([label, lo, hi]) => {
    const cond = hi == null ? `${col} >= ?` : `${col} >= ? AND ${col} <= ?`
    const args = hi == null ? [jcd, lo] : [jcd, lo, hi]
    const r = one(`SELECT COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w
      ${W} WHERE r.jcd=? AND e.course=1 AND ${cond}`, args)
    return { label, n: r.n ?? 0, w: r.w ?? 0 }
  })
  const byWind = band('r.wind_speed', [['0〜1m', 0, 1], ['2〜3m', 2, 3], ['4〜5m', 4, 5], ['6m以上', 6, null]])
  const byWave = band('r.wave', [['0〜2cm', 0, 2], ['3〜5cm', 3, 5], ['6cm以上', 6, null]])

  const kimarite = all(`SELECT r.kimarite label, COUNT(*) n FROM races r
    JOIN entries e ON e.race_id = r.race_id AND e.course=1 AND e.rank_num=1
    WHERE r.jcd=? AND r.kimarite IS NOT NULL GROUP BY r.kimarite ORDER BY n DESC`, [jcd])
  const kimByCourse = [2, 3, 4].map((c) => ({ course: c,
    rows: all(`SELECT r.kimarite label, COUNT(*) n FROM races r
      JOIN entries e ON e.race_id = r.race_id AND e.course=? AND e.rank_num=1
      WHERE r.jcd=? AND r.kimarite IS NOT NULL GROUP BY r.kimarite ORDER BY n DESC`, [c, jcd]) }))

  const pay = (j) => {
    const w = j == null ? '' : 'AND r.jcd=?'
    const a = j == null ? [] : [j]
    const s = one(`SELECT COUNT(*) n, AVG(p.amount) av,
        SUM(CASE WHEN p.amount>=10000 THEN 1 ELSE 0 END) man, MAX(p.amount) mx
      FROM payouts p JOIN races r ON r.race_id = p.race_id
      WHERE p.bet_type='sanrentan' ${w}`, a)
    const mid = one(`SELECT amount FROM payouts p JOIN races r ON r.race_id = p.race_id
      WHERE p.bet_type='sanrentan' ${w} ORDER BY p.amount LIMIT 1 OFFSET ?`, [...a, Math.floor((s.n ?? 1) / 2)])
    return { ...s, mid: mid?.amount ?? null }
  }

  const racers = all(`SELECT e.racer_name name, COUNT(*) n,
      SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w
    ${W} WHERE r.jcd=? AND r.date >= date('now','-2 year') AND e.racer_name IS NOT NULL
    GROUP BY e.racer_id HAVING n >= 40 ORDER BY (w*1.0/n) DESC LIMIT 5`, [jcd])

  // 進入：全艇が枠なりだったレースの割合（前付けの多い場かどうか）
  //
  // ⚠ 「6艇ぶんの course が全部そろっているレースだけ」で数えてはいけない（2026-10-11に踏んだ）。
  //   前付けのあったレースほど course が欠けやすく、**欠けたぶんが丸ごと落ちて
  //   枠なり率が上に化ける**。江戸川は非枠なり175レースのうち161が除外され、
  //   実際の98.0%が99.8%に見えていた。
  //   → 「lane と course が食い違う艇が1艇でもいるか」で数える。1艇でも記録があれば拾える。
  const shinnyu = (j) => {
    const w = j == null ? '' : 'WHERE jcd=?'
    const a = j == null ? [] : [j]
    const tot = one(`SELECT COUNT(*) n FROM races ${w}`, a)
    const off = one(`SELECT COUNT(DISTINCT e.race_id) n ${W}
      WHERE e.course IS NOT NULL AND e.lane <> e.course ${j == null ? '' : 'AND r.jcd=?'}`, a)
    return { n: tot.n ?? 0, w: (tot.n ?? 0) - (off.n ?? 0) }
  }

  return { jcd, venue: VENUES[jcd], span, byCourse, natCourse, byYear, byRaceNo, byWind, byWave,
    kimarite, kimByCourse, pay: pay(jcd), natPay: nat('pay', () => pay(null)), racers,
    shinnyu: shinnyu(jcd), natShinnyu: nat('shinnyu', () => shinnyu(null)) }
}

// ---------- 文章に組み立てる ----------
function build(d) {
  const V = d.venue
  const c1 = d.byCourse.find((x) => x.lane === 1)
  const n1 = d.natCourse.find((x) => x.lane === 1)
  const L = []
  const say = (s) => L.push(s)

  const total = d.span.n?.toLocaleString() ?? '―'
  const period = `${d.span.a?.replaceAll('-', '/')}〜${d.span.b?.replaceAll('-', '/')}`

  say(`---`)
  say(`title: ${V}競艇場のデータ攻略｜1コース1着率${f1(pct(c1?.w, c1?.n))}%・${total}レースの実測`)
  say(`date: ${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)}`)
  say(`---`)
  say('')
  say(`ボートレース${V}で実際に何が起きているかを、当サイトが集めた**${total}レース**`)
  say(`（${period}）の公式記録から集計しました。すべて実測で、推計や印象は入っていません。`)
  say(`**割合には母数（n）を添えています。** 母数が小さいものは、差があるように見えても偶然のことがあります。`)
  say('')

  // ---- インの強さ ----
  say(`## ${V}はインが強いか`)
  say('')
  if (c1 && n1) {
    const here = pct(c1.w, c1.n), nat = pct(n1.w, n1.n)
    const sure = isSure(c1, n1)
    const dir = here > nat ? '高い' : '低い'
    say(`1コースの1着率は**${f1(here)}%**（n=${c1.n.toLocaleString()}）。全国平均は${f1(nat)}%です。`)
    say(sure
      ? `全国平均より**${Math.abs(here - nat).toFixed(1)}ポイント${dir}**水面です（統計的にも差があります）。`
      : `全国平均との差は${Math.abs(here - nat).toFixed(1)}ポイントで、**ほぼ平均どおり**と見てよい水準です。`)
    say('')
  }
  say('| コース | 1着率 | 2連対率 | 3連対率 | 走数 |')
  say('|---|---|---|---|---|')
  for (const r of d.byCourse) {
    const nat = d.natCourse.find((x) => x.lane === r.lane)
    const mark = r.lane === 1 ? '**1コース**' : `${r.lane}コース`
    say(`| ${mark} | ${f1(pct(r.w, r.n))}%${nat ? `（全国${f1(pct(nat.w, nat.n))}%）` : ''} | ${f1(pct(r.w2, r.n))}% | ${f1(pct(r.w3, r.n))}% | ${r.n.toLocaleString()} |`)
  }
  say('')

  // ---- 進入 ----
  const s = d.shinnyu, ns = d.natShinnyu
  if (s?.n >= MIN_N && ns?.n) {
    const here = pct(s.w, s.n), natP = pct(ns.w, ns.n)
    say(`## 進入（枠なりで収まるか、前付けがあるか）`)
    say('')
    say(`${V}で**全艇が枠番どおりの進入になったレースは${f1(here)}%**（n=${s.n.toLocaleString()}）。全国平均は${f1(natP)}%です。`)
    say(isSure({ w: s.w, n: s.n }, { w: ns.w, n: ns.n })
      ? here < natP
        ? `全国より**${(natP - here).toFixed(1)}ポイント低く**、前付け（枠より内へ入り込む動き）が起きやすい場です。枠番だけで決め打ちすると外れます。`
        : `全国より**${(here - natP).toFixed(1)}ポイント高く**、枠なりで収まりやすい場です。`
      : `全国平均とほぼ同じ水準です。`)
    say('')
  }

  // ---- レース番号 ----
  const ex = extremes(d.byRaceNo)
  say(`## レース番号で1コースの強さが変わるか`)
  say('')
  if (ex) {
    say(`${V}では、**${ex.hi.label}Rの1コース1着率が${f1(pct(ex.hi.w, ex.hi.n))}%**（n=${ex.hi.n.toLocaleString()}）、`)
    say(`**${ex.lo.label}Rが${f1(pct(ex.lo.w, ex.lo.n))}%**（n=${ex.lo.n.toLocaleString()}）で、`)
    say(`**${(pct(ex.hi.w, ex.hi.n) - pct(ex.lo.w, ex.lo.n)).toFixed(1)}ポイントの開き**があります。偶然では説明できない差です。`)
    say('')
    say(`後半のレースほど上位級の選手が多く組まれるため、どの場でもこの傾向は出ますが、開き方は場によって違います。`)
  } else {
    say(`${V}では、レース番号による1コース1着率の差は、母数を考えると**偶然の範囲**でした。`)
    say(`番号で決め打ちせず、出走表を見るほうが確かです。`)
  }
  say('')
  say('| レース | 1コース1着率 | 走数 |')
  say('|---|---|---|')
  for (const r of d.byRaceNo) say(`| ${r.label}R | ${f1(pct(r.w, r.n))}% | ${r.n.toLocaleString()} |`)
  say('')

  // ---- 年ごとの推移 ----
  // 「この場は昔と変わったのか」。水面の改修や進入の流行で動くことがある。
  const ys = d.byYear.filter((y) => y.n >= MIN_N)
  if (ys.length >= 2) {
    say(`## 年ごとの変化`)
    say('')
    say('| 年 | 1コース1着率 | 走数 |')
    say('|---|---|---|')
    for (const y of ys) say(`| ${y.label}年 | ${f1(pct(y.w, y.n))}% | ${y.n.toLocaleString()} |`)
    say('')
    const first = ys[0], last = ys.at(-1)
    say(isSure(first, last)
      ? `${first.label}年の${f1(pct(first.w, first.n))}%から${last.label}年の${f1(pct(last.w, last.n))}%へ、`
        + `**${pct(last.w, last.n) > pct(first.w, first.n) ? 'インが強くなっています' : 'インが弱くなっています'}**。`
        + `古い年のデータだけで判断すると外れます。`
      : `${first.label}年と${last.label}年の差は偶然の範囲で、**傾向は変わっていません**。`)
    say('')
  }

  // ---- 風と波 ----
  say(`## 風と波でどう変わるか`)
  say('')
  for (const [title, rows] of [['風の強さ', d.byWind], ['波の高さ', d.byWave]]) {
    const e = extremes(rows)
    say(`**${title}別の1コース1着率**`)
    say('')
    say(`| ${title} | 1コース1着率 | 走数 |`)
    say('|---|---|---|')
    for (const r of rows) say(`| ${r.label} | ${r.n >= MIN_N ? f1(pct(r.w, r.n)) + '%' : '―'} | ${r.n.toLocaleString()} |`)
    say('')
    say(e
      ? `「${e.hi.label}」の${f1(pct(e.hi.w, e.hi.n))}%に対し「${e.lo.label}」は${f1(pct(e.lo.w, e.lo.n))}%。**${title}はインの勝率に効いています。**`
      : `母数を考えると、${title}による差は**偶然の範囲**でした。${V}では${title}を強く見すぎないほうがよさそうです。`)
    say('')
  }

  // ---- 決まり手 ----
  const kTot = d.kimarite.reduce((s, x) => s + x.n, 0)
  say(`## 決まり手`)
  say('')
  if (kTot >= MIN_N) {
    const nige = d.kimarite.find((x) => x.label === '逃げ')
    say(`1コースが1着になった${kTot.toLocaleString()}回の内訳です。`)
    say('')
    say('| 決まり手 | 回数 | 割合 | どういう勝ち方か |')
    say('|---|---|---|---|')
    for (const k of d.kimarite)
      say(`| ${k.label} | ${k.n.toLocaleString()} | ${f1(pct(k.n, kTot))}% | ${KIMARITE_DESC[k.label] ?? '―'} |`)
    say('')
    if (nige) say(`1コースの勝ちは**${f1(pct(nige.n, kTot))}%が「逃げ」**です。`)
    // ★「差しやまくりが無いのはおかしい」と読まれるので、先に説明しておく（2026-10-11 本人指摘）
    say(`なお、1コースの決まり手は**この3つしかありません**。`)
    say(`「逃げ」は1コースの艇だけに使われる言葉で、「差し」「まくり」「まくり差し」は`)
    say(`外のコースが内の艇を抜いたときの呼び方だからです。`)
    say('')
  }
  for (const g of d.kimByCourse) {
    const t = g.rows.reduce((s, x) => s + x.n, 0)
    if (t < MIN_N) continue
    const top = g.rows[0]
    say(`- **${g.course}コース**が勝ったとき（${t.toLocaleString()}回）は「${top.label}」が${f1(pct(top.n, t))}%でいちばん多い決まり手です。`)
  }
  say('')

  // ---- 配当 ----
  say(`## 配当の水準`)
  say('')
  const p = d.pay, np = d.natPay
  if (p.n >= MIN_N) {
    say('| | ' + V + ' | 全国 |')
    say('|---|---|---|')
    say(`| 3連単の平均配当 | **${yen(p.av)}円** | ${yen(np.av)}円 |`)
    say(`| 3連単の中央値 | ${yen(p.mid)}円 | ${yen(np.mid)}円 |`)
    say(`| 万舟（1万円以上）の率 | **${f1(pct(p.man, p.n))}%** | ${f1(pct(np.man, np.n))}% |`)
    say(`| 最高配当 | ${yen(p.mx)}円 | ${yen(np.mx)}円 |`)
    say(`| レース数 | ${p.n.toLocaleString()} | ${np.n.toLocaleString()} |`)
    say('')
    const sure = isSure({ w: p.man, n: p.n }, { w: np.man, n: np.n })
    say(sure
      ? `万舟率は全国より**${pct(p.man, p.n) > pct(np.man, np.n) ? '高く、荒れやすい' : '低く、堅く決まりやすい'}**場です。`
      : `万舟率は全国平均とほぼ変わりません。`)
    say('')
    say(`⚠ 平均配当が高いことは「儲かる」という意味ではありません。`)
    say(`控除率25%はどの場でも同じで、荒れる場は当たる回数が減ります`)
    say(`（[控除率25%とは何か](/news/2026-10-10-kojoritsu)）。`)
    say('')
  }

  // ---- 当地の選手 ----
  if (d.racers.length) {
    say(`## 当地で1着率が高い選手（直近2年・40走以上）`)
    say('')
    say('| 選手 | 当地1着率 | 走数 |')
    say('|---|---|---|')
    for (const r of d.racers) say(`| ${r.name} | ${f1(pct(r.w, r.n))}% | ${r.n} |`)
    say('')
    say(`走数が少ないほど上振れしやすいので、順位そのものより**何走でその率か**を見てください。`)
    say('')
  }

  // ---- 出典 ----
  say(`## このページの数字について`)
  say('')
  say(`- 出どころ：公式の競走成績。当サイトが${period}ぶんを自前で集計`)
  say(`- 対象：ボートレース${V}の**${total}レース**`)
  say(`- コースは**進入コース**（枠番ではありません）`)
  say(`- 「いちばん高い／低い」は、**2標本の割合の差の検定で p<0.01 のときだけ**書いています。`)
  say(`  届かないものは「偶然の範囲」と書き、表だけを出しています`)
  say(`- 配当は確定払戻です。締切前に同じオッズで買えるとは限りません`)
  say('')
  say(`この集計はおよそ3〜4週間ごとに測り直しています。`)
  say(`数字の読み方は[的中率と回収率は別物という話](/news/2026-10-10-tekichu-kaishu)にまとめています。`)
  say('')
  say(`舟券の購入は20歳からです。のめり込みに注意してください。`)

  return L.join('\n') + '\n'
}

export function makeArticle(db, jcd) { return build(gather(db, jcd)) }

// ---------- 実行 ----------
// ⚠ 直接走らせたときだけ動かす。`endsWith('venue-article.mjs')` で見ると
//   **test-venue-article.mjs も当たってしまい**、試験が本番のファイルを書き換える。
const isMain = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href }
  catch { return false }
})()
if (isMain) {
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
  db.exec('PRAGMA busy_timeout = 30000')
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const list = argv.includes('--all') ? Array.from({ length: 24 }, (_, i) => i + 1)
    : [Number(flag('jcd', venueOfDay(today)))]
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
  for (const jcd of list) {
    if (!(jcd >= 1 && jcd <= 24)) { console.error(`場コードが変です: ${jcd}`); process.exitCode = 1; continue }
    const md = makeArticle(db, jcd)
    if (argv.includes('--dry')) { console.log(md); continue }
    const f = join(OUT, String(jcd).padStart(2, '0') + '.md')
    const before = existsSync(f) ? readFileSync(f, 'utf8') : ''
    writeFileSync(f, md)
    console.log(`${VENUES[jcd]}（${String(jcd).padStart(2, '0')}.md）${before ? '更新' : '新規'} ${md.length}文字`)
  }
  db.close()
}
