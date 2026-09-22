// 蓄積データから予想に直結する確率を出す。
//
//   node scripts/stats.mjs course --jcd 19              場のコース別入着率・決まり手・枠なり率
//   node scripts/stats.mjs deme  --jcd 19               場の「1-X」出目確率（逃げ逃し）
//   node scripts/stats.mjs racer 4179 [--jcd 19]        選手のコース別成績・逃がし2/3着率
//   node scripts/stats.mjs race  --jcd 19 --lanes 4179,5067,...   6人指定でレースの出目確率
//
// 共通オプション: --since 2026-02-01  --until 2026-08-17

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (sql, ...p) => db.prepare(sql).all(...p)
const one = (sql, ...p) => db.prepare(sql).get(...p)

const JCD = {
  1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖',
  7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江',
  13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山',
  19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村',
}

// --- 引数 --------------------------------------------------------------
const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i > -1 ? argv[i + 1] : def
}
const jcd = flag('jcd') ? Number(flag('jcd')) : null
const since = flag('since')
const until = flag('until')

/** races への絞り込み条件と、そのバインド値 */
function scope(alias = 'r') {
  const w = []
  const p = []
  if (jcd) { w.push(`${alias}.jcd = ?`); p.push(jcd) }
  if (since) { w.push(`${alias}.date >= ?`); p.push(since) }
  if (until) { w.push(`${alias}.date <= ?`); p.push(until) }
  return { sql: w.length ? 'AND ' + w.join(' AND ') : '', params: p }
}

const pct = (n, d) => (d ? (n / d) * 100 : null)
const fmt = (v, w = 6) => (v === null ? '   -  ' : (v.toFixed(1) + '%').padStart(w))
const label = () =>
  `${jcd ? JCD[jcd] + `(${jcd})` : '全場'}  ${since ?? '最古'}〜${until ?? '最新'}`

/**
 * 小標本を場の平均に引き寄せる（縮小推定）。
 * n が小さいうちは場の平均、増えるほど本人の実績を信じる。
 * これをやらないと「3走2勝＝66.7%」のようなノイズをそのまま買い目にしてしまう。
 */
const K_SHRINK = 25
const shrink = (hits, n, prior) => (hits + K_SHRINK * prior) / (n + K_SHRINK)

/**
 * 1着率の較正（2026/08/18 バックテスト27,820レースの実測から導出）
 * 縮小推定が効きすぎて予測が中央に寄っていた：
 *   予測37.3% → 実際26.5%（-10.8pt・自信過剰）
 *   予測72.2% → 実際78.1%（+5.9pt・過小評価）
 * 実測5帯を線形回帰して引き伸ばす。EV計算の土台なので必須。
 */
const calibrate = (p) => Math.max(0.02, Math.min(0.97, 1.478 * p - 0.286))

