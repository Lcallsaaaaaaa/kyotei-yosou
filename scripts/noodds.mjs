// オッズを使わずに選ぶ買い方を、過去298日で総当たりに検証する。
//   node --max-old-space-size=8192 scripts/noodds.mjs              券種ごとの基本形
//   node --max-old-space-size=8192 scripts/noodds.mjs --seg        条件で切る
//   node --max-old-space-size=8192 scripts/noodds.mjs --ex         展示情報で切る
//
// ★なぜこの枠が大事か
//   判定にオッズを使わなければ、**過去のレース全部で検証できる**。
//   締切前オッズは12日ぶんしかなく、しかも使えるのは4割。
//   オッズを使う方式は価格を固定できない（総取り式なので払戻は締切後に決まる）。
//   だから「オッズ抜きで勝てる形があるか」は、先に潰しておく価値がある。
//
// ★勝ち負けの基準
//   払戻は必ず確定の payouts。判定にオッズは一切使わない。
//   買うか買わないかはモデルの確率と、締切前に分かる条件だけで決める。
//
// ★確率の作り方
//   wi1  … 1着の確率
//   wi3  … 3連単120通りの確率。ここから
//            2着以内 = その艇が1着か2着に来る確率の合計
//            3着以内 = 1〜3着のどれかに来る確率の合計
//            2連複/2連単/拡連複 = 該当する並びの確率の合計
//   歩進検証なので、その月より前だけで学習した確率。未来は混ざっていない。
//
// ★見方（1つでも欠けたら採用しない）
//   回収率が100%を超えているか／最大1本を抜いても超えるか／月別が偏っていないか。
//   条件を大量に試すと、偶然良く見えるものが必ず出る。月別とブレ幅で必ず殺す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)

const PAY = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts WHERE amount IS NOT NULL`).iterate())
  PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
const RANK = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = RANK.get(r.race_id); if (!a) { a = new Map(); RANK.set(r.race_id, a) }
  a.set(r.lane, r.rank_num)
}
// レースの条件
const COND = new Map()
for (const r of db.prepare(`SELECT race_id, jcd, race_no, grade, wind_speed, wave, day_no, weather, deadline FROM races`).iterate())
  COND.set(r.race_id, r)

// 1着の確率と月
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, month FROM wi1`).iterate()) {
  let a = R.get(r.race_id)
  if (!a) { a = { mo: r.month, p1: new Map(), p2: new Map(), p3: new Map(), pair: new Map(), ord: new Map() }; R.set(r.race_id, a) }
  a.p1.set(r.lane, r.p)
}
// wi3 から 2着以内 / 3着以内 / 組み合わせの確率を作る
{
  let cur = null, a = null
  for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { cur = r.race_id; a = R.get(cur) }
    if (!a) continue
    const [x, y, z] = r.combo.split('-').map(Number)
    a.p2.set(x, (a.p2.get(x) ?? 0) + r.p); a.p2.set(y, (a.p2.get(y) ?? 0) + r.p)
    for (const l of [x, y, z]) a.p3.set(l, (a.p3.get(l) ?? 0) + r.p)
    // 2連複（1着2着の組・順不同）と2連単（順あり）
    const pk = [x, y].sort((m, n) => m - n).join('-')
    a.pair.set(pk, (a.pair.get(pk) ?? 0) + r.p)
    a.ord.set(`${x}-${y}`, (a.ord.get(`${x}-${y}`) ?? 0) + r.p)
  }
}
// 拡連複＝3着以内に2艇とも入る組。3連単の並びから該当を足す
for (const [, a] of R) {
  a.kaku = new Map()
  for (const [c, p] of a.ord) { /* 使わないが形をそろえる */ void c; void p }
}
{
  let cur = null, a = null
  for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { cur = r.race_id; a = R.get(cur) }
    if (!a) continue
    const t = r.combo.split('-').map(Number)
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const k = [t[i], t[j]].sort((m, n) => m - n).join('-')
      a.kaku.set(k, (a.kaku.get(k) ?? 0) + r.p)
    }
  }
}
console.log(`${R.size.toLocaleString()}レース（歩進検証・${[...new Set([...R.values()].map((x) => x.mo))].length}ヶ月）\n`)

/** 券種ごとの「当たったか」と「払戻の引き当てキー」 */
const KIND = {
  tansho:     { probe: (a) => a.p1, win: (rk, c) => rk.get(Number(c)) === 1 },
  fukusho:    { probe: (a) => a.p2, win: (rk, c) => rk.get(Number(c)) <= 2 },
  kakuren:    { probe: (a) => a.kaku, win: (rk, c) => c.split('-').every((l) => rk.get(Number(l)) <= 3) },
  nirenpuku:  { probe: (a) => a.pair, win: (rk, c) => c.split('-').every((l) => rk.get(Number(l)) <= 2) },
  nirentan:   { probe: (a) => a.ord, win: (rk, c) => { const [x, y] = c.split('-').map(Number); return rk.get(x) === 1 && rk.get(y) === 2 } },
}

/**
 * @param kind 券種
 * @param pts  買う点数（確率の高い順）
 * @param filter (race, cond) => true なら対象
 */
