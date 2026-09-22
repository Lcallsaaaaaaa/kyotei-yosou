// 決まり手の比率を出す。全期間・枠別・コース別・場別。
//
//   node --max-old-space-size=4096 scripts/kimarite.mjs
//
// ★なぜ要るか
//   モデルは逃げ91.0%・まくり差し9.3%しか当てられない（rankdiag.mjs）。
//   直す前に「そもそも決まり手はどう分布しているのか」を押さえる。
//   1着の枠が決まれば決まり手はほぼ決まる、という関係が使えるかを見る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const VN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }
const KS = ['逃げ', '差し', 'まくり', 'まくり差し', '抜き', '恵まれ']

// 1着艇の枠番・進入コース
const W = new Map()
for (const r of db.prepare(`SELECT race_id,lane,course FROM entries WHERE rank_num=1`).all())
  W.set(r.race_id, { lane: r.lane, course: r.course })
const rows = []
for (const r of db.prepare(`SELECT race_id,date,jcd,deadline,kimarite,wind_speed,wave FROM races
    WHERE kimarite IS NOT NULL AND kimarite <> ''`).all()) {
  const w = W.get(r.race_id); if (!w) continue
  const [h] = (r.deadline ?? '').split(':').map(Number)
  rows.push({ ...r, lane: w.lane, course: w.course, hour: Number.isFinite(h) ? h : null })
}
console.log(`決まり手のあるレース ${rows.length.toLocaleString()}（${rows[0]?.date} 〜 ${rows[rows.length - 1]?.date}）\n`)

const pc = (n, d) => d ? (n / d * 100).toFixed(1) : '0.0'
const line = (label, s, width = 16) => {
  const c = KS.map((k) => s.filter((x) => x.kimarite === k).length)
  const other = s.length - c.reduce((a, b) => a + b, 0)
  console.log(`${String(label).padEnd(width)} ${String(s.length).padStart(7)} ` +
    c.map((v) => (pc(v, s.length) + '%').padStart(7)).join('') + (other ? ('その他' + pc(other, s.length) + '%') : ''))
}
const head = (t, width = 16) => {
  console.log(`\n════ ${t} ════`)
  console.log(`${''.padEnd(width)} ${'本数'.padStart(6)} ` + KS.map((k) => k.padStart(7 - (k.length - 2))).join(''))
}

head('全体')
line('全レース', rows)

head('1着になった艇の枠番ごと')
for (let L = 1; L <= 6; L++) line(L + '号艇', rows.filter((x) => x.lane === L))

head('1着になった艇の進入コースごと')
for (let C = 1; C <= 6; C++) line(C + 'コース', rows.filter((x) => x.course === C))

head('風速')
for (const [lo, hi, lab] of [[0, 1, '0〜1m'], [2, 3, '2〜3m'], [4, 5, '4〜5m'], [6, 7, '6〜7m'], [8, 99, '8m以上']])
  line(lab, rows.filter((x) => (x.wind_speed ?? 0) >= lo && (x.wind_speed ?? 0) <= hi))

head('波高')
for (const [lo, hi, lab] of [[0, 0, '0cm'], [1, 2, '1〜2cm'], [3, 4, '3〜4cm'], [5, 7, '5〜7cm'], [8, 99, '8cm以上']])
  line(lab, rows.filter((x) => (x.wave ?? 0) >= lo && (x.wave ?? 0) <= hi))

head('締切の時刻（1時間ごと）')
for (let h = 8; h <= 23; h++) {
  const s = rows.filter((x) => x.hour === h)
  if (s.length >= 500) line(h + '時台', s)
}

head('場ごと（逃げ率の低い順＝荒れる場）', 12)
const byV = []
for (let j = 1; j <= 24; j++) {
  const s = rows.filter((x) => x.jcd === j)
  if (s.length < 1000) continue
  byV.push({ j, s, nige: s.filter((x) => x.kimarite === '逃げ').length / s.length })
}
byV.sort((a, b) => a.nige - b.nige)
for (const v of byV) line(VN[v.j] ?? v.j, v.s, 12)

console.log('\n════ 1着の枠番と決まり手の関係（この対応が使えるか）════')
for (let L = 1; L <= 6; L++) {
  const s = rows.filter((x) => x.lane === L)
  if (!s.length) continue
  const c = KS.map((k) => [k, s.filter((x) => x.kimarite === k).length]).sort((a, b) => b[1] - a[1])
  console.log(`  ${L}号艇が1着 → ` + c.slice(0, 3).map(([k, v]) => `${k}${pc(v, s.length)}%`).join(' / '))
}
db.close()
