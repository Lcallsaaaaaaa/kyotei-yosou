// 過去の確定オッズ（単勝・複勝）をまとめて埋める。
//
//   node scripts/odds-backfill.mjs --from 2023-01-01 --to 2025-08-17
//   node scripts/odds-backfill.mjs --stats                    進捗だけ見る
//
// ★なぜ要るか
//   2023年以降を予想して実証したいが、確定オッズが2025-08-18からしか無い。
//   オッズが無ければ回収率を出せない。公式は過去ぶんの確定オッズを残している
//   （2023-01-15 で取得できることを確認済み）ので、ここを埋める。
//
// ★odds.mjs との違い
//   odds.mjs は3連単120通りを取る（重い）。ここは oddstf ページ1枚から
//   単勝6＋複勝6だけを取る。1レース1リクエストで済む。
//
// ★止めても再開できる
//   既に odds_tan にあるレースは飛ばす。途中で落ちても同じコマンドで続きから。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 60000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }

const stat = () => {
  const r = db.prepare(`SELECT COUNT(DISTINCT race_id) c FROM odds_tan`).get()
  const t = db.prepare(`SELECT COUNT(*) c FROM races`).get()
  console.log(`確定オッズ済み ${r.c.toLocaleString()} / レース総数 ${t.c.toLocaleString()}`)
  for (const y of ['2023', '2024', '2025', '2026']) {
    const a = db.prepare(`SELECT COUNT(*) c FROM races WHERE date LIKE ?`).get(y + '%').c
    const b = db.prepare(`SELECT COUNT(DISTINCT race_id) c FROM odds_tan WHERE race_id LIKE ?`).get(y + '%').c
    if (a) console.log(`  ${y}年  ${b.toLocaleString()} / ${a.toLocaleString()}  (${(b / a * 100).toFixed(1)}%)`)
  }
}
if (argv.includes('--stats')) { stat(); db.close(); process.exit(0) }

const FROM = flag('from', '2023-01-01'), TO = flag('to', '2025-08-17')
const CONC = Number(flag('conc', 6))
const DELAY = Number(flag('delay', 120))

// 対象＝結果はあるが確定オッズが無いレース
const todo = db.prepare(`SELECT r.race_id FROM races r
  LEFT JOIN (SELECT DISTINCT race_id FROM odds_tan) o ON o.race_id = r.race_id
  WHERE r.date >= ? AND r.date <= ? AND o.race_id IS NULL
  ORDER BY r.race_id`).all(FROM, TO).map((x) => x.race_id)
console.log(`対象 ${todo.length.toLocaleString()}レース（${FROM} 〜 ${TO}）`)
console.log(`同時${CONC}件・間隔${DELAY}ms → 推定 約${Math.ceil(todo.length * DELAY / CONC / 60000)}分\n`)
if (!todo.length) { stat(); db.close(); process.exit(0) }

const ins = db.prepare(`INSERT OR REPLACE INTO odds_tan (race_id,lane,tansho,fukusho_lo,fukusho_hi) VALUES (?,?,?,?,?)`)
let ok = 0, ng = 0, none = 0, done = 0
const t0 = Date.now()

async function one(rid) {
  const jcd = rid.slice(9, 11), rno = Number(rid.slice(12)), hd = rid.slice(0, 8)
  for (let a = 0; a < 3; a++) {
    try {
      const h = await (await fetch(
        `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${rno}&jcd=${jcd}&hd=${hd}`,
        { signal: AbortSignal.timeout(20_000) })).text()
      const v = [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
      if (v.length !== 12) { none++; return }
      // 前半6＝単勝、後半6＝複勝「下限-上限」
      const rows = []
      for (let i = 0; i < 6; i++) {
        const tan = Number(v[i])
        const m = String(v[i + 6] ?? '').match(/^([0-9.]+)(?:-([0-9.]+))?/)
        rows.push([rid, i + 1,
          Number.isFinite(tan) && tan > 0 ? tan : null,
          m && Number(m[1]) > 0 ? Number(m[1]) : null,
          m && m[2] && Number(m[2]) > 0 ? Number(m[2]) : null])
      }
      // 1艇も取れていないなら保存しない（未確定ページ）
      if (!rows.some((r) => r[2] != null)) { none++; return }
      for (const r of rows) ins.run(...r)
      ok++; return
    } catch { await new Promise((r) => setTimeout(r, 600 * (a + 1))) }
  }
  ng++
}

for (let i = 0; i < todo.length; i += CONC) {
  db.exec('BEGIN')
  await Promise.all(todo.slice(i, i + CONC).map(one))
  db.exec('COMMIT')
  done += Math.min(CONC, todo.length - i)
  if (done % 600 === 0 || done === todo.length) {
    const el = (Date.now() - t0) / 1000
    const rate = done / el
    console.log(`[${(done / todo.length * 100).toFixed(1)}%] ${done.toLocaleString()}/${todo.length.toLocaleString()}  取得${ok.toLocaleString()} 無し${none} 失敗${ng}  ${(rate * 60).toFixed(0)}件/分  残り約${Math.ceil((todo.length - done) / rate / 60)}分`)
  }
  await new Promise((r) => setTimeout(r, DELAY))
}
console.log(`\n完了: 取得${ok.toLocaleString()} / 未確定${none} / 失敗${ng}`)
stat()
db.close()
