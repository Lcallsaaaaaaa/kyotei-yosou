// 指定した場コードについて「年間ベースレート」と「直近の傾向」を並べて出す。
// 朝の場選定（SOP STEP2/3）を1コマンドで済ませるためのもの。
//
//   node scripts/today.mjs 5,9,10,11,12,13,14,15,16,17,18,20
//   node scripts/today.mjs 5,9,10 --days 5      直近何日を「傾向」とみなすか（既定7）

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const JCD = {
  1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖',
  7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江',
  13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山',
  19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村',
}

const argv = process.argv.slice(2)
const jcds = (argv[0] ?? '').split(',').map(Number).filter(Boolean)
const di = argv.indexOf('--days')
const days = di > -1 ? Number(argv[di + 1]) : 7
if (!jcds.length) {
  console.error('場コードをカンマ区切りで指定してください: node scripts/today.mjs 5,9,10')
  process.exit(1)
}

// ⚠️ toISOString() はUTC変換で日付が1日ずれるので使わない（日本時間で運用するため）
const p2 = (n) => String(n).padStart(2, '0')
const ymdLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

const maxDate = one('SELECT MAX(date) d FROM races').d
const from = new Date(maxDate + 'T00:00:00')
from.setDate(from.getDate() - (days - 1))
const fromStr = ymdLocal(from)

const p = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '  - ')

console.log(`DB最終日 ${maxDate} / 直近${days}日 = ${fromStr}〜${maxDate}\n`)
console.log('場        │ 年間ベースレート          │ 直近の傾向')
console.log('          │ イン1着 枠なり 平均配当 万舟│ イン1着  まくり率  平均配当  万舟率')
console.log('──────────┼───────────────────────────┼──────────────────────────────────')

const rows = []
for (const jcd of jcds) {
  const base = one(`
    SELECT COUNT(*) n, SUM(e.rank_num=1) w FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=1 AND r.jcd=?`, jcd)
  const waku = one(`
    SELECT COUNT(*) total, SUM(CASE WHEN m=0 THEN 1 ELSE 0 END) w FROM (
      SELECT e.race_id, SUM(CASE WHEN e.lane<>e.course THEN 1 ELSE 0 END) m
      FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE r.jcd=? AND e.course IS NOT NULL GROUP BY e.race_id)`, jcd)
  const pay = one(`
    SELECT AVG(p.amount) avg, COUNT(*) n, SUM(CASE WHEN p.amount>=10000 THEN 1 ELSE 0 END) man
    FROM payouts p JOIN races r ON r.race_id=p.race_id
    WHERE r.jcd=? AND p.bet_type='sanrentan'`, jcd)

  const rin = one(`
    SELECT COUNT(*) n, SUM(e.rank_num=1) w FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.course=1 AND r.jcd=? AND r.date>=?`, jcd, fromStr)
  const rmk = one(`
    SELECT COUNT(*) n, SUM(CASE WHEN r.kimarite IN ('まくり','まくり差し') THEN 1 ELSE 0 END) m
    FROM races r WHERE r.jcd=? AND r.date>=?`, jcd, fromStr)
  const rpay = one(`
    SELECT AVG(p.amount) avg, COUNT(*) n, SUM(CASE WHEN p.amount>=10000 THEN 1 ELSE 0 END) man
    FROM payouts p JOIN races r ON r.race_id=p.race_id
    WHERE r.jcd=? AND p.bet_type='sanrentan' AND r.date>=?`, jcd, fromStr)

  const baseIn = base.n ? (base.w / base.n) * 100 : 0
  const recIn = rin.n ? (rin.w / rin.n) * 100 : null
  rows.push({ jcd, baseIn, recIn, diff: recIn === null ? null : recIn - baseIn, n: rin.n })

  console.log(
    `${JCD[jcd].padEnd(5, '　')}│ ${p(base.w, base.n).padStart(6)}% ${p(waku.w, waku.total).padStart(5)}% ` +
    `${String(Math.round(pay.avg ?? 0)).padStart(6)}円 ${p(pay.man, pay.n).padStart(4)}%│ ` +
    `${(recIn === null ? '  -  ' : recIn.toFixed(1) + '%').padStart(6)}(${String(rin.n).padStart(3)}走) ` +
    `${p(rmk.m, rmk.n).padStart(5)}% ${String(Math.round(rpay.avg ?? 0)).padStart(6)}円 ${p(rpay.man, rpay.n).padStart(5)}%`
  )
}

console.log('\n=== 場の性格（直近 − 年間ベース の乖離）===')
rows.filter((r) => r.diff !== null).sort((a, b) => b.diff - a.diff).forEach((r) => {
  const sign = r.diff >= 0 ? '+' : ''
  const tag = r.diff >= 8 ? '★イン強め（堅い）' : r.diff <= -8 ? '☆イン弱め（荒れ）' : ''
  console.log(`  ${JCD[r.jcd].padEnd(5, '　')} ${r.recIn.toFixed(1)}% (年間${r.baseIn.toFixed(1)}%) ${sign}${r.diff.toFixed(1)}pt  ${tag}`)
})
console.log('\n※ 直近の走数が少ない場（開催初日など）は乖離が振れやすい。n を必ず見ること。')
db.close()