// --- course ------------------------------------------------------------
function cmdCourse() {
  const s = scope()
  console.log(`=== コース別入着率  ${label()} ===\n`)
  const rows = all(`
    SELECT e.course c, COUNT(*) n,
      SUM(e.rank_num=1) w1, SUM(e.rank_num=2) w2, SUM(e.rank_num=3) w3
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course IS NOT NULL ${s.sql}
    GROUP BY e.course ORDER BY e.course`, ...s.params)

  console.log('コース   出走     1着     2着     3着    3連対')
  for (const r of rows) {
    const top3 = pct(r.w1 + r.w2 + r.w3, r.n)
    console.log(`  ${r.c}    ${String(r.n).padStart(6)}  ${fmt(pct(r.w1, r.n))}  ${fmt(pct(r.w2, r.n))}  ${fmt(pct(r.w3, r.n))}  ${fmt(top3)}`)
  }

  console.log(`\n=== 決まり手 ===`)
  const k = all(`SELECT r.kimarite k, COUNT(*) n FROM races r
    WHERE r.kimarite IS NOT NULL ${s.sql} GROUP BY r.kimarite ORDER BY n DESC`, ...s.params)
  const kt = k.reduce((a, b) => a + b.n, 0)
  for (const r of k) console.log(`  ${r.k.padEnd(12, '　')} ${String(r.n).padStart(6)}  ${fmt(pct(r.n, kt))}`)

  // 枠なり進入率：6艇すべて 艇番=進入コース だったレースの割合
  const wk = one(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN mismatch=0 THEN 1 ELSE 0 END) waku
    FROM (
      SELECT e.race_id, SUM(CASE WHEN e.lane<>e.course THEN 1 ELSE 0 END) mismatch
      FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE e.course IS NOT NULL ${s.sql}
      GROUP BY e.race_id
    )`, ...s.params)
  console.log(`\n=== 枠なり進入率 ===`)
  console.log(`  ${wk.waku}/${wk.total} = ${fmt(pct(wk.waku, wk.total))}`)
  console.log(`  ※ 予想時は進入が未確定。この率が低い場ほど「枠＝コース」の前提が崩れる`)
}

// --- deme --------------------------------------------------------------

/** 期間だけ効かせ、場の絞りは外したスコープ（選手実績を全場から取るため） */
function scopeNationwide(alias = 'r') {
  const w = []
  const p = []
  if (since) { w.push(`${alias}.date >= ?`); p.push(since) }
  if (until) { w.push(`${alias}.date <= ?`); p.push(until) }
  return { sql: w.length ? 'AND ' + w.join(' AND ') : '', params: p }
}

/**
 * 「1コース艇が1着だったレース」の race_id を一時テーブルに実体化する。
 * CTE のままだと選手ごとに 32万行を再スキャンしてしまい、6艇ぶんで数分かかる。
 * name='won1'（当地・ベースレート用）と 'won1n'（全場・選手実績用）を作り分ける。
 */
const won1Ready = new Set()
function materializeWon1(name = 'won1') {
  if (won1Ready.has(name)) return
  const s = name === 'won1' ? scope() : scopeNationwide()
  db.exec(`DROP TABLE IF EXISTS temp.${name}`)
  db.prepare(`CREATE TEMP TABLE ${name} AS
    SELECT e.race_id AS race_id FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=1 AND e.rank_num=1 ${s.sql}`).run(...s.params)
  db.exec(`CREATE INDEX temp.idx_${name} ON ${name}(race_id)`)
  won1Ready.add(name)
}

/** 1コースが1着だったレースに限定した、各コースの2着/3着率 */
function nigashiRates() {
  materializeWon1()
  const rows = all(`
    SELECT e.course c, COUNT(*) n,
      SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
    FROM entries e JOIN won1 w ON w.race_id=e.race_id
    WHERE e.course BETWEEN 2 AND 6
    GROUP BY e.course ORDER BY e.course`)
  const map = {}
  for (const r of rows) map[r.c] = { n: r.n, p2: r.s2 / r.n, p3: r.s3 / r.n }
  return map
}

function inWinRate() {
  const s = scope()
  const r = one(`
    SELECT COUNT(*) n, SUM(e.rank_num=1) w
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=1 ${s.sql}`, ...s.params)
  return { n: r.n, p: r.n ? r.w / r.n : 0 }
}

function cmdDeme() {
  const inw = inWinRate()
  const ng = nigashiRates()
  console.log(`=== 逃げ逃し出目確率  ${label()} ===\n`)
  console.log(`1コース1着率: ${fmt(inw.p * 100)}  (${inw.n}走)\n`)
  console.log('出目     確率    内訳（1着率 × 逃がし2着率）')
  for (let c = 2; c <= 6; c++) {
    const g = ng[c]
    if (!g) continue
    console.log(`  1-${c}  ${fmt(inw.p * g.p2 * 100, 7)}    ${fmt(inw.p * 100)} × ${fmt(g.p2 * 100)}  (n=${g.n})`)
  }
  console.log('\n逃がし3着率')
  for (let c = 2; c <= 6; c++) if (ng[c]) console.log(`  ${c}コース ${fmt(ng[c].p3 * 100)}`)
}

// --- racer -------------------------------------------------------------
function cmdRacer() {
  const toban = Number(argv[1])
  if (!toban) { console.error('登番を指定してください: node scripts/stats.mjs racer 4179'); process.exit(1) }
  const s = scope()

  const name = one(`SELECT racer_name FROM entries WHERE racer_id=? LIMIT 1`, toban)
  console.log(`=== ${toban} ${name?.racer_name ?? '(不明)'}  ${label()} ===\n`)

  console.log('コース別成績')
  console.log('コース   出走     1着     2連対   3連対   平均ST')
  for (const r of all(`
    SELECT e.course c, COUNT(*) n,
      SUM(e.rank_num=1) w1, SUM(e.rank_num<=2) w2, SUM(e.rank_num<=3) w3,
      AVG(CASE WHEN e.st_flag IS NULL THEN e.st END) ast
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.racer_id=? AND e.course IS NOT NULL ${s.sql}
    GROUP BY e.course ORDER BY e.course`, toban, ...s.params)) {
    const st = r.ast === null ? '  -  ' : r.ast.toFixed(2)
    console.log(`  ${r.c}    ${String(r.n).padStart(6)}  ${fmt(pct(r.w1, r.n))}  ${fmt(pct(r.w2, r.n))}  ${fmt(pct(r.w3, r.n))}   ${st}`)
  }

  console.log('\n1コース時の決まり手（この選手が1コースで1着になった時）')
  for (const r of all(`
    SELECT r.kimarite k, COUNT(*) n FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.racer_id=? AND e.course=1 AND e.rank_num=1 ${s.sql}
    GROUP BY r.kimarite ORDER BY n DESC`, toban, ...s.params)) {
    console.log(`  ${(r.k ?? '不明').padEnd(12, '　')} ${r.n}`)
  }

  console.log('\n★逃がし2着率・3着率（1コース艇が1着だったレースで、この選手が2/3着に入った率）')
  console.log('コース   該当     2着     3着')
  materializeWon1()
  for (const r of all(`
    SELECT e.course c, COUNT(*) n, SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
    FROM entries e JOIN won1 w ON w.race_id=e.race_id
    WHERE e.racer_id=? AND e.course BETWEEN 2 AND 6
    GROUP BY e.course ORDER BY e.course`, toban)) {
    console.log(`  ${r.c}    ${String(r.n).padStart(6)}  ${fmt(pct(r.s2, r.n))}  ${fmt(pct(r.s3, r.n))}`)
  }
}

// --- race --------------------------------------------------------------
function cmdRace() {
  const lanes = (flag('lanes') ?? '').split(',').map((v) => Number(v.trim())).filter(Boolean)
  if (lanes.length !== 6) {
    console.error('--lanes に1号艇から順に登番6つを指定してください（カンマ区切り）')
    process.exit(1)
  }
  // ベースレート＝当地。選手実績＝全場。
  // 場で絞ると1選手あたり数走しか残らず、縮小推定の意味が無くなるため。
  const nat = scopeNationwide()
  const venueIn = inWinRate()
  const venueNg = nigashiRates()
  materializeWon1('won1n')

  // 1号艇の1コース1着率（全場の本人実績を、当地の平均へ縮小）
  const r1 = one(`
    SELECT COUNT(*) n, SUM(e.rank_num=1) w
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.racer_id=? AND e.course=1 ${nat.sql}`, lanes[0], ...nat.params)
  const pIn = calibrate(shrink(r1.w ?? 0, r1.n ?? 0, venueIn.p))

  console.log(`=== レース出目確率  ${label()} ===`)
  console.log(`ベースレート＝当地 / 選手実績＝全場（期間は共通）\n`)
  console.log(`1号艇 ${lanes[0]}  1コース ${r1.n}走 ${r1.w}勝 (全場実測${fmt(pct(r1.w, r1.n))}) → 補正 ${fmt(pIn * 100)}`)
  console.log(`  ※ 当地平均 ${fmt(venueIn.p * 100)} へ n=${K_SHRINK} で縮小\n`)

  // 各艇の逃がし2着率・3着率を縮小推定し、合計1になるよう正規化
  const est = []
  for (let c = 2; c <= 6; c++) {
    const toban = lanes[c - 1]
    const v = venueNg[c] ?? { p2: 0, p3: 0 }
    const r = one(`
      SELECT COUNT(*) n, SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
      FROM entries e JOIN won1n w ON w.race_id=e.race_id
      WHERE e.racer_id=? AND e.course=?`, toban, c)
    est.push({
      course: c, toban, n: r.n ?? 0, raw2: r.n ? r.s2 / r.n : null,
      p2: shrink(r.s2 ?? 0, r.n ?? 0, v.p2),
      p3: shrink(r.s3 ?? 0, r.n ?? 0, v.p3),
    })
  }
  const sum2 = est.reduce((a, b) => a + b.p2, 0)
  for (const e of est) e.n2 = e.p2 / sum2

  console.log('逃がし2着率（縮小後・正規化）')
  console.log('コース 登番    該当   実測2着   補正   正規化   出目1-X確率')
  for (const e of est) {
    console.log(`  ${e.course}   ${e.toban}  ${String(e.n).padStart(5)}  ${fmt(e.raw2 === null ? null : e.raw2 * 100)}  ${fmt(e.p2 * 100)}  ${fmt(e.n2 * 100)}   ${fmt(pIn * e.n2 * 100, 7)}`)
  }

  // 3連単の推定確率（2着が決まった前提で3着を残り艇に正規化）
  const combos = []
  for (const a of est) {
    const rest = est.filter((x) => x.course !== a.course)
    const s3 = rest.reduce((t, x) => t + x.p3, 0)
    for (const b of rest) {
      combos.push({ combo: `1-${a.course}-${b.course}`, p: pIn * a.n2 * (b.p3 / s3) })
    }
  }
  combos.sort((x, y) => y.p - x.p)
  console.log('\n★3連単 推定確率（上位12点）')
  console.log('  出目      確率     必要オッズ(EV=1.0)')
  for (const c of combos.slice(0, 12)) {
    console.log(`  ${c.combo}  ${fmt(c.p * 100, 7)}      ${(1 / c.p).toFixed(1)}倍`)
  }
  console.log('\n  ※「必要オッズ」を下回る出目は期待値マイナス。直前オッズと突き合わせて判断する。')
  console.log('  ※ この推定は枠なり進入を前提にしている。前づけがあれば無効。')
}

// --- 実行 --------------------------------------------------------------
const table = { course: cmdCourse, deme: cmdDeme, racer: cmdRacer, race: cmdRace }
if (!table[cmd]) {
  console.log(`使い方:
  node scripts/stats.mjs course --jcd 19 [--since 2026-02-01]
  node scripts/stats.mjs deme   --jcd 19
  node scripts/stats.mjs racer  4179 [--jcd 19]
  node scripts/stats.mjs race   --jcd 19 --lanes 登番1,登番2,登番3,登番4,登番5,登番6`)
  process.exit(1)
}
table[cmd]()
db.close()
