// 風・時間帯・潮回りがコース別成績にどれだけ効くかを測る。
//
//   node scripts/conditions.mjs
//   node scripts/conditions.mjs --jcd 24     場を絞る
//
// ★測る対象
//   ① 風速      … 強いほど荒れるのか
//   ② 風向      … 追い風/向かい風は場によって方角が違うので、場ごとに見る
//   ③ 時間帯    … 締切時刻で区切る。ナイターと昼で水面が変わるか
//   ④ 潮回り    … 海水面の場では干満で水面が変わる。
//                  潮汐データはDBに無いので**月齢から潮回りを天文計算**して代用する。
//                  月齢0/15付近＝大潮、7/22付近＝小潮。
//
// ★注意
//   条件で切ると標本が細るので、必ず件数を併記する。
//   差が出ても、それが偶然の範囲かを二項分布の標準誤差と比べて判断すること。

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
// 海水面（潮の干満が効く）とされる場
const TIDAL = new Set([3, 4, 8, 9, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])

const pc = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '  -  ')
// 二項分布の標準誤差（差が偶然かの目安）
const se = (p, n) => Math.sqrt((p * (1 - p)) / n) * 100

console.log('=== 条件別のイン1着率 ===\n')

// ---------- ① 風速 ----------
console.log('① 風速')
console.log('風速     レース数   イン1着率   ±誤差')
for (const r of all(`SELECT r.wind_speed w, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE e.course=1 AND r.wind_speed IS NOT NULL GROUP BY r.wind_speed ORDER BY r.wind_speed`)) {
  if (r.n < 300) continue
  const p = r.k / r.n
  console.log(`  ${String(r.w).padStart(2)}m  ${String(r.n).padStart(8)}   ${pc(r.k, r.n).padStart(7)}   ±${se(p, r.n).toFixed(1)}pt`)
}

// ---------- ② 時間帯（締切時刻） ----------
console.log('\n② 時間帯（締切時刻）')
console.log('時間帯    レース数   イン1着率   ±誤差')
for (const r of all(`SELECT CAST(substr(r.deadline,1,2) AS INTEGER) h, COUNT(*) n,
    SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE e.course=1 AND r.deadline IS NOT NULL GROUP BY h ORDER BY h`)) {
  if (r.n < 300) continue
  const p = r.k / r.n
  console.log(`  ${String(r.h).padStart(2)}時台 ${String(r.n).padStart(8)}   ${pc(r.k, r.n).padStart(7)}   ±${se(p, r.n).toFixed(1)}pt`)
}

// ---------- ③ 月齢＝潮回り ----------
// 月齢：2000-01-06 18:14 UTC を新月として朔望月29.530588日で割った余り
function moonAge(dateStr) {
  const t = Date.parse(dateStr + 'T12:00:00Z')
  const newMoon = Date.parse('2000-01-06T18:14:00Z')
  const syn = 29.530588853 * 86400000
  let a = ((t - newMoon) % syn) / 86400000
  if (a < 0) a += 29.530588853
  return a
}
// 大潮=新月/満月付近、小潮=上弦/下弦付近
function tideKind(age) {
  const d = Math.min(Math.abs(age - 0), Math.abs(age - 14.765), Math.abs(age - 29.53))
  if (d <= 2) return '大潮'
  if (d <= 4.5) return '中潮'
  if (d <= 6.5) return '小潮'
  return '長潮・若潮'
}

console.log('\n③ 潮回り（月齢から計算）× 海水面か淡水面か')
const rows = all(`SELECT r.date, r.jcd, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE e.course=1 GROUP BY r.date, r.jcd`)
const agg = {}
for (const r of rows) {
  const kind = tideKind(moonAge(r.date))
  const water = TIDAL.has(r.jcd) ? '海水面' : '淡水面'
  const key = `${water}|${kind}`
  agg[key] ??= { n: 0, k: 0 }
  agg[key].n += r.n
  agg[key].k += r.k
}
console.log('水面     潮回り        レース数   イン1着率   ±誤差')
for (const water of ['海水面', '淡水面']) {
  for (const kind of ['大潮', '中潮', '小潮', '長潮・若潮']) {
    const a = agg[`${water}|${kind}`]
    if (!a || a.n < 300) continue
    const p = a.k / a.n
    console.log(`${water}   ${kind.padEnd(6, '　')}${String(a.n).padStart(9)}   ${pc(a.k, a.n).padStart(7)}   ±${se(p, a.n).toFixed(1)}pt`)
  }
}
console.log('  ※ 淡水面は潮の影響を受けないので、ここに差が出たら「月齢そのもの」ではなく別の要因（季節など）。')
console.log('     海水面だけに差が出て淡水面に出ないなら、潮の効果と言える。')

