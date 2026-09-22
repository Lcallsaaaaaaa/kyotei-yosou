// 予想を計算し直して、まだ締切前のレースを候補に足す。
// 画面の「予想」ボタンから呼ばれる。
//
//   node scripts/refresh-picks.mjs
//   node scripts/refresh-picks.mjs --date 2026-08-23
//
// ★判定済みのものは触らない
//   すでに買い／見送りを決めたレースを上書きすると、記録が壊れる。
//   足すのは「まだ bets に無い」かつ「締切前」のレースだけ。
//
// ★auto-bet は毎周DBを読むので、ここで足せば向こうが拾う
//   デーモンを再起動する必要はない。再起動は候補の取りこぼしを生む。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import * as S from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const p2 = (n) => String(n).padStart(2, '0')
const DATE = flag('date', (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` })())
const YMD = DATE.replace(/-/g, '')

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const log = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`)

log('予想を計算中（30秒〜1分）...')
const pred = await S.runPredict(ROOT, DATE, 0)      // キャッシュを使わず作り直す
const WR = S.winRates(db, YMD)
const DL = await S.deadlines(YMD, [...new Set(pred.races.map((x) => x.jcd))])
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
const now = new Date()
const nowM = now.getHours() * 60 + now.getMinutes()

// ★1日の上限は設けない（本人の運用方針）。
//   参考：歩進検証では 単勝は上限3本のほうが良く（143.4% → 156.3%）、
//   複勝は上限なしのほうが良い（156.3% → 162.0%）。単勝は本数を増やすと薄まる。
const TYPES = [
  { key: 'tansho', label: '単勝', pick: (x) => x.first?.[0], minP: S.MIN_P, maxP: S.MAX_P, maxWR: S.MAX_WR },
  { key: 'fukusho', label: '複勝', pick: (x) => x.top2?.[0], minP: S.FUKU.minP, maxP: S.FUKU.maxP, maxWR: S.FUKU.maxWR },
  { key: 'fuku90', label: '複勝・高的中', pick: (x) => x.top2?.[0], minP: S.FUKU90.minP, maxP: 1.01, maxWR: 99,
    venueNG: new Set(S.FUKU90.badVenues) },
]
const ins = db.prepare(`INSERT OR IGNORE INTO bets
  (race_id,lane,bet_type,date,venue,race_no,deadline,racer,p,win_rate,odds_seen,mins_before,decision,checked_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL)`)

let total = 0
for (const T of TYPES) {
  let added = 0
  for (const x of pred.races) {
    const dl = DL.get(x.jcd)?.[x.race_no - 1] ?? null
    if (!dl || toMin(dl) < nowM) continue                 // 締切済みは足さない
    const f = T.pick(x); if (!f) continue
    const wr = WR.get(x.race_id + '|' + f.lane)
    if (!(f.p >= T.minP && f.p < T.maxP)) continue
    if (T.venueNG && T.venueNG.has(x.jcd)) continue
    // ★判定済みは触らない。INSERT OR IGNORE なので既存行はそのまま。
    const r = ins.run(x.race_id, f.lane, T.key, DATE, x.venue, x.race_no, dl, f.name, f.p, wr, null, null)
    if (r.changes) { added++; log(`  +[${T.label}] ${dl} ${x.venue}${x.race_no}R ${f.lane}号艇 ${f.name} 確率${(f.p * 100).toFixed(0)}% 勝率${wr == null ? '-' : wr.toFixed(2)}`) }
  }
  log(`${T.label}: ${added}本を追加`)
  total += added
}
log(`合計 ${total}本を追加しました。判定は auto-bet が締切${S.CHECK_FROM}分前に行います。`)
db.close()