function ev(kind, pts, filter) {
  const K = KIND[kind]
  let bets = 0, hit = 0, ret = 0, races = 0
  const per = new Map(), gains = []
  for (const [rid, a] of R) {
    const rk = RANK.get(rid); if (!rk || rk.size < 3) continue
    const cd = COND.get(rid)
    if (filter && !filter(a, cd, rid)) continue
    races++
    const list = [...K.probe(a)].sort((x, y) => y[1] - x[1]).slice(0, pts)
    for (const [combo] of list) {
      const won = K.win(rk, String(combo))
      const g = won ? (PAY.get(rid + '|' + kind + '|' + String(combo)) ?? null) : 0
      if (g == null) continue                    // 払戻が入っていない
      bets++; if (won) { hit++; gains.push(g) }
      ret += g
      let m = per.get(a.mo); if (!m) { m = { n: 0, g: 0 }; per.set(a.mo, m) }
      m.n++; m.g += g
    }
  }
  if (bets < 200) return null
  gains.sort((x, y) => y - x)
  const roi = ret / (bets * 100) * 100
  const roiX1 = bets > 1 && gains.length ? (ret - gains[0]) / ((bets - 1) * 100) * 100 : roi
  const ms = [...per].sort()
  return { races, bets, hitRate: hit / bets * 100, roi, roiX1,
    pos: ms.filter(([, m]) => m.g > m.n * 100).length, months: ms.length,
    lo: Math.min(...ms.map(([, m]) => m.g / (m.n * 100) * 100)) }
}
const NM = { tansho: '単勝', fukusho: '複勝', kakuren: '拡連複', nirenpuku: '2連複', nirentan: '2連単' }
function show(label, r) {
  if (!r) return
  const flag = r.roi >= 100 && r.roiX1 >= 100 && r.pos >= r.months - 2 ? '  ★' : ''
  console.log(`  ${label.padEnd(30)} ${String(r.bets).padStart(7)}本 的中${r.hitRate.toFixed(1).padStart(5)}% ` +
    `回収${r.roi.toFixed(1).padStart(6)}% 最大1本抜${r.roiX1.toFixed(1).padStart(6)}% ` +
    `月別${String(r.pos + '/' + r.months).padStart(5)} 最悪月${r.lo.toFixed(0).padStart(4)}%${flag}`)
}

if (argv.includes('--search')) {
  // ---------- ② 細い条件を複数見つけて並走させる ----------
  //   node --max-old-space-size=8192 scripts/noodds.mjs --search
  //
  // ★手順を先に固定する（後から良かったものを選ばないため）
  //   1. 歩進検証(wi1)の前半5ヶ月だけを見て候補を選ぶ
  //   2. 後半5ヶ月で試す（ここは選ぶときに見ていない）
  //   3. 通ったものを本番モデル(pred)で確認する。別モデル・別期間の二重チェック
  //   4. **試した組み合わせの数を必ず出す**。偶然いくつ通るかを見積もるため
  //
  // ⚠ 組み合わせを増やすほど偶然が紛れ込む。通った数が偶然の見込みと変わらないなら、
  //   それは「見つかった」ではない。
  const PG = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, grade, age, weight, win_rate_nat, top2_nat,
      win_rate_loc, motor_top2, boat_top2 FROM programs`).iterate())
    PG.set(r.race_id + '|' + r.lane, r)
  const RF = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, ex_rank, exst_rank, exc_race_moved, tilt_now, parts_self FROM rfeat`).iterate())
    RF.set(r.race_id + '|' + r.lane, r)

  // 選手の属性（看板になりうるもの）
  const A = [
    ['級別B2', (g) => g.grade === 'B2'],
    ['級別B1', (g) => g.grade === 'B1'],
    ['級別B', (g) => /^B/.test(g.grade)],
    ['級別A2', (g) => g.grade === 'A2'],
    ['級別A1', (g) => g.grade === 'A1'],
    ['勝率4.5未満', (g) => g.win_rate_nat < 4.5],
    ['勝率4.5〜5.5', (g) => g.win_rate_nat >= 4.5 && g.win_rate_nat < 5.5],
    ['勝率6.5以上', (g) => g.win_rate_nat >= 6.5],
    ['2連対率25%未満', (g) => g.top2_nat < 25],
    ['2連対率45%以上', (g) => g.top2_nat >= 45],
    ['当地が全国より1.0高い', (g) => g.win_rate_loc - g.win_rate_nat >= 1],
    ['当地が全国より1.0低い', (g) => g.win_rate_loc - g.win_rate_nat <= -1],
    ['25歳未満', (g) => g.age < 25],
    ['50歳以上', (g) => g.age >= 50],
    ['体重48kg以下', (g) => g.weight <= 48],
    ['モーター50%以上', (g) => g.motor_top2 >= 50],
    ['モーター25%未満', (g) => g.motor_top2 < 25],
    ['属性を問わない', () => true],
  ]
  // レースの条件と展示
  const B = [
    ['条件を問わない', () => true],
    ['風速3m以上', (g, c) => c && c.wind_speed >= 3],
    ['風速1m以下', (g, c) => c && c.wind_speed <= 1],
    ['波高3cm以上', (g, c) => c && c.wave >= 3],
    ['波高0cm', (g, c) => c && c.wave === 0],
    ['前半R(1〜4R)', (g, c) => c && c.race_no <= 4],
    ['後半R(9R以降)', (g, c) => c && c.race_no >= 9],
    ['節の序盤(1〜2日目)', (g, c) => c && c.day_no <= 2],
    ['節の終盤(5日目以降)', (g, c) => c && c.day_no >= 5],
    ['一般戦', (g, c) => c && (c.grade == null || c.grade === '一般')],
    ['展示タイム1位', (g, c, f) => f && f.ex_rank === 1],
    ['展示タイム3位以下', (g, c, f) => f && f.ex_rank >= 3],
    ['展示ST1位', (g, c, f) => f && f.exst_rank === 1],
    ['展示ST4位以下', (g, c, f) => f && f.exst_rank >= 4],
    ['進入が枠なり', (g, c, f) => f && f.exc_race_moved === 0],
    ['チルト0', (g, c, f) => f && f.tilt_now === 0],
  ]
  const CAPS = [0.30, 0.40, 0.50]

  function evaluate(rows, fn) {
    let bets = 0, hit = 0, ret = 0
    const per = new Map(), gains = []
    for (const [rid, a] of rows) {
      const rk = RANK.get(rid); if (!rk) continue
      const t = [...a.p1].sort((x, y) => y[1] - x[1])[0]; if (!t) continue
      const g = PG.get(rid + '|' + t[0]); if (!g) continue
      if (!fn(g, COND.get(rid), RF.get(rid + '|' + t[0]), t[1])) continue
      const won = rk.get(t[0]) === 1
      const pay = won ? (PAY.get(rid + '|tansho|' + t[0]) ?? null) : 0
      if (pay == null) continue
      bets++; if (won) { hit++; gains.push(pay) }
      ret += pay
      let m = per.get(a.mo); if (!m) { m = { n: 0, g: 0 }; per.set(a.mo, m) }
      m.n++; m.g += pay
    }
    if (!bets) return null
    gains.sort((x, y) => y - x)
    const ms = [...per]
    return { bets, hitRate: hit / bets * 100, roi: ret / (bets * 100) * 100,
      roiX1: gains.length && bets > 1 ? (ret - gains[0]) / ((bets - 1) * 100) * 100 : 0,
      pos: ms.filter(([, m]) => m.g > m.n * 100).length, months: ms.length }
  }
  const MONTHS = [...new Set([...R.values()].map((a) => a.mo))].sort()
  const cut = MONTHS[Math.floor(MONTHS.length / 2)]
  const TRAIN = [...R].filter(([, a]) => a.mo < cut)
  const TEST = [...R].filter(([, a]) => a.mo >= cut)
  const DAYS_TEST = new Set(TEST.map(([k]) => k.slice(0, 8))).size
  console.log(`前半 ${MONTHS[0]}〜（選ぶ・${TRAIN.length.toLocaleString()}レース）／ 後半 ${cut}〜（試す・${TEST.length.toLocaleString()}レース）\n`)

  // ---------- 1. 前半だけで候補を選ぶ ----------
  const MIN_BETS = 80, TRAIN_ROI = 115
  const cand = []
  let tried = 0
  for (const [an, af] of A) for (const [bn, bf] of B) for (const cap of CAPS) {
    tried++
    const fn = (g, c, f, p) => p < cap && af(g) && bf(g, c, f)
    const tr = evaluate(TRAIN, fn)
    if (!tr || tr.bets < MIN_BETS || tr.roi < TRAIN_ROI) continue
    cand.push({ nm: `${an}／${bn}／確率${cap * 100}%未満`, fn, tr })
  }
  console.log(`試した組み合わせ ${tried}通り`)
  console.log(`前半で候補になった（${MIN_BETS}本以上かつ回収${TRAIN_ROI}%以上） ${cand.length}件`)

  // ---------- 2. 後半で試す ----------
  const pass = []
  for (const c of cand) {
    const te = evaluate(TEST, c.fn)
    if (!te || te.bets < 40) continue
    c.te = te
    if (te.roi >= 100 && te.roiX1 >= 100) pass.push(c)
  }
  console.log(`後半でも100%超（1本抜きでも） ${pass.length}件`)
  // 偶然どれくらい通るか。前半で選ばれた候補が後半で偶然100%を超える確率を
  // 「全体の回収率92.4%」の下で見積もる。厳密ではないが桁の目安になる。
  console.log(`  ※ 候補${cand.length}件のうち、優位が無くても偶然100%を超えるのは経験的に3〜4割。`)
  console.log(`    目安 ${Math.round(cand.length * 0.35)}件くらいは偶然通る。それを大きく超えていなければ「見つかった」ではない。\n`)

  if (!pass.length) { console.log('後半を通ったものなし'); db.close(); process.exit(0) }
  pass.sort((x, y) => y.te.roi - x.te.roi)
  console.log('  条件                                          前半(選ぶ)        後半(試す)')
  console.log('                                            本数  回収率 ┃ 本数 1日  的中 回収率 1本抜 月別')
  for (const c of pass.slice(0, 25))
    console.log(`  ${c.nm.padEnd(42)} ${String(c.tr.bets).padStart(5)}${c.tr.roi.toFixed(0).padStart(6)}% ┃` +
      `${String(c.te.bets).padStart(5)}${(c.te.bets / DAYS_TEST).toFixed(2).padStart(5)}` +
      `${c.te.hitRate.toFixed(0).padStart(5)}%${c.te.roi.toFixed(0).padStart(6)}%${c.te.roiX1.toFixed(0).padStart(6)}%` +
      `${String(c.te.pos + '/' + c.te.months).padStart(6)}`)
  if (pass.length > 25) console.log(`  …ほか ${pass.length - 25}件`)
  console.log(`\n次は「node scripts/noodds.mjs --verify」で、通ったものを本番モデル(pred)で確認する。`)
  // 通った条件を保存して --verify で使う
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(ROOT, 'data', 'search-pass.json'),
    JSON.stringify(pass.map((c) => ({ nm: c.nm, tr: c.tr, te: c.te })), null, 1))
  db.close(); process.exit(0)
}

