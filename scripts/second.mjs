// モデルの2番手が勝ったレース（全体の19.38%）の特徴を洗い出す。
//
//   node --max-old-space-size=6144 scripts/second.mjs --t wg1
//
// ★見方
//   基準率19.38%より「2番手が勝つ率」が高く出る条件を探す。
//   同時に「1番手が勝つ率」も見る。1番手が落ちるだけで2番手も落ちる条件（＝ただ荒れるだけ）と、
//   1番手→2番手に振り替わる条件（＝入れ替えれば得する条件）は別物。
//   欲しいのは後者。前者は点数を増やすしかない。
//
// ★使う条件は締切前に分かるものだけ。決まり手だけは事後だが、
//   「何が起きているのか」を知るために参考として出す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T = flag('t', 'wg1')

// レースごとに 1番手/2番手/勝者 をまとめる
const R = new Map()
for (const r of db.prepare(`SELECT race_id, lane, p, y FROM ${T} ORDER BY race_id`).iterate()) {
  let a = R.get(r.race_id); if (!a) { a = []; R.set(r.race_id, a) }
  a.push(r)
}
const meta = new Map()
for (const r of db.prepare(`SELECT r.race_id, r.jcd, r.grade, r.deadline, r.wind_speed, r.wind_dir,
    r.wave, r.race_no, r.day_no, r.kimarite, r.title FROM races r WHERE r.date >= '2025-10-01'`).all())
  meta.set(r.race_id, r)
const rf = new Map()
for (const r of db.prepare(`SELECT rf.race_id, rf.lane, rf.rc_a1, rf.rc_entry_risk, rf.rc_wr_std,
    rf.rc_out_strong, rf.exc_race_moved, rf.ex_rank, rf.exst_rank, rf.vh_nige
    FROM rfeat rf WHERE rf.race_id IN (SELECT DISTINCT race_id FROM ${T})`).iterate())
  rf.set(r.race_id + '|' + r.lane, r)

const races = []
for (const [rid, bs] of R) {
  if (bs.length !== 6) continue
  bs.sort((x, y) => y.p - x.p)
  const win = bs.findIndex((b) => b.y === 1)
  if (win < 0) continue
  const m = meta.get(rid); if (!m) continue
  const f1 = rf.get(rid + '|' + bs[0].lane), f2 = rf.get(rid + '|' + bs[1].lane)
  races.push({
    rid, rank: win, gap: bs[0].p - bs[1].p, p1: bs[0].p,
    l1: bs[0].lane, l2: bs[1].lane, m, f1, f2,
  })
}
const N = races.length
const base1 = races.filter((r) => r.rank === 0).length / N
const base2 = races.filter((r) => r.rank === 1).length / N
console.log(`対象 ${N.toLocaleString()}レース　基準率： 1番手が勝つ ${(base1 * 100).toFixed(2)}% / 2番手が勝つ ${(base2 * 100).toFixed(2)}%\n`)

function table(title, keyOf, order) {
  const M = new Map()
  for (const r of races) {
    const k = keyOf(r); if (k == null) continue
    let a = M.get(k); if (!a) { a = { n: 0, w1: 0, w2: 0 }; M.set(k, a) }
    a.n++; if (r.rank === 0) a.w1++; if (r.rank === 1) a.w2++
  }
  const keys = order ? order.filter((k) => M.has(k)) : [...M.keys()].sort()
  console.log(`════ ${title} ════`)
  console.log('  条件                レース数   全体比   1番手が勝つ   2番手が勝つ   基準との差')
  for (const k of keys) {
    const a = M.get(k); if (a.n < 200) continue
    const r1 = a.w1 / a.n * 100, r2 = a.w2 / a.n * 100
    const d = r2 - base2 * 100
    const mark = d >= 3 ? ' ★' : d <= -3 ? ' ▽' : ''
    console.log(`  ${String(k).padEnd(18)} ${String(a.n).padStart(8)} ${(a.n / N * 100).toFixed(1).padStart(7)}% ${r1.toFixed(2).padStart(11)}% ${r2.toFixed(2).padStart(12)}% ${((d >= 0 ? '+' : '') + d.toFixed(2) + 'pt').padStart(11)}${mark}`)
  }
  console.log('')
}

