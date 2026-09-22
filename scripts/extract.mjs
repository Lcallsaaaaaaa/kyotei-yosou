// data/raw/{K,B}/*.lzh を 7-Zip で data/extracted/{K,B}/*.TXT に展開する。
// 展開済みのものは飛ばすので、何度実行しても安全。

import { mkdir, readdir, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SEVENZIP = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
]

async function find7z() {
  for (const p of SEVENZIP) {
    try {
      await stat(p)
      return p
    } catch {}
  }
  throw new Error(
    '7-Zip が見つかりません。`winget install --id 7zip.7zip --exact --silent` で入れてください。'
  )
}

async function exists(p) {
  try {
    return (await stat(p)).size > 0
  } catch {
    return false
  }
}

async function main() {
  const sevenZip = await find7z()
  console.log(`7-Zip: ${sevenZip}\n`)

  for (const kind of ['K', 'B']) {
    const srcDir = join(ROOT, 'data', 'raw', kind)
    const outDir = join(ROOT, 'data', 'extracted', kind)
    await mkdir(outDir, { recursive: true })

    let files
    try {
      files = (await readdir(srcDir)).filter((f) => f.toLowerCase().endsWith('.lzh')).sort()
    } catch {
      console.log(`${kind}: data/raw/${kind} が無いので飛ばします`)
      continue
    }

    let ok = 0
    let skip = 0
    let fail = 0
    for (const f of files) {
      // k260816.lzh -> K260816.TXT
      const outName = basename(f, '.lzh').toUpperCase() + '.TXT'
      if (await exists(join(outDir, outName))) {
        skip++
        continue
      }
      try {
        await run(sevenZip, ['x', join(srcDir, f), `-o${outDir}`, '-y'], { windowsHide: true })
        ok++
      } catch (e) {
        fail++
        console.error(`  展開失敗 ${f}: ${e.message.split('\n')[0]}`)
      }
      if ((ok + skip + fail) % 50 === 0) {
        console.log(`  ${kind}: ${ok + skip + fail}/${files.length}`)
      }
    }
    console.log(`${kind}: 展開${ok} / 既存${skip} / 失敗${fail}  (対象${files.length})`)
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
