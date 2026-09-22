// 日和の遮断が解けるのを待ってから収集を始める。
//   node scripts/biyori-wait.mjs --from 2025-08-18 --to 2026-08-18
// 5分おきに疎通を試し、通ったら biyori.mjs を安全な設定（同時1本）で起動する。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const f = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const alive = async () => {
  try {
    const r = await fetch('https://kyoteibiyori.com/race_shusso.php?place_no=16&race_no=12&hiduke=20260817&slider=0', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(20_000),
    })
    return r.ok && /CSRF_TOKEN/.test(await r.text())
  } catch { return false }
}

for (let i = 1; ; i++) {
  if (await alive()) { console.log(`[${new Date().toLocaleTimeString('ja-JP')}] 復帰を確認。収集を開始します`); break }
  console.log(`[${new Date().toLocaleTimeString('ja-JP')}] まだ遮断中（${i}回目）。5分後に再試行`)
  await sleep(300_000)
}
const p = spawn(process.execPath, [join(ROOT, 'scripts', 'biyori.mjs'),
  '--from', f('from', '2025-08-18'), '--to', f('to', '2026-08-18'),
  '--conc', f('conc', '1'), '--delay', f('delay', '1200')],
  { cwd: ROOT, stdio: 'inherit' })
p.on('exit', (c) => process.exit(c ?? 0))
