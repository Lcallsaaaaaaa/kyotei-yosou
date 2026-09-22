// odds_live の記録がどれだけ信用できるかを調べる。
//   node --max-old-space-size=8192 scripts/odds-live-audit.mjs
//
// ★なぜ要るか
//   「締切前オッズで判定すると回収83.4%」という結論を出した。だがその元になる
//   odds_live 自体に欠陥の疑いがある：
//     ・1号艇がちょうど1.0倍になる率 30.4%（確定オッズでは12.0%）
//     ・締切3分以内でも12%のスナップショットで2艇以上が同値
//     ・びわこ1R(8/31)は締切0分前に 1 / 101.2 / 5 / 12.6 / 20.2 / 25.3 と記録したが
//       確定は 1.8 / 9.4 / 4.5 / 3.0 / 12.3 / 18.0（払戻940円と一致）
//   締切時刻は正しかった（10:40締切・10:40:15取得）。つまり
//   **取得したページの中身が実際のオッズと違っていた**疑いが残る。
//
// ★切り分け
//   スナップショットを「健全」と「壊れている」に分けて、確定オッズとの一致率を比べる。
//     健全 = 6艇そろう ＆ Σ(1/オッズ) が 1.30〜1.42 ＆ 同値の艇なし ＆ 1.0倍ちょうどなし
//   健全なものが確定とよく一致するなら、読み取りを直せば検証は続けられる。
//   健全でも一致しないなら、締切前オッズは本当に当てにならない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const FIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho > 0`).iterate())
  FIN.set(r.race_id + '|' + r.lane, r.tansho)

// スナップショット単位にまとめる
const SNAP = new Map()
for (const r of db.prepare(`SELECT race_id, lane, mins_before, tansho FROM odds_live
    WHERE tansho > 0 ORDER BY race_id, mins_before DESC, lane`).iterate()) {
  const k = r.race_id + '|' + r.mins_before
  let a = SNAP.get(k); if (!a) { a = { id: r.race_id, mb: r.mins_before, o: new Map() }; SNAP.set(k, a) }
  a.o.set(r.lane, r.tansho)
}
console.log(`スナップショット ${SNAP.size.toLocaleString()}件\n`)

function health(s) {
  if (s.o.size !== 6) return '6艇そろわない'
  const v = [...s.o.values()]
  const sum = v.reduce((a, b) => a + 1 / b, 0)
  if (new Set(v).size < 6) return '同値の艇がある'
  if (v.some((x) => x === 1)) return 'ちょうど1.0倍がある'
  if (sum < 1.30 || sum > 1.42) return `控除率が変(${sum.toFixed(2)})`
  return 'ok'
}
const byH = new Map()
for (const s of SNAP.values()) {
  const h = health(s)
  let a = byH.get(h); if (!a) { a = []; byH.set(h, a) } a.push(s)
}
console.log('【スナップショットの内訳】')
for (const [h, a] of [...byH].sort((x, y) => y[1].length - x[1].length))
  console.log(`  ${h.padEnd(20)} ${String(a.length).padStart(6)}件 (${(a.length / SNAP.size * 100).toFixed(1)}%)`)

// 確定オッズとの一致
function accuracy(list) {
  let n = 0, near15 = 0, near30 = 0
  const rr = []
  for (const s of list) for (const [lane, o] of s.o) {
    const f = FIN.get(s.id + '|' + lane); if (!(f > 0)) continue
    n++; rr.push(f / o)
    if (Math.abs(f - o) / f < 0.15) near15++
    if (Math.abs(f - o) / f < 0.30) near30++
  }
  if (!n) return null
  rr.sort((a, b) => a - b)
  return { n, near15: near15 / n * 100, near30: near30 / n * 100, md: rr[Math.floor(rr.length / 2)] }
}
console.log('\n【確定オッズとどれだけ合うか（締切3分以内のスナップショット）】')
console.log('  区分                   艇数   ±15%以内  ±30%以内  確定÷締切前の中央値')
for (const [h, a] of [...byH].sort((x, y) => y[1].length - x[1].length)) {
  const near = a.filter((s) => s.mb <= 3)
  const r = accuracy(near); if (!r || r.n < 100) continue
  console.log(`  ${h.padEnd(20)} ${String(r.n).padStart(6)} ${r.near15.toFixed(1).padStart(9)}% ${r.near30.toFixed(1).padStart(8)}% ${r.md.toFixed(3).padStart(14)}`)
}
console.log('\n【健全なものだけ・締切までの残り時間ごと】')
console.log('  残り        艇数   ±15%以内  ±30%以内  確定÷締切前の中央値')
const ok = byH.get('ok') ?? []
for (const [lo, hi, nm] of [[0, 1, '0〜1分'], [2, 3, '2〜3分'], [4, 6, '4〜6分'], [7, 12, '7〜12分'], [13, 21, '13〜21分']]) {
  const r = accuracy(ok.filter((s) => s.mb >= lo && s.mb <= hi)); if (!r || r.n < 50) continue
  console.log(`  ${nm.padEnd(8)} ${String(r.n).padStart(7)} ${r.near15.toFixed(1).padStart(9)}% ${r.near30.toFixed(1).padStart(8)}% ${r.md.toFixed(3).padStart(14)}`)
}
db.close()