if (argv.includes('--loosen')) {
  // ---------- ① 条件を緩めて本数を増やせるか ----------
  // ★なぜ要るか
  //   B2×確率40%未満は1日0.84本しかなく、検証が終わらない（400点＝約1年3ヶ月）。
  //   本数を増やして、回収率がどこまで保つかを見る。
  //
  // ★あわせて「なぜB2が効くのか」を切り分ける
  //   仮説A（看板）… 出走表に「B2」と印刷されるから世間が強く割り引く。
  //                  ならば同じ弱さでも級別が違えば効き方が変わる。
  //   仮説B（弱さ）… 単に弱い選手だから。ならば勝率で切っても同じように効くはず。
  //   全国勝率をそろえた中で B1 と B2 を比べれば分かる。
  const PG = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, grade, win_rate_nat, top2_nat FROM programs`).iterate())
    PG.set(r.race_id + '|' + r.lane, r)
  const MONTHS = [...new Set([...R.values()].map((a) => a.mo))].sort()
  const cut = MONTHS[Math.floor(MONTHS.length / 2)]
  const DAYS = new Set([...R.keys()].map((k) => k.slice(0, 8))).size
  const top = (a) => [...a.p1].sort((x, y) => y[1] - x[1])[0]

  function run(fn, half) {
    let bets = 0, hit = 0, ret = 0
    const per = new Map(), gains = []
    for (const [rid, a] of R) {
      if (half === 'a' && a.mo >= cut) continue
      if (half === 'b' && a.mo < cut) continue
      const rk = RANK.get(rid); if (!rk) continue
      const t = top(a); if (!t) continue
      const g = PG.get(rid + '|' + t[0]); if (!g) continue
      if (!fn(g, t[1])) continue
      const won = rk.get(t[0]) === 1
      const pay = won ? (PAY.get(rid + '|tansho|' + t[0]) ?? null) : 0
      if (pay == null) continue
      bets++; if (won) { hit++; gains.push(pay) }
      ret += pay
      let m = per.get(a.mo); if (!m) { m = { n: 0, g: 0 }; per.set(a.mo, m) }
      m.n++; m.g += pay
    }
    if (bets < 60) return null
    gains.sort((x, y) => y - x)
    const ms = [...per].sort()
    return { bets, hitRate: hit / bets * 100, roi: ret / (bets * 100) * 100,
      roiX1: gains.length ? (ret - gains[0]) / ((bets - 1) * 100) * 100 : 0,
      pos: ms.filter(([, m]) => m.g > m.n * 100).length, months: ms.length }
  }
  const GR = [
    ['B2のみ', (g) => g.grade === 'B2'],
    ['B1+B2', (g) => g.grade === 'B1' || g.grade === 'B2'],
    ['B1のみ', (g) => g.grade === 'B1'],
    ['A2+B1+B2', (g) => g.grade !== 'A1'],
    ['級別を問わない', () => true],
  ]
  console.log('══ ① 級別 × 確率の上限 ══')
  console.log('  級別          確率上限   本数   1日   的中率  回収率 1本抜  月別 ┃前半    後半')
  for (const [gn, gf] of GR) for (const mp of [0.30, 0.35, 0.40, 0.45, 0.50, 0.60, 1.01]) {
    const fn = (g, p) => gf(g) && p < mp
    const all = run(fn), A = run(fn, 'a'), B = run(fn, 'b')
    if (!all) continue
    console.log(`  ${gn.padEnd(13)} ${(mp > 1 ? 'なし' : (mp * 100).toFixed(0) + '%').padStart(5)} ${String(all.bets).padStart(7)} ` +
      `${(all.bets / DAYS).toFixed(2).padStart(5)} ${all.hitRate.toFixed(1).padStart(6)}% ${all.roi.toFixed(1).padStart(6)}% ` +
      `${all.roiX1.toFixed(1).padStart(5)}% ${String(all.pos + '/' + all.months).padStart(5)} ┃` +
      `${A ? A.roi.toFixed(0) + '%' : '  -'}`.padStart(6) + `${B ? B.roi.toFixed(0) + '%' : '  -'}`.padStart(7) +
      `${all.roi >= 100 && all.roiX1 >= 100 && A && B && A.roi >= 100 && B.roi >= 100 ? '  ★' : ''}`)
  }

  console.log('\n══ ② 勝率で緩める（級別を使わない） ══')
  console.log('  条件                    本数   1日   的中率  回収率 1本抜  月別 ┃前半    後半')
  for (const [nm, gf] of [
    ['全国勝率4.5未満', (g) => g.win_rate_nat < 4.5],
    ['全国勝率5.0未満', (g) => g.win_rate_nat < 5.0],
    ['全国勝率5.5未満', (g) => g.win_rate_nat < 5.5],
    ['全国勝率6.0未満', (g) => g.win_rate_nat < 6.0],
    ['2連対率25%未満', (g) => g.top2_nat < 25],
    ['2連対率30%未満', (g) => g.top2_nat < 30],
    ['2連対率35%未満', (g) => g.top2_nat < 35],
  ]) for (const mp of [0.40, 0.50]) {
    const fn = (g, p) => gf(g) && p < mp
    const all = run(fn), A = run(fn, 'a'), B = run(fn, 'b')
    if (!all) continue
    console.log(`  ${(nm + ' 確率' + (mp * 100).toFixed(0) + '%未満').padEnd(23)} ${String(all.bets).padStart(6)} ` +
      `${(all.bets / DAYS).toFixed(2).padStart(5)} ${all.hitRate.toFixed(1).padStart(6)}% ${all.roi.toFixed(1).padStart(6)}% ` +
      `${all.roiX1.toFixed(1).padStart(5)}% ${String(all.pos + '/' + all.months).padStart(5)} ┃` +
      `${A ? A.roi.toFixed(0) + '%' : '  -'}`.padStart(6) + `${B ? B.roi.toFixed(0) + '%' : '  -'}`.padStart(7) +
      `${all.roi >= 100 && all.roiX1 >= 100 && A && B && A.roi >= 100 && B.roi >= 100 ? '  ★' : ''}`)
  }

  console.log('\n══ ③ 看板か弱さか（勝率をそろえて級別を比べる・確率40%未満） ══')
  console.log('  全国勝率の帯   級別   本数   的中率  回収率  平均オッズ')
  const OD = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho>0`).iterate())
    OD.set(r.race_id + '|' + r.lane, r.tansho)
  for (const [lo, hi] of [[0, 4.5], [4.5, 5.0], [5.0, 5.5], [5.5, 6.5]]) {
    for (const gd of ['B2', 'B1', 'A2']) {
      let bets = 0, hit = 0, ret = 0, od = 0, odn = 0
      for (const [rid, a] of R) {
        const rk = RANK.get(rid); if (!rk) continue
        const t = top(a); if (!t || t[1] >= 0.40) continue
        const g = PG.get(rid + '|' + t[0]); if (!g) continue
        if (g.grade !== gd || !(g.win_rate_nat >= lo && g.win_rate_nat < hi)) continue
        const won = rk.get(t[0]) === 1
        const pay = won ? (PAY.get(rid + '|tansho|' + t[0]) ?? null) : 0
        if (pay == null) continue
        bets++; if (won) hit++
        ret += pay
        const o = OD.get(rid + '|' + t[0]); if (o) { od += o; odn++ }
      }
      if (bets < 40) continue
      console.log(`  ${(lo + '〜' + hi).padStart(8)}   ${gd}  ${String(bets).padStart(6)} ${(hit / bets * 100).toFixed(1).padStart(6)}% ` +
        `${(ret / (bets * 100) * 100).toFixed(1).padStart(7)}% ${(odn ? od / odn : 0).toFixed(2).padStart(9)}倍`)
    }
    console.log('')
  }
  console.log('  ★ = 全期間・1本抜き・前半・後半のすべてで100%超')
  db.close(); process.exit(0)
}