const gapB = (g) => g < 0.05 ? 'A 0.00-0.05' : g < 0.10 ? 'B 0.05-0.10' : g < 0.15 ? 'C 0.10-0.15'
  : g < 0.20 ? 'D 0.15-0.20' : g < 0.30 ? 'E 0.20-0.30' : g < 0.45 ? 'F 0.30-0.45' : 'G 0.45以上'
const hourOf = (dl) => { const m = String(dl ?? '').match(/^([0-9]{1,2}):/); return m ? Number(m[1]) : null }
const windB = (w) => w == null ? null : w <= 1 ? 'A 0-1m' : w <= 3 ? 'B 2-3m' : w <= 5 ? 'C 4-5m' : w <= 7 ? 'D 6-7m' : 'E 8m以上'
const waveB = (w) => w == null ? null : w === 0 ? 'A 0cm' : w <= 2 ? 'B 1-2cm' : w <= 4 ? 'C 3-4cm' : w <= 7 ? 'D 5-7cm' : 'E 8cm以上'
const gradeB = (g) => { const s = String(g ?? ''); for (const k of ['SG', 'G1', 'G2', 'G3']) if (s.startsWith(k)) return k; return s === '一般' ? '一般' : 'その他' }

table('確率差（1番手 − 2番手）', (r) => gapB(r.gap))
table('1番手に選んだ枠', (r) => r.l1 + '号艇')
table('2番手に選んだ枠', (r) => r.l2 + '号艇')
table('2番手は1番手より内か外か', (r) => r.l2 < r.l1 ? '2番手のほうが内' : '2番手のほうが外')
table('レース場', (r) => String(r.m.jcd).padStart(2, '0'))
table('時間帯', (r) => { const h = hourOf(r.m.deadline); return h == null ? null : String(h).padStart(2, '0') + '時台' })
table('風速', (r) => windB(r.m.wind_speed))
table('波高', (r) => waveB(r.m.wave))
table('グレード', (r) => gradeB(r.m.grade), ['SG', 'G1', 'G2', 'G3', '一般', 'その他'])
table('レース番号', (r) => String(r.m.race_no).padStart(2, '0') + 'R')
table('節の日目', (r) => r.m.day_no == null ? null : r.m.day_no + '日目')
table('A1の人数', (r) => r.f1 == null ? null : Math.round(r.f1.rc_a1) + '人')
table('前づけ危険度', (r) => { const v = r.f1?.rc_entry_risk; return v == null ? null
  : v < 0.3 ? 'A 0.0-0.3' : v < 0.8 ? 'B 0.3-0.8' : v < 1.5 ? 'C 0.8-1.5' : v < 2.5 ? 'D 1.5-2.5' : 'E 2.5以上' })
table('展示で進入が動いた艇数', (r) => r.f1?.exc_race_moved == null ? null : Math.round(r.f1.exc_race_moved) + '艇')
table('1番手の展示タイム順位', (r) => r.f1?.ex_rank ? Math.round(r.f1.ex_rank) + '位' : null)
table('2番手の展示タイム順位', (r) => r.f2?.ex_rank ? Math.round(r.f2.ex_rank) + '位' : null)
table('1番手の展示ST順位', (r) => r.f1?.exst_rank ? Math.round(r.f1.exst_rank) + '位' : null)
table('2番手の展示ST順位', (r) => r.f2?.exst_rank ? Math.round(r.f2.exst_rank) + '位' : null)
table('【事後・参考】決まり手', (r) => r.m.kimarite ?? null)
db.close()
