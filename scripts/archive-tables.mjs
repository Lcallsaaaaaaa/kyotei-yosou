// 検証の途中データを本体（data/boatrace.db）から別ファイルへ退避して、本体を軽くする。
//
//   node scripts/archive-tables.mjs --dry           何を退避するか・件数だけ見る（書き込まない）
//   node scripts/archive-tables.mjs --run           退避 → 件数を突き合わせ → 本体から外す
//   node scripts/archive-tables.mjs --vacuum        外したぶんの空き領域を詰めて、ファイルを小さくする
//   node scripts/archive-tables.mjs --restore wn3   退避先から本体へ1つ戻す（検証をやり直すとき）
//
// ★なぜやるか（2026-09-22・本人了承）
//   本体が19GBに育ち、そのうち少なくとも8.1GBは過去の検証で作った途中データ（歩進検証の予想表など）だった。
//   毎日の処理はそれを1つも使っていない。夜間処理が重くなり、公開用サーバーへ移す話の足かせにもなる。
// ★退避の対象の決め方
//   毎日の処理（night2/morning/night/catchup/retrain と常駐4本・画面・API）が読むスクリプト41本を全部検索し、
//   どこからも名前が出てこない表だけにした。名前を組み立てて読む箇所（flag('cal','wi1') など）も確認済み。
//   odds2t/odds2f/oddsk は今は使っていないが、集めた本物のオッズなので途中データではない → 残す。
// ★消えないこと
//   退避先 data/archive-2026-09-22.db に、元の表の作り（主キー・索引）ごと写す。件数が1件でも合わなければ外さない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(ROOT, 'data', 'boatrace.db')
const ARC = join(ROOT, 'data', 'archive-2026-09-22.db')
const argv = process.argv.slice(2)

const TABLES = [
  'biyori_race', 'biyori_racer', 'pred_bk', 'pred3_bk', 'rfeat',
  'fs1', 'fs1w', 'fs3', 'fs3w', 'fw1', 'fw1w', 'fw3', 'fw3w',
  'sd1', 'sd1w', 'sd3', 'sd3w', 'sg1', 'sg3', 'sk1', 'sk3', 'ss1', 'ss1w', 'ss3', 'ss3w', 'sw1', 'sw1w', 'sw3', 'sw3w',
  'wc1', 'wc3', 'wd1', 'wd1w', 'wd3', 'wd3w', 'we1', 'we1w', 'we3', 'we3w', 'wf1', 'wf1w', 'wf3', 'wf3w',
  'wg1', 'wg3', 'wgb1', 'wgb3', 'wh1', 'wh3', 'wk1b', 'wk3b', 'wl1', 'wl3', 'wm1', 'wm3',
  'wn1', 'wn1x', 'wn1xw', 'wn3', 'wn3x', 'wn3xw', 'wp1', 'wp3', 'wq1', 'wq3', 'wr1', 'wr3',
]
// 毎日の処理で使うので、何があっても退避しない（安全装置）
const KEEP = new Set(['wi1', 'wi3', 'wj1', 'wj3', 'wk1', 'wk3', 'w2', 'pred', 'pred3', 'pred3_prev', 'feat', 'bf', 'bt',
  'odds2t', 'odds2f', 'oddsk'])