if (argv.includes('--combo')) {
  // ---------- ① 条件を組み合わせる（前半で決めて後半で試す） ----------
  // ★条件を大量に試すと偶然良く見えるものが必ず出る。後から選んだだけにならないよう、
  //   月を前半後半に割って、前半だけを見て決め、後半で答え合わせをする。
  //   両方100%を超えて初めて意味がある。
  const MONTHS = [...new Set([...R.values()].map((a) => a.mo))].sort()
  const cut = MONTHS[Math.floor(MONTHS.length / 2)]
  console.log(`前半 ${MONTHS[0]}〜${MONTHS[Math.floor(MONTHS.length / 2) - 1]} / 後半 ${cut}〜${MONTHS[MONTHS.length - 1]}\n`)
  const PG = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, grade, win_rate_nat, top2_nat, motor_top2 FROM programs`).iterate())
    PG.set(r.race_id + '|' + r.lane, r)
  const RF = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, ex_rank FROM rfeat`).iterate())
    RF.set(r.race_id + '|' + r.lane, r.ex_rank)
  const topOf = (a) => [...a.p1].sort((x, y) => y[1] - x[1])[0]

  // 前半で見えた向き＝「本命が弱い選手ほど回収が高い」を軸に組む
  const WEAK = [
    ['級別B2', (g) => g.grade === 'B2'],
    ['級別B1かB2', (g) => g.grade === 'B1' || g.grade === 'B2'],
    ['全国勝率5.0未満', (g) => g.win_rate_nat < 5.0],
    ['全国勝率5.5未満', (g) => g.win_rate_nat < 5.5],
    ['2連対率30%未満', (g) => g.top2_nat < 30],
  ]
  const EXTRA = [
    ['', () => true],
    ['＋展示1位', (g, ex) => ex === 1],
    ['＋展示2位以内', (g, ex) => ex <= 2],
    ['＋モーター45%以上', (g) => g.motor_top2 >= 45],
    ['＋確率50%以上', (g, ex, p) => p >= 0.5],
    ['＋確率40%未満', (g, ex, p) => p < 0.4],
  ]
  function run(kind, half, fn) {
    const K = KIND[kind]
    let bets = 0, hit = 0, ret = 0
    const per = new Map(), gains = []
    for (const [rid, a] of R) {
      if (half === 'a' ? a.mo >= cut : a.mo < cut) continue
      const rk = RANK.get(rid); if (!rk || rk.size < 3) continue
      const t = topOf(a); if (!t) continue
      const g = PG.get(rid + '|' + t[0]); if (!g) continue
      if (!fn(g, RF.get(rid + '|' + t[0]), t[1])) continue
      const combo = kind === 'tansho' ? t[0] : [...K.probe(a)].sort((x, y) => y[1] - x[1])[0][0]
      const won = K.win(rk, String(combo))
      const pay = won ? (PAY.get(rid + '|' + kind + '|' + String(combo)) ?? null) : 0
      if (pay == null) continue
      bets++; if (won) { hit++; gains.push(pay) }
      ret += pay
      let m = per.get(a.mo); if (!m) { m = { n: 0, g: 0 }; per.set(a.mo, m) }
      m.n++; m.g += pay
    }
    if (bets < 100) return null
    gains.sort((x, y) => y - x)
    const ms = [...per].sort()
    return { bets, hitRate: hit / bets * 100, roi: ret / (bets * 100) * 100,
      roiX1: gains.length ? (ret - gains[0]) / ((bets - 1) * 100) * 100 : 0,
      pos: ms.filter(([, m]) => m.g > m.n * 100).length, months: ms.length }
  }
  for (const kind of ['tansho', 'fukusho']) {
    console.log(`══ ${NM[kind]} ══`)
    console.log('  条件                              前半(決める)              後半(試す)')
    console.log('                                 本数  回収率 1本抜  月別 ┃ 本数  回収率 1本抜  月別')
    for (const [wn, wf] of WEAK) for (const [en, ef] of EXTRA) {
      const fn = (g, ex, p) => wf(g) && ef(g, ex, p)
      const A = run(kind, 'a', fn), B = run(kind, 'b', fn)
      if (!A || !B) continue
      const ok = A.roi >= 100 && B.roi >= 100 && B.roiX1 >= 100
      console.log(`  ${(wn + en).padEnd(26)} ${String(A.bets).padStart(5)}${A.roi.toFixed(1).padStart(7)}%${A.roiX1.toFixed(1).padStart(6)}% ${String(A.pos + '/' + A.months).padStart(5)} ┃` +
        `${String(B.bets).padStart(5)}${B.roi.toFixed(1).padStart(7)}%${B.roiX1.toFixed(1).padStart(6)}% ${String(B.pos + '/' + B.months).padStart(5)}${ok ? '  ★両方100%超' : ''}`)
    }
    console.log('')
  }
  db.close(); process.exit(0)
}

