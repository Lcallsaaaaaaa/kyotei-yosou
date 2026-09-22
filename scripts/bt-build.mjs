// 検証用の候補表 bt を作る。1回作れば以降の検証は一瞬で終わる。
//
//   node --max-old-space-size=8192 scripts/bt-build.mjs
//
// ★なぜ要るか
//   条件を1つ試すたびに wj1(21万行)と wj3(434万行)を読み直して集計していた。
//   1回5〜8分かかり、メモリも足りなくなる。その場しのぎのスクリプトを毎回書くので
//   パースミスも増えた（2026-08-23に着順・払戻・race_idの桁で3件やらかしている）。
//   → 候補を1度だけ表に落とし、検証は SQL とインメモリのフィルタだけで回す。
//
// ★1行＝1つの買い目候補（そのレースでモデルが最有力とした艇）
//   単勝は wj1 の1着確率が最大の艇。複勝は wj3 の2着以内確率が最大の艇。
//   実運用（auto-bet / paper-day）が選ぶのと同じ「最有力1点」。
//
// ★入っている値はすべて「実測」。推定値は入れない
//   odds  = odds_tan の確定オッズ（単勝はtansho、複勝はfukusho_lo）
//   pay   = payouts.amount ÷ 100（実払戻。確定オッズ×100ではない）
//   ※確定オッズは買う時点では分からない。それを承知で使う検証用の表。
//     実運用の締切前オッズとのズレは odds_live 側で別に測る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const t0 = Date.now()
const lap = (s) => console.log(`  [計測] ${s} ${((Date.now() - t0) / 1000).toFixed(1)}秒`)

db.exec(`DROP TABLE IF EXISTS bt`)
db.exec(`CREATE TABLE bt (
  race_id TEXT NOT NULL, bet_type TEXT NOT NULL, lane INTEGER,
  date TEXT, mon TEXT, jcd INTEGER, race_no INTEGER, dl INTEGER,
  p REAL, odds REAL, pay REAL, hit INTEGER,
  wind REAL, wave REAL, grade TEXT, wr REAL, motor REAL,
  PRIMARY KEY (race_id, bet_type))`)

const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v)

const PAY = { tansho: new Map(), fukusho: new Map() }
for (const t of ['tansho', 'fukusho'])
  for (const r of db.prepare(`SELECT race_id,combo,amount FROM payouts WHERE bet_type=? AND amount>0`).all(t))
    PAY[t].set(r.race_id + '|' + r.combo, r.amount / 100)
lap('払戻')

const OD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,tansho,fukusho_lo FROM odds_tan WHERE tansho>0`).all())
  OD.set(r.race_id + '|' + r.lane, r)
lap('確定オッズ')

const RC = new Map()
for (const r of db.prepare(`SELECT race_id,date,jcd,race_no,wind_speed,wave,grade,deadline FROM races`).all()) {
  if (!r.deadline) continue
  const [h, mi] = r.deadline.split(':').map(Number)
  if (!Number.isFinite(h)) continue
  RC.set(r.race_id, { ...r, dl: h * 60 + mi })
}
lap('レース情報')

const PG = new Map()
for (const r of db.prepare(`SELECT race_id,lane,win_rate_nat,motor_top2 FROM programs`).all())
  PG.set(r.race_id + '|' + r.lane, r)
lap('番組表')

const ins = db.prepare(`INSERT OR REPLACE INTO bt VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
let n = 0, skipped = 0

const push = (rid, type, lane, p) => {
  const rc = RC.get(rid); if (!rc) { skipped++; return }
  const o = OD.get(rid + '|' + lane); if (!o) { skipped++; return }
  const odds = type === 'tansho' ? o.tansho : o.fukusho_lo
  if (!odds || odds <= 0) { skipped++; return }
  const pay = PAY[type].get(rid + '|' + lane) ?? 0
  const pg = PG.get(rid + '|' + lane)
  ins.run(rid, type, lane, rc.date, String(rc.date).slice(0, 7), rc.jcd, rc.race_no, rc.dl,
    p, odds, pay, pay > 0 ? 1 : 0, rc.wind_speed, rc.wave, rc.grade,
    pg?.win_rate_nat ?? null, pg?.motor_top2 ?? null)
  n++
}

