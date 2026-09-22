// 指定日の番組表（programs）に対して、1年分の実績から全レースを一括採点する。
// SOP の STEP1〜4 のうち「過去実績で決まる部分」を朝のうちに全部潰すためのもの。
//
//   node scripts/scan.mjs 2026-08-18
//   node scripts/scan.mjs 2026-08-18 --jcd 12,15,18     場を絞る
//   node scripts/scan.mjs 2026-08-18 --top 15           表示件数
//
// 事前に当日の番組表を投入しておくこと:
//   node scripts/download.mjs <日付> <日付> --kind B && node scripts/extract.mjs && node scripts/build.mjs --since <日付>

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)

const JCD = {
  1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖',
  7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江',
  13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山',
  19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村',
}

const argv = process.argv.slice(2)
const date = argv[0]
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('日付を指定してください: node scripts/scan.mjs 2026-08-18')
  process.exit(1)
}
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const onlyJcd = flag('jcd') ? flag('jcd').split(',').map(Number) : null
const topN = Number(flag('top', 12))

const K = 25
const shrink = (hits, n, prior) => (hits + K * prior) / (n + K)

/**
 * 1着率の較正（2026/08/18 バックテスト27,820レースの実測から導出）
 * 縮小推定が効きすぎて予測が中央に寄っていた（予測37.3%→実際26.5%／予測72.2%→実際78.1%）。
 * 実測5帯を線形回帰して引き伸ばす。EV計算の土台なので必須。
 */
const calibrate = (p) => Math.max(0.02, Math.min(0.97, 1.478 * p - 0.286))
const pf = (v) => (v * 100).toFixed(1) + '%'

// ---- 1) 「1コース艇が1着だったレース」を実体化（全場・全期間）
db.exec('DROP TABLE IF EXISTS temp.won1n')
db.exec(`CREATE TEMP TABLE won1n AS
  SELECT race_id FROM entries WHERE course=1 AND rank_num=1`)
db.exec('CREATE INDEX temp.idx_won1n ON won1n(race_id)')

// ---- 2) 場ごとのベースレート
const venue = {}
for (const r of all(`SELECT r.jcd, COUNT(*) n, SUM(e.rank_num=1) w
  FROM entries e JOIN races r ON r.race_id=e.race_id WHERE e.course=1 GROUP BY r.jcd`)) {
  venue[r.jcd] = { in1: r.w / r.n, ng2: {}, ng3: {} }
}
for (const r of all(`SELECT r.jcd, e.course c, COUNT(*) n, SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
  FROM entries e JOIN won1n w ON w.race_id=e.race_id JOIN races r ON r.race_id=e.race_id
  WHERE e.course BETWEEN 2 AND 6 GROUP BY r.jcd, e.course`)) {
  venue[r.jcd].ng2[r.c] = r.s2 / r.n
  venue[r.jcd].ng3[r.c] = r.s3 / r.n
}

// ---- 3) 選手ごとの実績（全場）
const racerIn1 = new Map() // racer_id -> {n,w}
for (const r of all(`SELECT racer_id, COUNT(*) n, SUM(rank_num=1) w
  FROM entries WHERE course=1 AND racer_id IS NOT NULL GROUP BY racer_id`)) {
  racerIn1.set(r.racer_id, { n: r.n, w: r.w })
}
const racerNg = new Map() // `${racer_id}:${course}` -> {n,s2,s3}
for (const r of all(`SELECT e.racer_id, e.course c, COUNT(*) n, SUM(e.rank_num=2) s2, SUM(e.rank_num=3) s3
  FROM entries e JOIN won1n w ON w.race_id=e.race_id
  WHERE e.course BETWEEN 2 AND 6 AND e.racer_id IS NOT NULL GROUP BY e.racer_id, e.course`)) {
  racerNg.set(`${r.racer_id}:${r.c}`, { n: r.n, s2: r.s2, s3: r.s3 })
}

// ---- 4) 当日の番組表
const prefix = date.replace(/-/g, '') + '-%'
const progs = all(`SELECT race_id, lane, racer_id, racer_name, grade, motor_top2
  FROM programs WHERE race_id LIKE ? ORDER BY race_id, lane`, prefix)
if (!progs.length) {
  console.error(`${date} の番組表が programs に入っていません。download → extract → build --since ${date} を先に実行してください。`)
  process.exit(1)
}
const byRace = new Map()
for (const p of progs) {
  if (!byRace.has(p.race_id)) byRace.set(p.race_id, [])
  byRace.get(p.race_id).push(p)
}