if (argv.includes('--racer')) {
  // ---------- ② 選手の属性で切る ----------
  // ★モデルの中には入っているが、買う/買わないの条件としては一度も使っていなかった。
  const PG = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, age, weight, grade, win_rate_nat, top2_nat,
      win_rate_loc, motor_top2, boat_top2 FROM programs`).iterate())
    PG.set(r.race_id + '|' + r.lane, r)
  const of = (a, rid) => { const t = [...a.p1].sort((x, y) => y[1] - x[1])[0]; return t ? PG.get(rid + '|' + t[0]) : null }
  const F = [
    ['級別A1', (g) => g.grade === 'A1'], ['級別A2', (g) => g.grade === 'A2'],
    ['級別B1', (g) => g.grade === 'B1'], ['級別B2', (g) => g.grade === 'B2'],
    ['30歳未満', (g) => g.age < 30], ['30〜39歳', (g) => g.age >= 30 && g.age < 40],
    ['40〜49歳', (g) => g.age >= 40 && g.age < 50], ['50歳以上', (g) => g.age >= 50],
    ['体重50kg未満', (g) => g.weight < 50], ['体重55kg以上', (g) => g.weight >= 55],
    ['全国勝率6.0以上', (g) => g.win_rate_nat >= 6], ['全国勝率5.0未満', (g) => g.win_rate_nat < 5],
    ['当地勝率が全国より1.0高い', (g) => g.win_rate_loc - g.win_rate_nat >= 1],
    ['当地勝率が全国より1.0低い', (g) => g.win_rate_loc - g.win_rate_nat <= -1],
    ['モーター2連率45%以上', (g) => g.motor_top2 >= 45], ['モーター2連率30%未満', (g) => g.motor_top2 < 30],
    ['ボート2連率45%以上', (g) => g.boat_top2 >= 45],
    ['2連対率40%以上', (g) => g.top2_nat >= 40], ['2連対率20%未満', (g) => g.top2_nat < 20],
  ]
  for (const kind of ['tansho', 'fukusho', 'kakuren']) {
    console.log(`\n══ ${NM[kind]}（本命1点）を選手の属性で切る ══`)
    show('絞りなし', ev(kind, 1, null))
    const rows = []
    for (const [nm, fn] of F) {
      const r = ev(kind, 1, (a, c, rid) => { const g = of(a, rid); return g ? fn(g) : false })
      if (r) rows.push([nm, r])
    }
    rows.sort((x, y) => y[1].roi - x[1].roi)
    for (const [nm, r] of rows) show(nm, r)
  }
  console.log('\n★ = 回収100%超・最大1本抜いても100%超・月別が2ヶ月以内の負けに収まる')
  db.close(); process.exit(0)
}

if (argv.includes('--pick')) {
  // ---------- ③ 本命以外を買う ----------
  // ★ここまで全部「本命1点」だった。買う対象そのものを変える。
  const nth = (src, n) => (a) => { const s = [...src(a)].sort((x, y) => y[1] - x[1]); return s[n] ? [s[n]] : [] }
  const evPick = (kind, nm, pickFn) => {
    const K = KIND[kind]
    let bets = 0, hit = 0, ret = 0
    const per = new Map(), gains = []
    for (const [rid, a] of R) {
      const rk = RANK.get(rid); if (!rk || rk.size < 3) continue
      for (const [combo] of pickFn(a, COND.get(rid))) {
        const won = K.win(rk, String(combo))
        const g = won ? (PAY.get(rid + '|' + kind + '|' + String(combo)) ?? null) : 0
        if (g == null) continue
        bets++; if (won) { hit++; gains.push(g) }
        ret += g
        let m = per.get(a.mo); if (!m) { m = { n: 0, g: 0 }; per.set(a.mo, m) }
        m.n++; m.g += g
      }
    }
    if (bets < 200) return
    gains.sort((x, y) => y - x)
    const roi = ret / (bets * 100) * 100
    const ms = [...per].sort()
    show(nm, { bets, hitRate: hit / bets * 100, roi,
      roiX1: gains.length ? (ret - gains[0]) / ((bets - 1) * 100) * 100 : roi,
      pos: ms.filter(([, m]) => m.g > m.n * 100).length, months: ms.length,
      lo: Math.min(...ms.map(([, m]) => m.g / (m.n * 100) * 100)) })
  }
  for (const [kind, src] of [['tansho', (a) => a.p1], ['fukusho', (a) => a.p2]]) {
    console.log(`\n══ ${NM[kind]}・買う対象を変える ══`)
    for (const n of [0, 1, 2, 3])
      evPick(kind, `モデルの${n + 1}番手`, nth(src, n))
    for (let l = 1; l <= 6; l++)
      evPick(kind, `${l}号艇を毎回`, (a) => [[l]])
    evPick(kind, '本命が1号艇のときの本命', (a) => { const s = [...src(a)].sort((x, y) => y[1] - x[1]); return s[0][0] === 1 ? [s[0]] : [] })
    evPick(kind, '本命が1号艇でないときの本命', (a) => { const s = [...src(a)].sort((x, y) => y[1] - x[1]); return s[0][0] !== 1 ? [s[0]] : [] })
    evPick(kind, '本命が1号艇のとき2番手', (a) => { const s = [...src(a)].sort((x, y) => y[1] - x[1]); return s[0][0] === 1 && s[1] ? [s[1]] : [] })
    evPick(kind, '1号艇が本命でないとき1号艇', (a) => { const s = [...src(a)].sort((x, y) => y[1] - x[1]); return s[0][0] !== 1 ? [[1, src(a).get(1) ?? 0]] : [] })
  }
  console.log('\n★ = 回収100%超・最大1本抜いても100%超・月別が2ヶ月以内の負けに収まる')
  db.close(); process.exit(0)
}

if (argv.includes('--stake')) {
  // ---------- ⑤ 点数と資金の配分 ----------
  // ★これまで全部「1点100円」。点数を増やす／確率に応じて金額を変える形は未試行。
  //   ⚠ 金額を変えても回収率(払戻÷投入)は「優位の大きい買い目に多く張れた分」しか動かない。
  //     オッズを使わないと優位の大きさが分からないので、確率そのもので代用する。
  const evStake = (kind, nm, pts, weight) => {
    const K = KIND[kind]
    let inv = 0, ret = 0, bets = 0, hit = 0
    const per = new Map()
    for (const [rid, a] of R) {
      const rk = RANK.get(rid); if (!rk || rk.size < 3) continue
      const list = [...K.probe(a)].sort((x, y) => y[1] - x[1]).slice(0, pts)
      for (const [combo, p] of list) {
        const w = weight ? weight(p) : 1
        if (w <= 0) continue
        const won = K.win(rk, String(combo))
        const g = won ? (PAY.get(rid + '|' + kind + '|' + String(combo)) ?? null) : 0
        if (g == null) continue
        bets++; inv += 100 * w; if (won) { hit++; ret += g * w }
        let m = per.get(a.mo); if (!m) { m = { i: 0, g: 0 }; per.set(a.mo, m) }
        m.i += 100 * w; m.g += g * w
      }
    }
    if (bets < 200) return
    const ms = [...per].sort()
    console.log(`  ${nm.padEnd(30)} ${String(bets).padStart(7)}本 的中${(hit / bets * 100).toFixed(1).padStart(5)}% ` +
      `回収${(ret / inv * 100).toFixed(1).padStart(6)}% 月別${String(ms.filter(([, m]) => m.g > m.i).length + '/' + ms.length).padStart(5)}`)
  }
  for (const kind of ['tansho', 'fukusho', 'kakuren']) {
    console.log(`\n══ ${NM[kind]}・点数と配分 ══`)
    for (const pts of [1, 2, 3, 4]) evStake(kind, `本命${pts}点・均等`, pts, null)
    evStake(kind, '本命3点・確率に比例', 3, (p) => p)
    evStake(kind, '本命3点・確率の2乗に比例', 3, (p) => p * p)
    evStake(kind, '本命3点・確率50%以上だけ', 3, (p) => (p >= 0.5 ? 1 : 0))
    evStake(kind, '本命3点・確率70%以上だけ', 3, (p) => (p >= 0.7 ? 1 : 0))
    evStake(kind, '本命3点・確率90%以上だけ', 3, (p) => (p >= 0.9 ? 1 : 0))
  }
  db.close(); process.exit(0)
}

if (argv.includes('--vs')) {
  // ---------- モデルと「枠番の平均」の乖離で買う ----------
  // ★ここまでの検証は全部「本命を買う」形だった。本命買いは人気馬を買うのと同じで、
  //   控除率の大半は取り返せるが上限がある（複勝で96.5%）。
  //   勝つには「市場が低く見ている艇」を買う必要がある。だがオッズは使えない。
  //   → 市場の代わりに**枠番ごとの平均勝率**を置く。世間の見方はほぼ枠番で決まるので、
  //     モデルがその平均より高く見ている艇＝市場が低く見ている艇、の近似になる。
  //   乖離 = モデルの確率 ÷ その枠番の平均。これが大きい艇を買う。
  //   ⚠ 平均は学習に使った期間より前だけでは作れないので、全期間から作る。
  //     枠番の平均勝率は年単位でほとんど動かないため、ここは実害が小さいと判断した。
  const BASE = { p1: new Map(), p2: new Map(), p3: new Map() }
  const cnt = new Map()
  for (const [rid, a] of R) {
    const rk = RANK.get(rid); if (!rk || rk.size < 3) continue
    for (let l = 1; l <= 6; l++) {
      cnt.set(l, (cnt.get(l) ?? 0) + 1)
      const r = rk.get(l)
      BASE.p1.set(l, (BASE.p1.get(l) ?? 0) + (r === 1 ? 1 : 0))
      BASE.p2.set(l, (BASE.p2.get(l) ?? 0) + (r <= 2 ? 1 : 0))
      BASE.p3.set(l, (BASE.p3.get(l) ?? 0) + (r <= 3 ? 1 : 0))
    }
  }
  for (const k of ['p1', 'p2', 'p3']) for (const [l, v] of BASE[k]) BASE[k].set(l, v / cnt.get(l))
  console.log('枠番ごとの平均（これを市場の代わりに置く）')
  for (const k of [['p1', '1着'], ['p2', '2着以内'], ['p3', '3着以内']])
    console.log(`  ${k[1].padEnd(8)} ` + [1, 2, 3, 4, 5, 6].map((l) => `${l}号艇 ${(BASE[k[0]].get(l) * 100).toFixed(1)}%`).join('  '))
  console.log('')

  /** 乖離の大きい艇を買う */
  function evVs(kind, pkey, minRatio, minP, pts = 1) {
    const K = KIND[kind]
    let bets = 0, hit = 0, ret = 0
    const per = new Map(), gains = []
    for (const [rid, a] of R) {
      const rk = RANK.get(rid); if (!rk || rk.size < 3) continue
      const src = kind === 'tansho' ? a.p1 : (kind === 'fukusho' ? a.p2 : a.p3)
      const list = [...src].map(([lane, p]) => ({ lane, p, r: p / BASE[pkey].get(lane) }))
        .filter((x) => x.r >= minRatio && x.p >= minP)
        .sort((x, y) => y.r - x.r).slice(0, pts)
      for (const x of list) {
        const won = kind === 'tansho' ? rk.get(x.lane) === 1 : (kind === 'fukusho' ? rk.get(x.lane) <= 2 : rk.get(x.lane) <= 3)
        const bt = kind === 'sanren3' ? 'fukusho' : kind
        const g = won ? (PAY.get(rid + '|' + bt + '|' + x.lane) ?? null) : 0
        if (g == null) continue
        bets++; if (won) { hit++; gains.push(g) }
        ret += g
        let m = per.get(a.mo); if (!m) { m = { n: 0, g: 0 }; per.set(a.mo, m) }
        m.n++; m.g += g
      }
    }
    if (bets < 200) return null
    gains.sort((x, y) => y - x)
    const roi = ret / (bets * 100) * 100
    const ms = [...per].sort()
    return { bets, hitRate: hit / bets * 100, roi,
      roiX1: gains.length ? (ret - gains[0]) / ((bets - 1) * 100) * 100 : roi,
      pos: ms.filter(([, m]) => m.g > m.n * 100).length, months: ms.length,
      lo: Math.min(...ms.map(([, m]) => m.g / (m.n * 100) * 100)) }
  }
  for (const [kind, pkey] of [['tansho', 'p1'], ['fukusho', 'p2']]) {
    console.log(`\n══ ${NM[kind]}・枠番の平均より高く見ている艇を買う ══`)
    console.log('  条件                                本数  的中率  回収率  最大1本抜  月別  最悪月')
    for (const mr of [1.2, 1.5, 2.0, 3.0, 5.0, 8.0])
      show(`乖離${mr}倍以上のうち最大1本`, evVs(kind, pkey, mr, 0))
    for (const mp of [0.05, 0.10, 0.20])
      show(`乖離2倍以上かつ確率${mp * 100}%以上`, evVs(kind, pkey, 2.0, mp))
    show('乖離1.5倍以上を全部（点数無制限）', evVs(kind, pkey, 1.5, 0, 6))
  }
  console.log('\n★ = 回収100%超・最大1本抜いても100%超・月別が2ヶ月以内の負けに収まる')
  db.close(); process.exit(0)
}

if (argv.includes('--ex')) {
  // ---------- 展示情報で切る ----------
  // ★展示は締切の15分ほど前に出る。**オッズが要らないのに締切前に手に入る**唯一の情報。
  //   朝の予想では使えないが、買う直前には使える。ここに勝ち筋があるなら実行できる。
  //   モデル(model5)は展示を使っていないので、これは「モデルの外側の情報」でもある。
  const RF = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, ex_rank, ex_rel, ex_gap_best, exc_moved, exc_race_moved,
      exst_rank, exst_rel, tilt_now, adj_rel, parts_self, parts_race, temp_diff FROM rfeat`).iterate())
    RF.set(r.race_id + '|' + r.lane, r)
  const of = (a, rid) => {   // 本命の艇の展示
    const top = [...a.p1].sort((x, y) => y[1] - x[1])[0]
    return top ? RF.get(rid + '|' + top[0]) : null
  }
  const FILTERS = [
    ['展示タイム1位', (f) => f.ex_rank === 1],
    ['展示タイム2位以内', (f) => f.ex_rank <= 2],
    ['展示タイム4位以下', (f) => f.ex_rank >= 4],
    ['展示が最速から離れている', (f) => f.ex_gap_best != null && f.ex_gap_best >= 0.15],
    ['展示が最速に近い', (f) => f.ex_gap_best != null && f.ex_gap_best <= 0.03],
    ['進入が動いていない', (f) => f.exc_moved === 0],
    ['進入が動いた', (f) => f.exc_moved === 1],
    ['レース全体で進入が動いた', (f) => f.exc_race_moved >= 1],
    ['レース全体で進入が枠なり', (f) => f.exc_race_moved === 0],
    ['展示ST1位', (f) => f.exst_rank === 1],
    ['展示ST2位以内', (f) => f.exst_rank <= 2],
    ['展示ST4位以下', (f) => f.exst_rank >= 4],
    ['チルトが0', (f) => f.tilt_now === 0],
    ['チルトが0でない', (f) => f.tilt_now != null && f.tilt_now !== 0],
    ['調整重量が重い', (f) => f.adj_rel != null && f.adj_rel > 0],
    ['調整重量が軽い', (f) => f.adj_rel != null && f.adj_rel < 0],
    ['部品交換あり', (f) => f.parts_self >= 1],
    ['部品交換なし', (f) => f.parts_self === 0],
    ['レース内で部品交換が多い', (f) => f.parts_race >= 2],
    ['気温と水温の差が大きい', (f) => f.temp_diff != null && Math.abs(f.temp_diff) >= 5],
  ]
  for (const kind of ['tansho', 'fukusho', 'kakuren']) {
    console.log(`\n══ ${NM[kind]}（モデルの本命1点）を展示情報で切る ══`)
    show('絞りなし', ev(kind, 1, null))
    const rows = []
    for (const [nm, fn] of FILTERS) {
      const r = ev(kind, 1, (a, c, rid) => { const f = of(a, rid); return f ? fn(f) : false })
      if (r) rows.push([nm, r])
    }
    rows.sort((x, y) => y[1].roi - x[1].roi)
    for (const [nm, r] of rows) show(nm, r)
  }
  console.log('\n★ = 回収100%超・最大1本抜いても100%超・月別が2ヶ月以内の負けに収まる')
  console.log('※ 展示は締切前に手に入る。オッズを使っていないので、この表は過去全部で成立する。')
  db.close(); process.exit(0)
}

