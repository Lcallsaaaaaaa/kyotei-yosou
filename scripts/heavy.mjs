// 「いま重い処理が走っているか」を1か所で判断する。
//
//   import { heavyRunning } from './heavy.mjs'
//   node scripts/heavy.mjs      いま何が走っているか見る
//
// ★なぜ1か所にまとめるか（2026-10-20）
//   この機械はRAMが7.8GBしかない。derive や model5 は1本で4〜8GBを要求するので、
//   2本重なると食い合って**両方死ぬ**。だから重い処理を起こす係
//   （ensure-day.mjs・retrain-needed.mjs）は必ずここを通して確かめる。
//   判定を各所にコピーすると、片方だけ直して食い違う。
//
// ★chokuzen を数えないこと（2026-10-20に踏んだ）
//   直前予想の差し替え（chokuzen）は **レース中5分ごとに predict.mjs を回す**。
//   これを「夜のバッチ中」と数えると、昼間はいつも「混んでいる」ことになり、
//   直す係も再学習も永久に動けなくなる。chokuzen は短時間で終わる軽い常連なので外す。
import { execFileSync } from 'node:child_process'

/** 夜のバッチの重い処理が走っているか。見られないときは false（止まるより動かす） */
export function heavyRunning() {
  for (const l of heavyList()) if (l) return true
  return false
}

/** 走っている重い処理のコマンドラインを返す（空配列＝走っていない） */
export function heavyList() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
      // ⚠ grade.mjs と catchup も数える（2026-10-22に足した）。
      //   復旧の手順は grade → derive → addbefore → predict と続くが、grade の数秒間と
      //   各段の切れ目は derive 系が1本も見えない。そこへ30分ごとのタスクが入ると
      //   **derive が二重に走って7.8GBの機械が共倒れする**。入口から数えて塞ぐ。
      `Where-Object { $_.CommandLine -match 'derive|addbefore|model5\\.mjs|grade\\.mjs|catchup-today' -or ` +
      `($_.CommandLine -match 'predict\\.mjs' -and $_.CommandLine -notmatch 'chokuzen') } | ` +
      `ForEach-Object { $_.CommandLine }`],
      { encoding: 'utf8', timeout: 30000 })
    return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const l = heavyList()
  // ★終了コードでも答える（2026-11-12）。
  //   走っている=1 / 走っていない=0。.sh から `if node scripts/heavy.mjs --quiet` で
  //   判定できるようにするため。night2.sh が何も確認せず derive を始めて、
  //   同時刻の ensure-day と共倒れするのを防ぐ。
  //   --quiet は中身を出さず、終了コードだけ返す。
  process.exitCode = l.length ? 1 : 0
  if (process.argv.includes('--quiet')) { /* 何も出さない */ }
  else if (!l.length) console.log('重い処理は走っていません')
  else { console.log(`重い処理 ${l.length}本:`); for (const c of l) console.log('  ' + c.slice(0, 120)) }
}
