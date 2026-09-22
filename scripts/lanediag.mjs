// 外枠を本命にしたとき、モデルは何を読み違えているのかを診る。
//
//   node --max-old-space-size=8192 scripts/lanediag.mjs
//
// ★分かっていること（lanecal.mjs）
//   モデルが3〜5号艇を本命にしたとき、予測より5〜9pt低い確率でしか当たらない。
//   1号艇を本命にしたときは0.9ptしかずれない。外枠だけが壊れている。
//
// ★何を診るか
//   外枠を本命にしたレースで、実際に勝ったのは誰か。
//   もし **1号艇が予測より多く勝っている** なら、モデルは
//   「1号艇が弱いから外枠が来る」と読みすぎている＝内枠の有利さを削りすぎている。
//   それが「レースの特性を読めていない」の中身になる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))

const byRace = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p,y FROM wk1`).all()) {
  let a = byRace.get(r.race_id); if (!a) { a = []; byRace.set(r.race_id, a) }
  a.push(r)
}
// 番組表（1号艇の力量）
const PG = new Map()
for (const r of db.prepare(`SELECT race_id,lane,grade,win_rate_nat,motor_top2 FROM programs`).all())
  PG.set(r.race_id + '|' + r.lane, r)
// 実際の進入
const EN = new Map()
for (const r of db.prepare(`SELECT race_id,lane,course FROM entries`).all())
  EN.set(r.race_id + '|' + r.lane, r.course)
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,jcd,wind_speed,wave FROM races`).all()) RC.set(r.race_id, r)

const races = []
for (const [rid, a] of byRace) {
  if (a.length !== 6) continue
  const fav = a.reduce((m, x) => (x.p > m.p ? x : m))
  const win = a.find((x) => x.y === 1)
  races.push({ rid, a, fav, win: win?.lane ?? null })
}
console.log(`対象 ${races.length.toLocaleString()}レース\n`)

const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '-'

console.log('════ ① 外枠を本命にしたレースで、実際に勝ったのは誰か ════')
console.log('本命    レース数   1着になった艇の内訳（実際）           本命の的中')
for (const L of [1, 2, 3, 4, 5]) {
  const s = races.filter((x) => x.fav.lane === L && x.win != null)
  if (s.length < 50) continue
  const dist = [1, 2, 3, 4, 5, 6].map((k) => s.filter((x) => x.win === k).length)
  console.log(`${L}号艇 ${String(s.length).padStart(9)}   ${dist.map((d, i) => `${i + 1}:${pct(d, s.length).padStart(6)}`).join(' ')}   ${pct(dist[L - 1], s.length)}`)
}

console.log('\n════ ② 外枠本命のとき、モデルは1号艇をどう見ていたか ════')
console.log('本命    レース数   1号艇の予測   1号艇の実際   差')
for (const L of [2, 3, 4, 5]) {
  const s = races.filter((x) => x.fav.lane === L && x.win != null)
  if (s.length < 50) continue
  const p1 = s.reduce((a, x) => a + x.a.find((y) => y.lane === 1).p, 0) / s.length
  const y1 = s.filter((x) => x.win === 1).length / s.length
  const d = (p1 - y1) * 100
  console.log(`${L}号艇 ${String(s.length).padStart(9)} ${(p1 * 100).toFixed(1).padStart(11)}% ${(y1 * 100).toFixed(1).padStart(11)}% ${d.toFixed(1).padStart(7)}pt${d < -2 ? '  ★1号艇を過小評価' : ''}`)
}

console.log('\n════ ③ 進入は枠なりだったか（外枠本命のレース）════')
console.log('本命    枠なり率   進入が動いたとき本命の的中   枠なりのとき本命の的中')
for (const L of [1, 3, 4, 5]) {
  const s = races.filter((x) => x.fav.lane === L && x.win != null && EN.has(x.rid + '|' + L))
  if (s.length < 50) continue
  const straight = s.filter((x) => EN.get(x.rid + '|' + L) === L)
  const moved = s.filter((x) => EN.get(x.rid + '|' + L) !== L)
  console.log(`${L}号艇 ${pct(straight.length, s.length).padStart(9)} ${pct(moved.filter((x) => x.win === L).length, moved.length).padStart(24)} ${pct(straight.filter((x) => x.win === L).length, straight.length).padStart(22)}`)
}

console.log('\n════ ④ 1号艇の力量別：外枠本命はどこで外れるか ════')
console.log('1号艇の全国勝率   外枠本命のレース数   本命の予測   本命の実際   差')
for (const [lo, hi, lab] of [[0, 4.5, '4.5未満'], [4.5, 5.5, '4.5〜5.5'], [5.5, 6.5, '5.5〜6.5'], [6.5, 99, '6.5以上']]) {
  const s = races.filter((x) => {
    if (x.fav.lane === 1 || x.win == null) return false
    const w = PG.get(x.rid + '|1')?.win_rate_nat
    return w != null && w >= lo && w < hi
  })
  if (s.length < 100) continue
  const ap = s.reduce((a, x) => a + x.fav.p, 0) / s.length
  const ay = s.filter((x) => x.win === x.fav.lane).length / s.length
  console.log(`  ${lab.padEnd(12)} ${String(s.length).padStart(12)} ${(ap * 100).toFixed(1).padStart(12)}% ${(ay * 100).toFixed(1).padStart(11)}% ${((ap - ay) * 100).toFixed(1).padStart(7)}pt`)
}

console.log('\n════ ⑤ 場ごと：外枠本命の当たり外れ ════')
const VN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }
const out = []
for (let j = 1; j <= 24; j++) {
  const s = races.filter((x) => x.fav.lane >= 3 && x.win != null && RC.get(x.rid)?.jcd === j)
  if (s.length < 60) continue
  const ap = s.reduce((a, x) => a + x.fav.p, 0) / s.length
  const ay = s.filter((x) => x.win === x.fav.lane).length / s.length
  out.push({ j, n: s.length, d: (ap - ay) * 100, ap, ay })
}
out.sort((a, b) => b.d - a.d)
console.log('場         レース数   予測    実際     差（大きいほど外す）')
for (const x of out.slice(0, 5))
  console.log(`  ${(VN[x.j] ?? x.j).padEnd(6)} ${String(x.n).padStart(8)} ${(x.ap * 100).toFixed(1).padStart(7)}% ${(x.ay * 100).toFixed(1).padStart(7)}% ${x.d.toFixed(1).padStart(7)}pt`)
console.log('  …')
for (const x of out.slice(-3))
  console.log(`  ${(VN[x.j] ?? x.j).padEnd(6)} ${String(x.n).padStart(8)} ${(x.ap * 100).toFixed(1).padStart(7)}% ${(x.ay * 100).toFixed(1).padStart(7)}% ${x.d.toFixed(1).padStart(7)}pt`)
db.close()