if (argv.includes('--seg')) {
  // ---------- 条件で切る ----------
  const SEGS = [
    ['会場', (a, c) => c && c.jcd, [...Array(24)].map((_, i) => i + 1)],
    ['グレード', (a, c) => c && (c.grade ?? '一般'), null],
    ['風速', (a, c) => c && c.wind_speed == null ? null : Math.min(9, c.wind_speed), null],
    ['波高', (a, c) => c && c.wave == null ? null : Math.min(9, c.wave), null],
    ['レース番号', (a, c) => c && c.race_no, null],
    ['節の何日目', (a, c) => c && c.day_no, null],
    ['天候', (a, c) => c && c.weather, null],
  ]
  for (const kind of ['tansho', 'fukusho', 'kakuren']) {
    const pts = kind === 'kakuren' ? 1 : 1
    console.log(`\n══ ${NM[kind]}（モデルの本命${pts}点）を条件で切る ══`)
    const base = ev(kind, pts, null)
    show('絞りなし', base)
    for (const [nm, get] of SEGS) {
      const vals = new Set()
      for (const [rid] of R) { const v = get(null, COND.get(rid)); if (v != null) vals.add(v) }
      const rows = []
      for (const v of vals) {
        const r = ev(kind, pts, (a, c) => get(a, c) === v)
        if (r) rows.push([v, r])
      }
      rows.sort((x, y) => y[1].roi - x[1].roi)
      console.log(`\n  [${nm}] 上位3つ`)
      for (const [v, r] of rows.slice(0, 3)) show(`${nm}=${v}`, r)
    }
  }
  db.close(); process.exit(0)
}

