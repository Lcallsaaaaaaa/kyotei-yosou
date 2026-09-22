// 3連単1点で、どのレースを買えば回収率が上がるか総当たりで探す。
//   node --max-old-space-size=8192 scripts/pick3.mjs
//
// ★守ること
//   ・使う条件は締切前に分かるものだけ（オッズは締切前に見える）
//   ・月ごとに10ヶ月すべて見る。全体が良くても月がばらつくものは採らない
//   ・買い目が少なすぎるものは採らない（偶然と区別できない）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
  a[r.rank_num] = r.lane
}
const M = new Map()
for (const r of db.prepare(`SELECT race_id, jcd, grade, deadline, wind_speed, wave, race_no, day_no FROM races WHERE date>='2025-10-01'`).all())
  M.set(r.race_id, r)
const RF = new Map()
for (const r of db.prepare(`SELECT race_id, rc_a1, rc_entry_risk, vh_nige, exc_race_moved FROM rfeat WHERE lane=1`).iterate())
  RF.set(r.race_id, r)
const P1 = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, month FROM wi1`).iterate()) {
  let a = P1.get(r.race_id); if (!a) { a = { mo: r.month, l: [] }; P1.set(r.race_id, a) }
  a.l.push(r)
}
for (const [, a] of P1) a.l.sort((x, y) => y.p - x.p)
const P3 = new Map()
for (const r of db.prepare(`SELECT race_id, combo, p FROM wi3`).iterate()) {
  let a = P3.get(r.race_id); if (!a) { a = new Map(); P3.set(r.race_id, a) }
  a.set(r.combo, r.p)
}
const races = []
{
  let cur = null, list = []
  const flush = () => {
    if (cur && list.length > 100) {
      const p = P3.get(cur), t = P1.get(cur), w = WIN.get(cur), m = M.get(cur), rf = RF.get(cur)
      if (p && t && m && w && w[1] && w[2] && w[3]) {
        const l = list.map((x) => ({ c: x.combo, o: x.odds, p: p.get(x.combo) ?? 0 })).filter((x) => x.p > 0)
        l.sort((a, b) => b.p - a.p)
        const top = l[0]
        if (top) races.push({ rid: cur, mo: t.mo, truth: `${w[1]}-${w[2]}-${w[3]}`,
          top, p1: t.l[0].p, lane: t.l[0].lane, margin: top.o * top.p, m, rf })
      }
    }
    list = []
  }
  for (const r of db.prepare(`SELECT race_id, combo, odds FROM odds3t WHERE odds IS NOT NULL ORDER BY race_id`).iterate()) {
    if (r.race_id !== cur) { flush(); cur = r.race_id }
    list.push(r)
  }
  flush()
}
const N = races.length
const MOS = [...new Set(races.map((r) => r.mo))].filter(Boolean).sort()
console.log(`${N.toLocaleString()}レース　3連単1点（確率が一番高い目）\n`)
const hourOf = (dl) => { const m = String(dl ?? '').match(/^([0-9]{1,2}):/); return m ? Number(m[1]) : -1 }
const grade = (g) => { const s = String(g ?? ''); for (const k of ['SG', 'G1', 'G2', 'G3']) if (s.startsWith(k)) return k; return '一般' }
const C = {
  '本命確率0.7以上': (r) => r.p1 >= 0.7,
  '本命確率0.55〜0.8': (r) => r.p1 >= 0.55 && r.p1 < 0.8,
  '本命確率0.55未満': (r) => r.p1 < 0.55,
  '3連単本命の確率0.15以上': (r) => r.top.p >= 0.15,
  '3連単本命の確率0.08〜0.2': (r) => r.top.p >= 0.08 && r.top.p < 0.2,
  '余裕1.5以上': (r) => r.margin >= 1.5,
  '余裕2.0以上': (r) => r.margin >= 2.0,
  '余裕1.0〜2.0': (r) => r.margin >= 1.0 && r.margin < 2.0,
  '本命オッズ10倍未満': (r) => r.top.o < 10,
  '本命オッズ10〜30倍': (r) => r.top.o >= 10 && r.top.o < 30,
  '本命が1号艇': (r) => r.lane === 1,
  '一般戦': (r) => grade(r.m.grade) === '一般',
  'A1が0〜1人': (r) => (r.rf?.rc_a1 ?? 9) <= 1,
  'A1が2人以上': (r) => (r.rf?.rc_a1 ?? 0) >= 2,
  '前づけ危険度1.5未満': (r) => (r.rf?.rc_entry_risk ?? 9) < 1.5,
  '風3m以下': (r) => (r.m.wind_speed ?? 9) <= 3,
  '波4cm以下': (r) => (r.m.wave ?? 9) <= 4,
  '1R〜8R': (r) => r.m.race_no <= 8,
  '9R〜12R': (r) => r.m.race_no >= 9,
  '場の逃げ率0.50以上': (r) => (r.rf?.vh_nige ?? 0) >= 0.50,
  '展示で進入動かず': (r) => (r.rf?.exc_race_moved ?? 9) === 0,
}
const KEYS = Object.keys(C)
const ev = (arr) => {
  let hit = 0, ret = 0
  for (const r of arr) if (r.top.c === r.truth) { hit++; ret += r.top.o * 100 }
  return { n: arr.length, hr: hit / arr.length * 100, roi: ret / (arr.length * 100) * 100, hit }
}
const found = []
for (let i = 0; i < KEYS.length; i++) {
  const a = races.filter(C[KEYS[i]])
  if (a.length >= 3000) found.push({ k: [KEYS[i]], arr: a, ...ev(a) })
  for (let j = i + 1; j < KEYS.length; j++) {
    const b = a.filter(C[KEYS[j]])
    if (b.length >= 3000) found.push({ k: [KEYS[i], KEYS[j]], arr: b, ...ev(b) })
    for (let k = j + 1; k < KEYS.length; k++) {
      const c = b.filter(C[KEYS[k]])
      if (c.length >= 3000) found.push({ k: [KEYS[i], KEYS[j], KEYS[k]], arr: c, ...ev(c) })
    }
  }
}
// 月ごとの安定を見る
for (const f of found) {
  const per = MOS.map((mo) => { const s = f.arr.filter((r) => r.mo === mo); return s.length >= 100 ? ev(s).roi : null }).filter((x) => x != null)
  f.months = per.length
  f.plus = per.filter((x) => x >= 100).length
  f.min = per.length ? Math.min(...per) : 0
  f.per = per
}
found.sort((a, b) => b.roi - a.roi)
console.log(`条件の組み合わせ ${found.length.toLocaleString()}通り（3,000レース以上）\n`)
console.log('回収率の高い順・上位12')
console.log('  レース数 的中率  回収率 月数 100%超 最低月   条件')
for (const f of found.slice(0, 12))
  console.log(`  ${String(f.n).padStart(7)} ${f.hr.toFixed(2).padStart(6)}% ${f.roi.toFixed(2).padStart(7)}% ${String(f.months).padStart(3)} ${String(f.plus).padStart(5)} ${f.min.toFixed(1).padStart(6)}%  ${f.k.join(' ＋ ')}`)
console.log('\n月ごとに崩れないもの（10ヶ月中8ヶ月以上100%超）')
const stable = found.filter((f) => f.months >= 9 && f.plus >= 8).sort((a, b) => b.roi - a.roi)
if (stable.length) for (const f of stable.slice(0, 8)) {
  console.log(`  ${String(f.n).padStart(6)}本 的中${f.hr.toFixed(2)}% 回収${f.roi.toFixed(2)}%  ${f.k.join(' ＋ ')}`)
  console.log(`     月ごと ${f.per.map((x) => x.toFixed(0) + '%').join(' ')}`)
} else console.log('  なし')
db.close()
