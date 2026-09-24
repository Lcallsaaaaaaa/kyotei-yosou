// Cloudflare Pages へ公開する。
//
//   node scripts/deploy.mjs            build/ を組み立てて公開する
//   node scripts/deploy.mjs --build    組み立てるだけ（中身を確かめたいとき）
//
// ★なぜ build/ を別に作るのか
//   site/ には確認用のデータ site/_local/（44MB・2,400件）が入っている。
//   これは R2 に同じものがあるので載せる必要がなく、載せると公開の容量と時間を無駄にする。
//   そこで「載せるものだけ」を build/ に集めてから渡す。
//
// ★取り違え防止
//   このアカウントには lcall / lcall-calltest という別事業の Pages がある。
//   プロジェクト名は data/cloudflare.json の pagesProject を使い、**必ず明示**する。
//   kyotei- で始まらない名前だったら、実行せずに止める。
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'site')
const BUILD = join(ROOT, 'build')
const argv = process.argv.slice(2)

// 載せないもの
const SKIP = new Set(['_local', 'デザイン変更の決まり.md', 'GPTへの指示.txt'])

function build() {
  rmSync(BUILD, { recursive: true, force: true })
  mkdirSync(BUILD, { recursive: true })
  for (const name of readdirSync(SITE)) {
    if (SKIP.has(name)) continue
    cpSync(join(SITE, name), join(BUILD, name), { recursive: true })
  }
  let files = 0, bytes = 0
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n), s = statSync(p)
      if (s.isDirectory()) walk(p); else { files++; bytes += s.size }
    }
  }
  walk(BUILD)
  return { files, mb: (bytes / 1048576).toFixed(1) }
}

const { files, mb } = build()
console.log(`build/ を組み立てました：${files}ファイル・${mb}MB`)
if (files > 19000) console.log('⚠ Cloudflare Pages の上限は1回20,000ファイルです。近づいています')
if (argv.includes('--build')) process.exit(0)

const cfgF = join(ROOT, 'data', 'cloudflare.json')
if (!existsSync(cfgF)) { console.error('data/cloudflare.json がありません'); process.exit(1) }
const cfg = JSON.parse(readFileSync(cfgF, 'utf8'))
const project = cfg.pagesProject
if (!project?.startsWith('kyotei-')) {
  console.error(`✗ pagesProject が「${project}」です。kyotei- で始まる名前でないと、別事業のサイトを上書きする恐れがあるため実行しません`)
  process.exit(1)
}

console.log(`Cloudflare Pages「${project}」へ公開します…`)
// ⚠ build/ の中で「.」を渡す。wrangler は functions/ を**カレントディレクトリ基準**で探すので、
//    外から build を指定すると 競艇予想/functions を見に行ってしまい、
//    Pages Functions が組み込まれないまま公開される（2026-09-24に実際にそうなった）。
//    そのときは /data/… がSPAにのみ込まれ、データが一切読めない。
execFileSync('npx', ['--yes', 'wrangler@latest', 'pages', 'deploy', '.',
  '--project-name', project, '--branch', 'main', '--commit-dirty=true'], {
  cwd: BUILD,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CLOUDFLARE_API_TOKEN: cfg.apiToken, CLOUDFLARE_ACCOUNT_ID: cfg.accountId },
})
