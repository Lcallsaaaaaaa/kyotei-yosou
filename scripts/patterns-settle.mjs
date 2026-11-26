// patterns_daily に結果（hit / payout）を入れる。
//
//   node scripts/patterns-settle.mjs                埋まっていない行だけ
//   node scripts/patterns-settle.mjs --date 2026-10-06
//   node scripts/patterns-settle.mjs --recheck      埋め済みも入れ直して検算する
//
// ★haishin.mjs の照合と同じ作り
//   当日は公式の結果ページ（result_live・速報）で埋め、翌朝 競走成績（Kファイル）が
//   来たらそれで上書きする。速報の取り違えが残ったままにならないようにするため。
//
// ★⚠ 買い目そのものは触らない。
//   走り終えたレースの予想は歴史なので、モデルを入れ替えても書き換えない
//   （patterns.mjs の upsert の WHERE hit IS NULL と同じ考え）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const ONLY = flag('date')
const RECHECK = argv.includes('--recheck')

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 30000')

const cond = RECHECK ? '1=1' : 'hit IS NULL'
const rows = ONLY
  ? db.prepare(`SELECT race_id, pattern, kind, rank, combo, hit FROM patterns_daily WHERE ${cond} AND date=?`).all(ONLY)
  : db.prepare(`SELECT race_id, pattern, kind, rank, combo, hit FROM patterns_daily WHERE ${cond}`).all()
if (!rows.length) { console.log(`照合するものなし${ONLY ? `（${ONLY}）` : ''}`); db.close(); process.exit(0) }

const IDS = [...new Set(rows.map((r) => r.race_id))]
const inq = IDS.map(() => '?').join(',')
const PAY = new Map(), WIN = new Map()
const put = (rid, k, combo, amt) => { if (combo && amt != null) PAY.set(`${rid}|${k}|${combo}`, amt) }

let live = 0
try {
  for (const r of db.prepare(`SELECT race_id, lane1, lane2, lane3, sanrentan, sanrentan_pay,
      sanrenpuku, sanrenpuku_pay FROM result_live WHERE status='ok' AND race_id IN (${inq})`).iterate(...IDS)) {
    WIN.set(r.race_id, { 1: r.lane1, 2: r.lane2, 3: r.lane3 }); live++
    put(r.race_id, 'sanrentan', r.sanrentan, r.sanrentan_pay)
    put(r.race_id, 'sanrenpuku', r.sanrenpuku, r.sanrenpuku_pay)
  }
} catch { /* result_live がまだ無い。Kファイルだけで進める */ }
// Kファイル由来を後に入れて上書きする（こちらが正）
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
    WHERE bet_type IN ('sanrentan','sanrenpuku') AND amount IS NOT NULL AND race_id IN (${inq})`).iterate(...IDS))
  PAY.set(`${r.race_id}|${r.bet_type}|${r.combo}`, r.amount)
let kfile = 0
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
    WHERE rank_num BETWEEN 1 AND 3 AND race_id IN (${inq})`).iterate(...IDS)) {
  let a = WIN.get(r.race_id); if (!a) { a = {}; WIN.set(r.race_id, a); kfile++ }
  a[r.rank_num] = r.lane
}
console.log(`未照合 ${IDS.length}レース　結果の元：当日取り ${live} ／ 競走成績のみ ${kfile}`)

const upd = db.prepare('UPDATE patterns_daily SET hit=?, payout=? WHERE race_id=? AND pattern=? AND rank=?')
let n = 0, changed = 0, waiting = 0
db.exec('BEGIN IMMEDIATE')
for (const r of rows) {
  const w = WIN.get(r.race_id)
  if (!w || !w[1] || !w[2] || !w[3]) continue        // 中止・失格などで3着まで揃わない
  const truth = r.kind === 'sanrentan' ? `${w[1]}-${w[2]}-${w[3]}` : [w[1], w[2], w[3]].sort().join('-')
  const hit = r.combo === truth ? 1 : 0
  const pay = hit ? (PAY.get(`${r.race_id}|${r.kind}|${r.combo}`) ?? null) : 0
  if (hit && pay == null) { waiting++; continue }    // 払戻がまだ入っていない
  if (r.hit != null && r.hit !== hit) changed++      // 速報と競走成績が食い違った
  upd.run(hit, pay, r.race_id, r.pattern, r.rank)
  n++
}
db.exec('COMMIT')
console.log(`照合 ${n}件${changed ? `（速報と食い違って直したのが ${changed}件）` : ''}`
  + (waiting ? `／払戻待ち ${waiting}件` : ''))
console.log('実績:  node scripts/patterns.mjs --report')
db.close()