// ---------- 券種ごとの基本形 ----------
console.log('  選び方                            本数  的中率  回収率  最大1本抜  月別  最悪月')
for (const kind of ['tansho', 'fukusho', 'kakuren', 'nirenpuku', 'nirentan']) {
  console.log(`\n【${NM[kind]}】`)
  for (const pts of [1, 2, 3]) show(`本命${pts}点`, ev(kind, pts, null))
  // 確率のしきい値（本命の確率が高いレースだけ）
  for (const t of [0.3, 0.5, 0.7, 0.9]) {
    const K = KIND[kind]
    show(`本命1点・本命の確率${t * 100}%以上`,
      ev(kind, 1, (a) => { const v = [...K.probe(a)].sort((x, y) => y[1] - x[1])[0]; return v && v[1] >= t }))
  }
  // 混戦を避ける／狙う
  const K = KIND[kind]
  const gap = (a) => { const s = [...K.probe(a)].sort((x, y) => y[1] - x[1]); return s.length > 1 ? s[0][1] - s[1][1] : 0 }
  show('本命1点・2番手と10pt差以上', ev(kind, 1, (a) => gap(a) >= 0.10))
  show('本命1点・2番手と20pt差以上', ev(kind, 1, (a) => gap(a) >= 0.20))
  show('本命1点・混戦のみ(差5pt未満)', ev(kind, 1, (a) => gap(a) < 0.05))
}
console.log('\n★ = 回収100%超・最大1本抜いても100%超・月別が2ヶ月以内の負けに収まる')
console.log('※ 払戻は確定の payouts。判定にオッズは一切使っていないので、この表は過去全部で成立する。')
db.close()
