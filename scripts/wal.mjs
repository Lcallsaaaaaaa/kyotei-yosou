// WAL（書き込み待ちファイル）が溜まりすぎていたら畳む。
//
//   node scripts/wal.mjs            いまの状態を見て、必要なら畳む
//   node scripts/wal.mjs --check    見るだけ（溜まっていれば終了コード1）
//
// ★なぜ要るか（2026-10-24）
//   夜間バッチが全部死に、直す係が復旧を始めた。`addbefore`（feat に18列を追加＝
//   テーブル全体の書き直し）の途中で**機械が再起動**し、書きかけが **9.98GBのWAL**
//   として残った（DB本体は4.83GB）。その後は**DBを開くだけで固まる**ようになり、
//   「DBが読めません」で半日止まった。畳むのに41秒。
//
// ★SQLiteは普通、接続を閉じるときに自動で畳む
//   だが**強制終了や再起動では閉じる処理が走らない**ので、そのまま残る。
//   しかも読み取り専用（readOnly）で開くと畳む権限が無いため、読むほど詰まる。
//
// ★⚠ ファイルの大きさで判断してはいけない（2026-10-25に踏んだ）
//   `journal_size_limit` が未設定（既定 -1）だと、**畳んでもファイルは縮まない**。
//   中身は空でも大きさは残るので、こちらは「まだ膨らんでいる」と誤認し、
//   30分ごとに畳んでは「1249MB → 1249MB」と**嘘の成功**を報告していた。
//   危ないのは大きさではなく **未処理ページ（本体へ移していない中身）**の量。
//   そこで
//     ・判断は `wal_checkpoint` が返す未処理ページ数で行う
//     ・`journal_size_limit` を設定して、畳んだあとファイルも縮むようにする
//
// ★決まり
//   ・読み取り専用でDBを開く前に、ここを通す
//   ・畳めなくても失敗にしない（次の回でやり直せばよい）
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB = join(ROOT, 'data', 'boatrace.db')

/** 未処理がこれを超えたら畳む。1ページ4KBなので 32,768ページ＝約128MB */
export const LIMIT_PAGES = 32768
/** 畳んだあとWALファイルをこの大きさまで切り詰める（64MB） */
export const SIZE_LIMIT_BYTES = 64 * 1024 * 1024

/** いまのWALファイルの大きさ（MB）。中身の量とは別物なので、表示用にしか使わない */
export function walMB() {
  try { return existsSync(DB + '-wal') ? statSync(DB + '-wal').size / 1048576 : 0 }
  catch { return 0 }
}

/**
 * WALに未処理がどれだけ溜まっているか調べ、多ければ畳む。
 *
 * @returns {{mb:number, pages:number, done:boolean, moved:number, sec:number, error?:string}}
 *   pages = 畳む前の未処理ページ数 / moved = 本体へ移せたページ数
 */
export function checkpointIfLarge({ limitPages = LIMIT_PAGES, log = () => {} } = {}) {
  const before = walMB()
  const t = Date.now()
  let db
  try {
    // ⚠ 読み書きで開くこと。readOnly では畳めない。
    db = new DatabaseSync(DB)
    db.exec('PRAGMA busy_timeout = 20000')
    // ★畳んだあとファイルも縮むようにする。これが無いと中身が空でも大きさが残る。
    db.exec(`PRAGMA journal_size_limit = ${SIZE_LIMIT_BYTES}`)

    // ★PASSIVE は誰も待たせない。まずこれで「いまどれだけ溜まっているか」を測る。
    //   TRUNCATE は排他が要るので、常駐5本が読んでいる昼間は取れず、
    //   busy_timeout を丸ごと待って復旧が止まる（10/25に実際に起きた）。
    const p = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    const total = p?.log ?? 0
    const moved = p?.checkpointed ?? 0
    const left = Math.max(0, total - moved)

    if (total < limitPages && before < 1024) {
      db.close()
      return { mb: before, pages: total, done: false, moved, sec: 0 }
    }

    log(`WALに ${total.toLocaleString()}ページ（約${Math.round(total * 4 / 1024)}MB）溜まっています。畳みます`)

    // 全部移せたなら切り詰めも試す（排他が取れなければ諦めてよい）
    let truncated = false
    if (left === 0) {
      try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); truncated = true }
      catch { /* 排他が取れないだけ。中身は空なので実害は無い */ }
    }
    db.close()
    const sec = Math.round((Date.now() - t) / 1000)
    const after = walMB()
    // ★「畳みました」と言えるのは、実際に移せたときだけ。
    //   中身が減っていないのに成功と報告しない（10/25にそれをやった）。
    if (moved > 0 || truncated) {
      log(`WALを畳みました（本体へ ${moved.toLocaleString()}ページ移動・残り ${left.toLocaleString()}ページ`
        + `・ファイル ${before.toFixed(0)}→${after.toFixed(0)}MB・${sec}秒`
        + `${truncated ? '・切り詰めあり' : ''}）`)
    } else {
      log(`WALを畳めませんでした（他の処理が読んでいます・残り ${left.toLocaleString()}ページ・${sec}秒）`)
    }
    return { mb: before, pages: total, done: moved > 0 || truncated, moved, sec, truncated }
  } catch (e) {
    // ★失敗しても落とさない。誰かが書いている最中なら、次の回に畳めばよい。
    try { db?.close() } catch { /* 開けていない */ }
    const msg = String(e.message).slice(0, 120)
    log(`WALを畳めませんでした: ${msg}`)
    return { mb: before, pages: 0, done: false, moved: 0, sec: Math.round((Date.now() - t) / 1000), error: msg }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  if (process.argv.includes('--check')) {
    // 見るだけ。PASSIVE は何も壊さないので、状態を知るために使う。
    const db = new DatabaseSync(DB)
    db.exec('PRAGMA busy_timeout = 20000')
    const p = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    db.close()
    const total = p?.log ?? 0
    console.log(`WAL: ファイル ${walMB().toFixed(1)}MB ／ 中身 ${total.toLocaleString()}ページ`
      + `（約${Math.round(total * 4 / 1024)}MB・上限 ${LIMIT_PAGES.toLocaleString()}ページ）`)
    process.exit(total >= LIMIT_PAGES ? 1 : 0)
  }
  const r = checkpointIfLarge({ log: (s) => console.log(s) })
  if (!r.done && !r.error) console.log(`畳む必要はありません（中身 ${r.pages.toLocaleString()}ページ）`)
}
