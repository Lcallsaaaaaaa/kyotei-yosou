// CSSの波かっこが合っているかを確かめる。
//
//   node scripts/css-check.mjs
//
// ★なぜ要るか（2026-10-06）
//   site/core.css の `@media (max-width: 719px) {` が**閉じていなかった**。
//   CSSは閉じかっこが無くてもエラーにならず、ファイルの最後で勝手に閉じる。
//   その結果、**そこから下に書いたものが全部「719px以下のときだけ効く」**
//   状態になっていた。
//
//   出方がいやらしい：スマホでは直っているのにパソコンでは直らない。
//   「キャッシュだろう」と思って何度も公開し直すことになる（実際にそうなった）。
//   枠線ボタンの文字色・アラートの件数帯・買い方の型が、全部これで効いていなかった。
//
//   追記していく作りのファイル（core.css は style.css の後に読む上書き用）では
//   いつでも起こりうるので、公開前に必ず通す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['site/style.css', 'site/core.css']

let ng = 0
for (const rel of FILES) {
  const f = join(ROOT, rel)
  if (!existsSync(f)) { console.log(`  ― ${rel} はありません`); continue }
  const s = readFileSync(f, 'utf8')
  // コメントと文字列を外してから数える（中の { } を数えないため）
  const body = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  let depth = 0, line = 1, extra = null
  const opens = []
  for (const ch of body) {
    if (ch === '\n') line++
    else if (ch === '{') { depth++; opens.push(line) }
    else if (ch === '}') { depth--; opens.pop(); if (depth < 0 && extra == null) extra = line }
  }
  if (depth === 0 && extra == null) { console.log(`  ✓ ${rel}　波かっこは合っています`); continue }
  ng++
  if (depth > 0) {
    // どの行の { が閉じていないか。コメントを外した後の行番号なので目安として出す
    console.log(`  ✗ ${rel}　閉じかっこが ${depth}個 足りません`)
    console.log(`     閉じていない { のある行（コメントを外した後の行番号・目安）: ${opens.join(', ')}`)
    console.log('     ⚠ これより下に書いたものは、直前の @media の中に入ってしまいます')
  }
  if (extra != null) console.log(`  ✗ ${rel}　余分な } が ${extra}行目あたりにあります`)
}

console.log('')
if (ng) { console.log('★ 直すまで公開しないこと'); process.exitCode = 1 }
else console.log('✓ 問題ありません')