const gb = (f) => (existsSync(f) ? (statSync(f).size / 1e9).toFixed(2) + 'GB' : '-')
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 60000).toFixed(1)}分`

const db = new DatabaseSync(MAIN)
db.exec('PRAGMA busy_timeout = 600000')
const exists = (name, schema = 'main') => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(name)
for (const t of TABLES) if (KEEP.has(t)) { console.error(`安全装置：${t} は退避してはいけない表`); process.exit(1) }

if (argv.includes('--dry')) {
  let n = 0
  for (const t of TABLES) {
    if (!exists(t)) { console.log(`  （無い）${t}`); continue }
    const c = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
    n += c; console.log(`  ${t.padEnd(14)} ${c.toLocaleString().padStart(12)}行`)
  }
  console.log(`対象 ${TABLES.length}表・${n.toLocaleString()}行　本体 ${gb(MAIN)}`)
  db.close(); process.exit(0)
}

if (argv.includes('--run')) {
  console.log(`=== 退避 → ${ARC} ===`)
  db.exec(`ATTACH DATABASE '${ARC.replace(/'/g, "''")}' AS arc`)
  db.exec('PRAGMA arc.journal_mode = OFF')   // 写し先は作り直せるので速さ優先
  const done = []
  for (const t of TABLES) {
    if (!exists(t)) { console.log(`  （無い）${t}`); continue }
    const n = db.prepare(`SELECT COUNT(*) c FROM main."${t}"`).get().c
    if (!exists(t, 'arc')) {
      const sql = db.prepare(`SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?`).get(t).sql
      db.exec(sql.replace(/^CREATE TABLE\s+("?)([^\s("]+)\1/i, `CREATE TABLE arc."$2"`))
      db.exec('BEGIN'); db.exec(`INSERT INTO arc."${t}" SELECT * FROM main."${t}"`); db.exec('COMMIT')
      for (const ix of db.prepare(`SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(t))
        db.exec(ix.sql.replace(/^CREATE (UNIQUE )?INDEX\s+("?)([^\s("]+)\2\s+ON\s+/i, (m, u) => `CREATE ${u ?? ''}INDEX arc."${m.match(/INDEX\s+"?([^\s("]+)/i)[1]}" ON `))
    }
    const a = db.prepare(`SELECT COUNT(*) c FROM arc."${t}"`).get().c
    if (a !== n) { console.error(`  ✕ ${t} 件数が合わない（本体${n} / 退避先${a}）。ここで止める。本体は何も消していない`); process.exit(1) }
    done.push(t)
    console.log(`  ✓ ${t.padEnd(14)} ${n.toLocaleString().padStart(12)}行 一致（${el()}）`)
  }
  console.log(`\n--- 全${done.length}表の件数が一致。本体から外す ---`)
  db.exec('BEGIN IMMEDIATE')
  for (const t of done) db.exec(`DROP TABLE main."${t}"`)
  db.exec('COMMIT')
  db.exec('DETACH DATABASE arc')
  console.log(`外した（${el()}）。退避先 ${gb(ARC)}。本体のファイルはまだ同じ大きさ → 次に --vacuum で詰める`)
  db.close(); process.exit(0)
}

if (argv.includes('--vacuum')) {
  console.log(`=== 空き領域を詰める　前: 本体 ${gb(MAIN)}・WAL ${gb(MAIN + '-wal')} ===`)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  console.log(`後: 本体 ${gb(MAIN)}・WAL ${gb(MAIN + '-wal')}（${el()}）`)
  process.exit(0)
}

const ri = argv.indexOf('--restore')
if (ri > -1) {
  const t = argv[ri + 1]
  db.exec(`ATTACH DATABASE '${ARC.replace(/'/g, "''")}' AS arc`)
  if (!exists(t, 'arc')) { console.error(`退避先に ${t} がありません`); process.exit(1) }
  if (exists(t)) { console.error(`本体にすでに ${t} があります`); process.exit(1) }
  const sql = db.prepare(`SELECT sql FROM arc.sqlite_master WHERE type='table' AND name=?`).get(t).sql
  db.exec(sql.replace(/^CREATE TABLE\s+("?)([^\s("]+)\1/i, `CREATE TABLE main."$2"`))
  db.exec('BEGIN'); db.exec(`INSERT INTO main."${t}" SELECT * FROM arc."${t}"`); db.exec('COMMIT')
  console.log(`${t} を本体へ戻した（${db.prepare(`SELECT COUNT(*) c FROM main."${t}"`).get().c.toLocaleString()}行）。索引は必要なら作り直すこと`)
  db.close(); process.exit(0)
}
console.log('使い方: --dry / --run / --vacuum / --restore <表>')
