// 3連単・3連複・2連単の予想を毎日ためて、結果と配当を後から埋める。
//
//   node scripts/record3.mjs --date 2026-08-30     その日の予想を記録
//   node scripts/record3.mjs --fill                結果と配当を埋める（前日以前）
//   node scripts/record3.mjs --report              ためた分の成績
//   node scripts/record3.mjs --show 2026-08-30     配信用の一覧を出す
//
// ★なぜ買わないのに記録するか
//   ① 2着3着のデータを日々ためる。モデル改善のときに「実際に何を予想して何が来たか」が要る
//   ② 娯楽枠の配信に使う（3連単・3連複は当たると見栄えがする）
//   単勝の買い判定には一切使わない。混ぜると判定が濁る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

db.exec(`
  CREATE TABLE IF NOT EXISTS pred_daily (
    race_id TEXT NOT NULL,
    date    TEXT NOT NULL,
    venue   TEXT,
    race_no INTEGER,
    kind    TEXT NOT NULL,     -- sanrentan / sanrenpuku / nirentan
    rank    INTEGER NOT NULL,  -- 1位から順に
    combo   TEXT NOT NULL,
    p       REAL,              -- モデルが出した確率
    hit     INTEGER,           -- 当たったか（後から埋める）
    payout  REAL,              -- 100円あたりの払戻（後から埋める）
    recorded_at TEXT,
    PRIMARY KEY (race_id, kind, rank)
  );
  CREATE INDEX IF NOT EXISTS idx_pd_date ON pred_daily(date);
`)

if (argv.includes('--report')) {
  const days = db.prepare(`SELECT COUNT(DISTINCT date) c FROM pred_daily`).get().c
  const races = db.prepare(`SELECT COUNT(DISTINCT race_id) c FROM pred_daily`).get().c
  console.log(`ためた分：${days}日 / ${races.toLocaleString()}レース\n`)
  console.log('  券種        点数  レース数  的中率   平均払戻   回収率')
  for (const kind of ['sanrentan', 'sanrenpuku', 'nirentan']) {
    for (const pts of [1, 2, 3, 6, 12]) {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT race_id) races, COUNT(*) bets,
               SUM(COALESCE(hit,0)) hits, SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret
        FROM pred_daily WHERE kind=? AND rank<=? AND hit IS NOT NULL`).get(kind, pts)
      if (!r.bets) continue
      const nm = { sanrentan: '3連単', sanrenpuku: '3連複', nirentan: '2連単' }[kind]
      console.log(`  ${nm.padEnd(8)} ${String(pts).padStart(4)}点 ${String(r.races).padStart(8)} ${(r.hits / r.races * 100).toFixed(2).padStart(7)}% ${(r.hits ? r.ret / r.hits : 0).toFixed(0).padStart(8)}円 ${(r.ret / (r.bets * 100) * 100).toFixed(2).padStart(8)}%`)
    }
    console.log('')
  }
  db.close(); process.exit(0)
}

if (argv.includes('--fill')) {
  // 結果が出ているレースに、当たり・払戻を埋める
  const PAY = new Map()
  for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
      WHERE bet_type IN ('sanrentan','sanrenpuku','nirentan') AND amount IS NOT NULL`).iterate())
    PAY.set(r.race_id + '|' + r.bet_type + '|' + r.combo, r.amount)
  const WIN = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).iterate()) {
    let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a) }
    a[r.rank_num] = r.lane
  }
  const rows = db.prepare(`SELECT race_id, kind, rank, combo FROM pred_daily WHERE hit IS NULL`).all()
  const upd = db.prepare(`UPDATE pred_daily SET hit=?, payout=? WHERE race_id=? AND kind=? AND rank=?`)
  let done = 0
  db.exec('BEGIN')
  for (const r of rows) {
    const w = WIN.get(r.race_id)
    if (!w || !w[1] || !w[2] || !w[3]) continue
    const truth = r.kind === 'sanrentan' ? `${w[1]}-${w[2]}-${w[3]}`
      : r.kind === 'sanrenpuku' ? [w[1], w[2], w[3]].sort().join('-')
        : `${w[1]}-${w[2]}`
    const hit = r.combo === truth ? 1 : 0
    const pay = hit ? (PAY.get(r.race_id + '|' + r.kind + '|' + r.combo) ?? null) : 0
    if (hit && pay == null) continue    // 払戻がまだ取れていない
    upd.run(hit, pay, r.race_id, r.kind, r.rank)
    done++
  }
  db.exec('COMMIT')
  console.log(`埋めた ${done.toLocaleString()} / 未確定だったもの ${rows.length.toLocaleString()}`)
  db.close(); process.exit(0)
}

const SHOW = flag('show')
if (SHOW) {
  const rows = db.prepare(`SELECT * FROM pred_daily WHERE date=? AND kind='sanrentan' AND rank<=3 ORDER BY race_no, rank`).all(SHOW)
  if (!rows.length) { console.log(`${SHOW} の記録がありません`); db.close(); process.exit(0) }
  console.log(`=== ${SHOW} の3連単予想（上位3点）===\n`)
  let cur = null
  for (const r of rows) {
    if (r.race_id !== cur) { cur = r.race_id; console.log(`${r.venue} ${r.race_no}R`) }
    const mark = r.hit === 1 ? ' ◎的中' : r.hit === 0 ? '' : ' （結果待ち）'
    console.log(`  ${r.rank}位 ${r.combo}  ${(r.p * 100).toFixed(1)}%${r.hit === 1 ? `  払戻 ${r.payout}円` : ''}${mark}`)
  }
  db.close(); process.exit(0)
}

// ---------- 記録 ----------
const DATE = flag('date') || new Date().toISOString().slice(0, 10)
const f = join(ROOT, 'data', `predict-${DATE}.json`)
if (!existsSync(f)) { console.error(`${f} がありません。先に predict.mjs を走らせること`); process.exit(1) }
const j = JSON.parse(readFileSync(f, 'utf8'))
const ins = db.prepare(`INSERT OR REPLACE INTO pred_daily
  (race_id,date,venue,race_no,kind,rank,combo,p,hit,payout,recorded_at)
  VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?)`)
const stamp = new Date().toISOString()
let n = 0, skipped = 0
db.exec('BEGIN')
for (const r of (j.races ?? [])) {
  const sets = [
    ['sanrentan', r.sanrentan], ['sanrenpuku', r.sanrenpuku], ['nirentan', r.nirentanTop],
  ]
  for (const [kind, list] of sets) {
    if (!Array.isArray(list) || !list.length) { skipped++; continue }
    list.forEach((x, i) => { ins.run(r.race_id, DATE, r.venue, r.race_no, kind, i + 1, x.combo, x.p, stamp); n++ })
  }
}
db.exec('COMMIT')
console.log(`${DATE}　記録 ${n.toLocaleString()}件 / ${(j.races ?? []).length}レース`)
if (skipped) console.log(`  ⚠ 出力に無かった券種 ${skipped}件（predict.mjs が古い可能性）`)
db.close()
