// paper_bets（その日の全レースを条件どおりに判定した記録）を払戻と突き合わせる。
//
//   node scripts/paper-report.mjs            全期間
//   node scripts/paper-report.mjs --date 2026-08-23
//
// ★bets（実際に買った記録）との違い
//   bets は当日の消化状況に左右される。条件を変えた日は途中まで旧条件だったりする。
//   paper_bets は「その条件で1日を最初から回したらどうなるか」を全レース分残したもの。
//   実運用と同じく**締切前オッズ・締切が早い順・1日の上限つき**で判定してある。
//   舟券は買っていない。想定と実績のズレを見るための帳簿。
import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const i = argv.indexOf('--date')
const DATE = i > -1 ? argv[i + 1] : null

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='paper_bets'`).get()) {
  console.log('paper_bets がありません。scripts/paper-day.mjs を先に動かしてください。'); process.exit(0)
}
const rows = db.prepare(`
  SELECT b.*, py.amount,
    (SELECT COUNT(*) FROM payouts x WHERE x.race_id=b.race_id) settled
  FROM paper_bets b
  LEFT JOIN payouts py ON py.race_id=b.race_id AND py.bet_type=(CASE b.bet_type WHEN 'fuku90' THEN 'fukusho' ELSE b.bet_type END)
       AND py.combo=CAST(b.lane AS TEXT) AND py.amount>0
  ${DATE ? 'WHERE b.date=?' : ''}
  ORDER BY b.date, b.deadline`).all(...(DATE ? [DATE] : []))
if (!rows.length) { console.log('記録がありません'); process.exit(0) }

for (const key of ['tansho', 'fukusho', 'fuku90']) {
  const label = { tansho: '単勝', fukusho: '複勝', fuku90: '複勝・高的中' }[key]
  const list = rows.filter((r) => r.bet_type === key)
  const buys = list.filter((r) => r.decision === 'buy')
  const done = buys.filter((r) => r.settled > 0)
  console.log(`\n${'='.repeat(58)}\n${label}　${DATE ?? '全期間'}\n${'='.repeat(58)}`)
  const n = (d) => list.filter((r) => r.decision === d).length
  console.log(`候補${list.length}本 → 買い${buys.length}／見送り${n('skip')}／上限到達後${n('capped')}／締切前オッズ無し${n('no_odds')}`)
  if (!done.length) {
    console.log(buys.length ? `  ${buys.length}本は結果待ち（払戻は翌日昼公開）` : '  買いなし')
    continue
  }
  const hit = done.filter((r) => r.amount > 0)
  const ret = done.reduce((a, r) => a + (r.amount ?? 0), 0)
  const bet = done.length * 100
  for (const r of done) {
    const res = r.amount > 0 ? `的中 ${r.amount}円（${(r.amount / 100).toFixed(1)}倍）` : 'はずれ'
    console.log(`  ${r.date} ${r.deadline} ${(r.venue + r.race_no + 'R').padEnd(8)} ${r.lane}号艇 ${String(r.racer).padEnd(7)} 確率${(r.p * 100).toFixed(0)}% ${r.odds?.toFixed(1)}倍 → ${res}`)
  }
  const days = new Set(done.map((r) => r.date)).size
  console.log(`\n  ${done.length}点（${days}日・1日${(done.length / days).toFixed(2)}本）　的中${hit.length}本 ${(hit.length / done.length * 100).toFixed(1)}%`)
  console.log(`  投資${bet.toLocaleString()}円 払戻${ret.toLocaleString()}円 収支${ret - bet >= 0 ? '+' : ''}${(ret - bet).toLocaleString()}円　回収率${(ret / bet * 100).toFixed(1)}%`)
  if (done.length < buys.length) console.log(`  ※${buys.length - done.length}本は結果待ち`)
  if (done.length < 100) console.log(`  ※100点に届くまで、この回収率は判断材料になりません（あと${100 - done.length}点）`)
}
db.close()
