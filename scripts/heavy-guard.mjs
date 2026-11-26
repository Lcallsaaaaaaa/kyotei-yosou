// 重い処理が、レース中にサイトの更新を押し潰さないようにする見張り。
//
//   import { heavyGuard } from './heavy-guard.mjs'
//   heavyGuard('walk.mjs')          // レース中なら、ここで止まる
//
//   どうしても走らせたいときは --force を付ける。
//
// ★なぜ要るか（2026-10-09）
//   2026-10-07、全期間の歩進検証（5GBのヒープ）を**レース中に**走らせた。
//   物理7.8GBに対しコミットが20.2GBまで膨らみ、常駐5本（sync-public / before /
//   odds-live / status / auto-bet）が**まるごとディスクへ追い出された**。
//   プロセスは生きているのに動けず、サイトの更新が30分以上止まった。
//   19:11には watchdog が5本まとめて再起動している（＝全部死んだと判定した）。
//
//   watchdog も kesson も「止まったあと」に気づく仕組みで、
//   **止めないための仕組みが無かった**。それがこれ。
//
// ★時刻ではなく締切で判断する
//   開催は日によって違う。ナイターは23時近くまで続く（10/08は22:54が最終）。
//   番組表から「最初の締切の30分前〜最後の締切の30分後」を出して、その間は断る。
//
// ★夜間バッチ（02:00）は止めない
//   night2.sh の derive / predict は、レースが終わってから走るので時間帯で引っかからない。
//   メモリが少ないときも**警告だけで止めない**。本番の仕込みを止めるほうが害が大きい。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freemem, totalmem } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const p2 = (n) => String(n).padStart(2, '0')
const GB = 1073741824

/** その日の「レースのある時間帯」。番組表が無ければ null。 */
export function raceWindow(date) {
  const d = new Date()
  const today = date ?? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  let db
  try { db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true }) } catch { return null }
  db.exec('PRAGMA busy_timeout = 5000')
  const dl = []
  for (const t of ['race_meta', 'races']) {
    try {
      for (const r of db.prepare(`SELECT deadline FROM ${t} WHERE date=? AND deadline IS NOT NULL`).all(today))
        dl.push(r.deadline)
    } catch { /* その表がまだ無い */ }
  }
  db.close()
  if (!dl.length) return null
  dl.sort()
  const shift = (hhmm, min) => {
    const [h, m] = hhmm.split(':').map(Number)
    const t = Math.max(0, Math.min(24 * 60 - 1, h * 60 + m + min))
    return `${p2(Math.floor(t / 60))}:${p2(t % 60)}`
  }
  return { from: shift(dl[0], -30), to: shift(dl.at(-1), 30), first: dl[0], last: dl.at(-1) }
}

/**
 * レース中なら止める。`--force` があれば進む。
 * @param {string} name このスクリプトの名前（画面に出すだけ）
 * @param {{argv?:string[], minFreeGB?:number}} opt
 */
export function heavyGuard(name, opt = {}) {
  const argv = opt.argv ?? process.argv
  const force = argv.includes('--force')
  const d = new Date()
  const hhmm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const w = raceWindow()

  // ① レース中は断る
  if (w && hhmm >= w.from && hhmm <= w.to && !force) {
    console.error('')
    console.error(`★ ${name} は、いまは走らせません。`)
    console.error(`  きょうはレース中です（締切 ${w.first} 〜 ${w.last}／見張り ${w.from}〜${w.to}）。`)
    console.error('  重い処理を重ねると常駐がメモリから追い出され、**サイトの更新が止まります**。')
    console.error(`  いまは ${hhmm}。${w.to} を過ぎてから走らせてください。`)
    console.error('')
    console.error('  承知のうえで進めるなら --force を付けてください。')
    console.error('')
    process.exit(1)
  }

  // ② メモリが少ないときは警告だけ（止めない）
  const freeGB = freemem() / GB
  const min = opt.minFreeGB ?? 1.5
  if (freeGB < min) {
    console.error(`⚠ 空きメモリが ${freeGB.toFixed(1)}GB しかありません（搭載 ${(totalmem() / GB).toFixed(1)}GB）。`)
    console.error('  遅くなるか、途中で落ちることがあります。ほかの重い処理を閉じてください。')
  }
  if (force && w && hhmm >= w.from && hhmm <= w.to) {
    console.error(`⚠ --force でレース中に走らせています（${w.from}〜${w.to}）。サイトの更新が遅れます。`)
  }
}