// ---- 5) 採点
const rows = []
for (const [race_id, lanes] of byRace) {
  if (lanes.length !== 6) continue
  const [, jcdStr, rnoStr] = race_id.split('-')
  const jcd = Number(jcdStr)
  if (onlyJcd && !onlyJcd.includes(jcd)) continue
  const v = venue[jcd]
  if (!v) continue

  const r1 = racerIn1.get(lanes[0].racer_id) ?? { n: 0, w: 0 }
  const pIn = calibrate(shrink(r1.w, r1.n, v.in1))

  const est = []
  for (let c = 2; c <= 6; c++) {
    const t = lanes[c - 1].racer_id
    const g = racerNg.get(`${t}:${c}`) ?? { n: 0, s2: 0, s3: 0 }
    est.push({
      c,
      p2: shrink(g.s2, g.n, v.ng2[c] ?? 0),
      p3: shrink(g.s3, g.n, v.ng3[c] ?? 0),
    })
  }
  const sum2 = est.reduce((a, b) => a + b.p2, 0)
  for (const e of est) e.deme = pIn * (e.p2 / sum2)

  // 3連単の推定確率
  const combos = []
  for (const a of est) {
    const rest = est.filter((x) => x.c !== a.c)
    const s3 = rest.reduce((t, x) => t + x.p3, 0)
    for (const b of rest) combos.push({ combo: `1-${a.c}-${b.c}`, p: a.deme * (b.p3 / s3) })
  }
  combos.sort((x, y) => y.p - x.p)

  const a1 = lanes.filter((l) => l.grade === 'A1').length
  rows.push({
    race_id, jcd, rno: Number(rnoStr),
    name: lanes[0].racer_name, grade: lanes[0].grade,
    motor: lanes[0].motor_top2,
    pIn,
    demeTop: Math.max(...est.map((e) => e.deme)),
    deme: est.map((e) => e.deme),
    top6: combos.slice(0, 6),
    cover6: combos.slice(0, 6).reduce((a, b) => a + b.p, 0),
    a1,
  })
}

// ---- 6) 出力
console.log(`=== ${date} 全${rows.length}レース 採点（1年分の実績ベース）===\n`)

console.log('■ 窓A候補：1号艇の信頼度が高い順')
console.log('場      R  1号艇        級 M2率 │1着率 │出目トップ│上位6点で 拾える確率│警告')
const byIn = [...rows].sort((a, b) => b.pIn - a.pIn)
for (const r of byIn.slice(0, topN)) {
  // 「堅すぎ＝オッズが付かない」の警告（検証ログ 2026/08/17 のルール）
  const warn = r.pIn > 0.75 && r.demeTop > 0.35 ? '★人気集中でEVが立たない恐れ' : ''
  console.log(
    `${JCD[r.jcd].padEnd(4, '　')}${String(r.rno).padStart(3)}R ${r.name.padEnd(8, '　')} ${(r.grade ?? '').padEnd(2)} ` +
    `${String(r.motor ?? '').padStart(5)} │${pf(r.pIn).padStart(6)}│${pf(r.demeTop).padStart(7)}  │` +
    `${pf(r.cover6).padStart(9)}      │${warn}`
  )
}

console.log('\n■ 窓B候補：1号艇の信頼度が低い順（穴・記録のみ）')
console.log('場      R  1号艇        級 M2率 │1着率 │A1人数')
for (const r of [...rows].sort((a, b) => a.pIn - b.pIn).slice(0, 8)) {
  console.log(
    `${JCD[r.jcd].padEnd(4, '　')}${String(r.rno).padStart(3)}R ${r.name.padEnd(8, '　')} ${(r.grade ?? '').padEnd(2)} ` +
    `${String(r.motor ?? '').padStart(5)} │${pf(r.pIn).padStart(6)}│ ${r.a1}人`
  )
}

console.log('\n■ 妙味の観点：1着率は高いが出目が割れている（＝軸は堅いのに配当が散る）')
console.log('場      R  1号艇        │1着率 │出目トップ│上位6点 │推奨3点')
const value = rows
  .filter((r) => r.pIn >= 0.60 && r.demeTop <= 0.30)
  .sort((a, b) => b.pIn - a.pIn)
for (const r of value.slice(0, topN)) {
  console.log(
    `${JCD[r.jcd].padEnd(4, '　')}${String(r.rno).padStart(3)}R ${r.name.padEnd(8, '　')} │${pf(r.pIn).padStart(6)}│` +
    `${pf(r.demeTop).padStart(7)}  │${pf(r.cover6).padStart(7)} │ ` +
    r.top6.slice(0, 3).map((c) => `${c.combo}(${pf(c.p)})`).join(' ')
  )
}
console.log(`\n  該当 ${value.length}レース`)
console.log('\n※ これは過去実績のみ。展示・ST展示・風・当日の水面傾向は一切入っていない。')
console.log('※ 進入は枠なり前提。オッズ未反映なのでEV判定はまだできない。')
db.close()