// ---------- ④ 風向（場ごと） ----------
console.log('\n④ 風向：場ごとに「イン1着率が最も高い風向」と「最も低い風向」')
console.log('場       最良の風向          最悪の風向          差')
for (const j of Object.keys(JCD).map(Number)) {
  const ws = all(`SELECT r.wind_dir d, COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
    FROM races r JOIN entries e ON e.race_id=r.race_id
    WHERE e.course=1 AND r.jcd=? AND r.wind_dir IS NOT NULL AND r.wind_speed >= 3
    GROUP BY r.wind_dir HAVING n >= 100`, j)
  if (ws.length < 3) continue
  const sorted = ws.map((r) => ({ ...r, d: String(r.d ?? '不明'), p: r.k / r.n })).sort((a, b) => b.p - a.p)
  const hi = sorted[0], lo = sorted[sorted.length - 1]
  const diff = (hi.p - lo.p) * 100
  const err = Math.sqrt(se(hi.p, hi.n) ** 2 + se(lo.p, lo.n) ** 2)
  const sig = diff > 2 * err ? '★有意' : ''
  console.log(`${JCD[j].padEnd(5, '　')} ${hi.d.padEnd(3, '　')} ${pc(hi.k, hi.n)}(n=${String(hi.n).padStart(4)})   ` +
    `${lo.d.padEnd(3, '　')} ${pc(lo.k, lo.n)}(n=${String(lo.n).padStart(4)})   ${diff.toFixed(1)}pt ±${err.toFixed(1)} ${sig}`)
}
console.log('  ※ 風速3m以上に限定。★有意＝差が誤差の2倍を超えている。')

// ---------- ⑤ 時間帯の効果は「レース番号」の交絡ではないか ----------
console.log('\n⑤ ★交絡の確認：時間帯の差は「レース番号」で説明できるか')
console.log('  番組はレース番号ごとに組まれ方が違う（1Rは新人中心、12Rは特選）。')
console.log('  時間帯の差がレース番号の差なら、時間帯そのものを特徴量にするのは誤り。\n')
console.log('R      レース数   イン1着率   1号艇A1率   平均級別差')
for (const r of all(`SELECT r.race_no rn, COUNT(*) n,
    SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) k
  FROM races r JOIN entries e ON e.race_id=r.race_id
  WHERE e.course=1 GROUP BY r.race_no ORDER BY r.race_no`)) {
  const g = all(`SELECT
      AVG(CASE WHEN p.lane=1 AND p.grade='A1' THEN 1.0 ELSE 0.0 END)*6 a1,
      AVG(CASE WHEN p.lane=1 THEN CASE p.grade WHEN 'A1' THEN 3 WHEN 'A2' THEN 2 WHEN 'B1' THEN 1 ELSE 0 END END)
      - AVG(CASE WHEN p.lane>1 THEN CASE p.grade WHEN 'A1' THEN 3 WHEN 'A2' THEN 2 WHEN 'B1' THEN 1 ELSE 0 END END) gap
    FROM programs p JOIN races r2 ON r2.race_id=p.race_id WHERE r2.race_no=?`, r.rn)[0]
  console.log(`  ${String(r.rn).padStart(2)}  ${String(r.n).padStart(8)}   ${pc(r.k, r.n).padStart(7)}   ${(g.a1 * 100).toFixed(1).padStart(5)}%   ${(g.gap ?? 0).toFixed(2).padStart(6)}`)
}
console.log('  ※「1号艇A1率」「平均級別差（1号艇 − 他艇）」が大きいRほどイン1着率が高いなら、')
console.log('    時間帯の効果ではなく**番組の組まれ方**が正体。')
db.close()
