// Search Console と GA4 の書き出し（CSV）を読んで、次に何をすればいいかを出す。
//
//   Search Console →「検索パフォーマンス」→ 右上の「エクスポート」→「CSV をダウンロード」
//   → ZIP を展開して、中の CSV を gsc-export/ に入れる（クエリ.csv / ページ.csv / 国.csv …）
//
//   node scripts/seo-report.mjs              全部まとめて
//   node scripts/seo-report.mjs --queries    検索語だけ
//   node scripts/seo-report.mjs --pages      ページだけ
//
// 何を出すか（lcall で効いた見方をそのまま持ってきている）
//   ①あと少しで1ページ目（5〜20位）… 手を入れれば伸びるページ。いちばん先に直す
//   ②表示は多いのに押されない（CTRが低い）… 題と説明文の書き換えで伸びる
//   ③表示ゼロのページ … 検索に出ていない。中身が薄いか、まだ拾われていない
//   ④取りこぼしている検索語 … 表示はあるが順位が低い語
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'gsc-export')
const argv = process.argv.slice(2)
const only = (k) => argv.includes('--' + k)
const all = !argv.some((a) => a.startsWith('--'))

if (!existsSync(DIR)) {
  console.log(`gsc-export/ がありません。作って、Search Console の CSV を入れてください。
  Search Console →「検索パフォーマンス」→ 右上「エクスポート」→「CSV をダウンロード」→ ZIPを展開してこの中へ`)
  process.exit(1)
}

// ---------- CSV を読む（Search Console の日本語・英語どちらの見出しにも合わせる） ----------
function readCsv(file) {
  let t = readFileSync(file, 'utf8')
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
  const rows = []
  let cur = [''], q = false
  for (const ch of t.replace(/\r\n/g, '\n')) {
    if (q) { if (ch === '"') q = false; else cur[cur.length - 1] += ch }
    else if (ch === '"') q = true
    else if (ch === ',') cur.push('')
    else if (ch === '\n') { rows.push(cur); cur = [''] }
    else cur[cur.length - 1] += ch
  }
  if (cur.length > 1 || cur[0]) rows.push(cur)
  const head = rows.shift().map((h) => h.trim())
  const col = (...names) => head.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()))
  const iKey = 0
  const iImp = col('表示回数', 'Impressions')
  const iClk = col('クリック数', 'Clicks')
  const iCtr = col('CTR', 'クリック率', 'Site CTR')
  const iPos = col('掲載順位', 'Position', '平均掲載順位')
  const num = (v) => Number(String(v ?? '').replace(/[%,\s]/g, '')) || 0
  return rows.filter((r) => r[iKey]).map((r) => ({
    key: r[iKey], imp: num(r[iImp]), clicks: num(r[iClk]), ctr: num(r[iCtr]), pos: num(r[iPos]),
  }))
}
const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.csv'))
const pick = (...names) => {
  const f = files.find((x) => names.some((n) => x.includes(n)))
  return f ? readCsv(join(DIR, f)) : null
}
const queries = pick('クエリ', 'Queries', 'queries')
const pagesCsv = pick('ページ', 'Pages', 'pages')
const dates = pick('日付', 'Dates', 'dates')

const pct = (v) => v.toFixed(1) + '%'
const table = (rows, cols) => {
  const w = cols.map((c, i) => Math.max(c[0].length, ...rows.map((r) => String(r[i]).length)))
  const line = (a) => '  ' + a.map((v, i) => (cols[i][1] === 'r' ? String(v).padStart(w[i]) : String(v).padEnd(w[i]))).join('  ')
  console.log(line(cols.map((c) => c[0])))
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '))
  for (const r of rows) console.log(line(r))
}