db.exec('BEGIN')
// 単勝：1着確率が最大の艇
{
  const cur = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,p FROM wk1`).all()) {
    const c = cur.get(r.race_id)
    if (!c || c.p < r.p) cur.set(r.race_id, { lane: r.lane, p: r.p })
  }
  for (const [rid, c] of cur) push(rid, 'tansho', c.lane, c.p)
  lap(`単勝 ${cur.size}レース`)
}
// 複勝：2着以内確率が最大の艇（wj3 の3連単確率を艇ごとに足し上げる）
{
  const cur = new Map()
  for (const r of db.prepare(`SELECT race_id,combo,p FROM wk3`).all()) {
    let m = cur.get(r.race_id); if (!m) { m = new Map(); cur.set(r.race_id, m) }
    const [a, b] = r.combo.split('-').map(Number)
    add(m, a, r.p); add(m, b, r.p)
  }
  for (const [rid, m] of cur) {
    const t = [...m].sort((x, y) => y[1] - x[1])[0]
    if (t) push(rid, 'fukusho', t[0], t[1])
  }
  lap(`複勝 ${cur.size}レース`)
}
db.exec('COMMIT')
db.exec(`CREATE INDEX IF NOT EXISTS bt_i1 ON bt(bet_type, date)`)
db.exec(`CREATE INDEX IF NOT EXISTS bt_i2 ON bt(bet_type, p)`)

console.log(`\nbt に ${n.toLocaleString()}行（除外 ${skipped.toLocaleString()}行＝確定オッズか締切時刻が無いもの）`)

// ---------- 自己点検 ----------
console.log('\n=== 自己点検 ===')
for (const t of ['tansho', 'fukusho']) {
  const r = db.prepare(`SELECT COUNT(*) n, MIN(date) a, MAX(date) b,
    SUM(hit) h, AVG(p) ap, AVG(odds) ao FROM bt WHERE bet_type=?`).get(t)
  console.log(`  ${t === 'tansho' ? '単勝' : '複勝'} ${r.n.toLocaleString()}行  ${r.a}〜${r.b}  的中${(r.h / r.n * 100).toFixed(2)}%  平均確率${(r.ap * 100).toFixed(1)}%  平均確定${r.ao.toFixed(2)}倍`)
}
// ★較正：モデルの言う確率と実際が合っているか。ここがズレていたら表の作り方が間違っている。
console.log('  較正（モデルの確率 vs 実際の的中率）')
for (const t of ['tansho', 'fukusho'])
  for (const [lo, hi] of [[0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]]) {
    const r = db.prepare(`SELECT COUNT(*) n, AVG(p) ap, AVG(hit) ah FROM bt WHERE bet_type=? AND p>=? AND p<?`).get(t, lo, hi)
    if (r.n < 200) continue
    const gap = Math.abs(r.ap - r.ah) * 100
    console.log(`    ${t === 'tansho' ? '単勝' : '複勝'} ${(lo * 100).toFixed(0)}〜${(hi * 100).toFixed(0)}%  n=${String(r.n).padStart(6)}  予測${(r.ap * 100).toFixed(1)}%  実際${(r.ah * 100).toFixed(1)}%  差${gap.toFixed(1)}pt${gap > 3 ? '  ← 要確認' : ''}`)
  }
// ★単勝の1着＝確定オッズと払戻が一致するか
const chk = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN ABS(odds-pay)<0.051 THEN 1 ELSE 0 END) ok
  FROM bt WHERE bet_type='tansho' AND hit=1`).get()
console.log(`  単勝の的中時 確定オッズ vs 実払戻：${chk.n.toLocaleString()}件中一致 ${(chk.ok / chk.n * 100).toFixed(2)}%（残りは返還のあったレース）`)
db.close()
console.log(`\n完了 ${((Date.now() - t0) / 1000).toFixed(1)}秒`)
