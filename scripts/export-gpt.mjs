// GPTに渡す資料（GPT用フォルダ）の見本データを、その日の本物のデータから書き出す。
//
//   node scripts/export-gpt.mjs                今日のデータで書き出し、GPT用.zip も作り直す
//   node scripts/export-gpt.mjs --date 2026-09-22
//
// ★やること
//   ・API仕様.md を GPT用/01_API仕様.md に写す（仕様の正は競艇予想フォルダ直下のほう）
//   ・data/ に各エンドポイントの見本を書く。レース詳細・選手・場は、2点プランのあるレースから1つ選ぶ
//   ・説明書（00/02/03）は手で書いたものなので、ここでは触らない
// ★見本は「形を見せるため」のもの。記事やページの数字は、必ずその日のURLから取り直させること。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { apiRoute } from './api.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'GPT用')
const DATA = join(OUT, 'data')
const argv = process.argv.slice(2)
const i = argv.indexOf('--date')
const DATE = i > -1 ? argv[i + 1] : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)

// api.mjs は HTTP の応答に書く作りなので、受け皿を用意して中身だけ受け取る
function call(path) {
  let body = null, code = 0
  const res = { writeHead: (c) => { code = c }, end: (b) => { body = b } }
  apiRoute(new URL(path, 'http://x'), res)
  if (code !== 200) throw new Error(`${path} → ${code} ${body}`)
  return JSON.parse(body)
}

rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
const save = (name, obj) => { writeFileSync(join(DATA, name), JSON.stringify(obj, null, 1)); console.log(`  data/${name}`) }

console.log(`=== GPT用の見本データ（${DATE}）===`)
const races = call(`/api/v1/races?date=${DATE}`)
if (races.status !== 'ok') { console.error(`${DATE} のレースがありません。予想の生成後にもう一度`); process.exit(1) }
save('見本_レース一覧_races.json', races)
const picks = call(`/api/v1/picks?date=${DATE}`)
save('見本_買い目_picks【有料】.json', picks)
save('見本_展開予想_tenkai.json', call(`/api/v1/tenkai?date=${DATE}`))
save('見本_実績_results.json', call(`/api/v1/results?days=30`))

// レース詳細は、2点プランがあるレースのうち締切がいちばん遅いものを選ぶ（締切前の形を見せたい）
const withPlan = picks.races.filter((r) => r.plan2).sort((a, b) => String(b.deadline).localeCompare(String(a.deadline)))
const featured = withPlan[0]?.race_id ?? races.races[0].race_id
const race = call(`/api/v1/race?id=${featured}`)
save('見本_レース詳細_race.json', race)
const r1 = race.race.entries?.[0]?.racer_id
if (r1) save('見本_選手_racer.json', call(`/api/v1/racer?id=${r1}`))
save('見本_場_venue.json', call(`/api/v1/venue?jcd=${race.race.jcd}`))

// note記事用の /plan2.json は status.mjs 側にあるので、動いているサーバーから取る
try {
  const j = await (await fetch(`http://localhost:3940/plan2.json?date=${DATE}`, { signal: AbortSignal.timeout(20_000) })).json()
  save('見本_note記事用_plan2【有料】.json', j)
} catch (e) {
  console.log(`  ⚠ plan2.json を取れませんでした（確認用サーバーが止まっている？）: ${e.message}`)
}

copyFileSync(join(ROOT, 'API仕様.md'), join(OUT, '01_API仕様.md'))
console.log('  01_API仕様.md（API仕様.md を写した）')
writeFileSync(join(DATA, '_この見本について.txt'),
  `このフォルダのJSONは ${DATE} 時点の本物のデータの写しです（形を確かめるための見本）。\n` +
  `記事やページに載せる数字は、必ずその日のURLから取り直してください。\n` +
  `【有料】の付いたファイルは noteで販売している買い目です。無料で公開しないでください。\n` +
  `レース詳細の見本: ${featured}（${race.race.venue}${race.race.race_no}R）\n`)

// まとめて渡せるように zip にする。
// ⚠ PowerShell 5.1 の Compress-Archive はフォルダの区切りを「\」で書く。GPT側（Linux）で展開すると
//   「data\見本…」という名前のファイルに潰れるので、区切りを「/」にして1件ずつ入れる。
const zip = join(ROOT, 'GPT用.zip')
if (existsSync(zip)) rmSync(zip)
const ps = [
  'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
  `$src = '${OUT}'`, `$z = [IO.Compression.ZipFile]::Open('${zip}', 'Create')`,
  'Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {',
  '  $rel = $_.FullName.Substring($src.Length + 1).Replace([char]92, [char]47)',
  '  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $rel) }',
  '$z.Dispose()',
].join('\n')
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
console.log(`\n→ ${zip}`)