// ---------- 全体 ----------
if (dates?.length) {
  const imp = dates.reduce((a, r) => a + r.imp, 0), clk = dates.reduce((a, r) => a + r.clicks, 0)
  console.log(`■ 全体（${dates.length}日ぶん）  表示 ${imp.toLocaleString()}回・クリック ${clk.toLocaleString()}回・CTR ${imp ? pct(clk / imp * 100) : '―'}`)
  const half = Math.floor(dates.length / 2)
  const sum = (a) => a.reduce((s, r) => s + r.clicks, 0)
  const sorted = [...dates].sort((a, b) => a.key.localeCompare(b.key))
  const older = sum(sorted.slice(0, half)), newer = sum(sorted.slice(half))
  console.log(`  前半${half}日 ${older}クリック → 後半${dates.length - half}日 ${newer}クリック（${newer >= older ? '増' : '減'}）`)
  console.log('')
}

// ---------- ① あと少しで1ページ目 ----------
if (all || only('pages') || only('queries')) {
  const near = (queries ?? []).filter((r) => r.pos >= 5 && r.pos <= 20 && r.imp >= 3)
    .sort((a, b) => b.imp - a.imp).slice(0, 15)
  console.log('■① あと少しで1ページ目の検索語（5〜20位）― ここに手を入れるのがいちばん効く')
  if (!near.length) console.log('  該当なし（まだデータが少ないか、順位が付いていません）')
  else table(near.map((r) => [r.key, r.imp, r.clicks, r.pos.toFixed(1) + '位', pct(r.ctr)]),
    [['検索語', 'l'], ['表示', 'r'], ['クリック', 'r'], ['順位', 'r'], ['CTR', 'r']])
  console.log('')
}

// ---------- ② 表示は多いのに押されない ----------
if (all || only('queries')) {
  const lowCtr = (queries ?? []).filter((r) => r.imp >= 20 && r.ctr < 2)
    .sort((a, b) => b.imp - a.imp).slice(0, 10)
  console.log('■② 表示は多いのに押されない（CTR 2%未満）― 題と説明文の書き換えで伸びる')
  if (!lowCtr.length) console.log('  該当なし')
  else table(lowCtr.map((r) => [r.key, r.imp, r.clicks, pct(r.ctr), r.pos.toFixed(1) + '位']),
    [['検索語', 'l'], ['表示', 'r'], ['クリック', 'r'], ['CTR', 'r'], ['順位', 'r']])
  console.log('')
}

// ---------- ③ 表示ゼロのページ ----------
if ((all || only('pages')) && pagesCsv) {
  const sm = join(ROOT, 'site', 'sitemap.xml')
  const known = existsSync(sm) ? [...readFileSync(sm, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]) : []
  const seen = new Set(pagesCsv.map((r) => r.key.replace(/\/$/, '')))
  const zero = known.filter((u) => !seen.has(u.replace(/\/$/, '')))
  console.log(`■③ sitemap に入れているのに検索に一度も出ていないページ：${zero.length} / ${known.length}`)
  const byKind = new Map()
  for (const u of zero) {
    const k = new URL(u).pathname.split('/')[1] || 'トップ'
    byKind.set(k, (byKind.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  /${k} … ${n}ページ`)
  console.log('')

  const top = [...pagesCsv].sort((a, b) => b.clicks - a.clicks).slice(0, 10)
  console.log('■ よく見られているページ')
  table(top.map((r) => [new URL(r.key).pathname, r.imp, r.clicks, pct(r.ctr), r.pos.toFixed(1) + '位']),
    [['ページ', 'l'], ['表示', 'r'], ['クリック', 'r'], ['CTR', 'r'], ['順位', 'r']])
  console.log('')
}

// ---------- ④ 取りこぼし ----------
if (all || only('queries')) {
  const far = (queries ?? []).filter((r) => r.pos > 20 && r.imp >= 10).sort((a, b) => b.imp - a.imp).slice(0, 10)
  console.log('■④ 表示はあるが遠い（21位以下）― この語の記事がまだ無いか、薄い')
  if (!far.length) console.log('  該当なし')
  else table(far.map((r) => [r.key, r.imp, r.pos.toFixed(1) + '位']), [['検索語', 'l'], ['表示', 'r'], ['順位', 'r']])
}
