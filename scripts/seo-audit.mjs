// 検索まわりの点検。デプロイ前にこれを通す。
//
//   node scripts/seo-audit.mjs           手元の site/ を点検
//   node scripts/seo-audit.mjs --live    公開中のサイトを実際に取りに行って点検（siteUrl が要る）
//
// 見るところ
//   ① URL が実パスになっているか（#/ が残っていると検索エンジンからは1ページにしか見えない）
//   ② sitemap.xml と robots.txt があり、中身が正しいか
//   ③ 全ページで題と説明文が変わるか（meta() を通っているか）
//   ④ canonical・OGP・構造化データが入るか
//   ⑤ どのURLで来ても画面が出るか（_redirects）
//   ⑥ GA4 の測定IDが入っているか
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'site')
const LIVE = process.argv.includes('--live')
let err = 0, warn = 0
const NG = (...a) => { err++; console.log('  ✗', ...a) }
const WA = (...a) => { warn++; console.log('  △', ...a) }
const OK = (...a) => console.log('  ✓', ...a)

const cfg = (() => { const w = {}; new Function('window', readFileSync(join(SITE, 'config.js'), 'utf8'))(w); return w.NAGI ?? {} })()
const app = readFileSync(join(SITE, 'app.js'), 'utf8')
const html = readFileSync(join(SITE, 'index.html'), 'utf8')

console.log('■ URLの作り')
const hashLinks = (app.match(/href="#\//g) ?? []).length + (html.match(/href="#\//g) ?? []).length
if (hashLinks) NG(`ハッシュのリンクが ${hashLinks}件 残っている（検索エンジンからは1ページにしか見えない）`)
else OK('リンクは実パス')
if (!/location\.pathname/.test(app)) NG('振り分けが location.pathname を見ていない')
else OK('振り分けは実パスを見ている')
if (existsSync(join(SITE, '_redirects'))) OK('_redirects あり（どのURLで来ても画面が出る）')
else NG('_redirects が無い。/race/… を直接開くと404になる')

console.log('■ sitemap と robots')
if (!cfg.siteUrl) NG('site/config.js の siteUrl が空。canonical・OGP・sitemap が作れない')
else OK(`siteUrl = ${cfg.siteUrl}`)
const sm = join(SITE, 'sitemap.xml')
if (!existsSync(sm)) (cfg.siteUrl ? NG : WA)('sitemap.xml が無い（node scripts/sync-public.mjs --local で作られる）')
else {
  const x = readFileSync(sm, 'utf8')
  const locs = [...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  OK(`sitemap.xml に ${locs.length} ページ`)
  if (cfg.siteUrl && locs.some((u) => !u.startsWith(cfg.siteUrl))) NG('sitemap に siteUrl と違うURLが混ざっている')
  if (locs.some((u) => u.includes('#'))) NG('sitemap にハッシュ付きのURLが混ざっている')
  if (new Set(locs).size !== locs.length) NG('sitemap に同じURLが重複している')
}
const rb = join(SITE, 'robots.txt')
if (!existsSync(rb)) NG('robots.txt が無い')
else {
  const r = readFileSync(rb, 'utf8')
  if (/^Disallow: \/$/m.test(r)) WA('robots.txt が「全部見に来ないで」のまま（siteUrl を入れると直ります）')
  else if (!/Sitemap:/.test(r)) NG('robots.txt に Sitemap の行が無い')
  else OK('robots.txt に Sitemap の行あり')
}

console.log('■ ページごとの題と説明文')
const metaCalls = (app.match(/\n\s+meta\(/g) ?? []).length
const pages = (app.match(/\n  async function \w+\(/g) ?? []).length
if (metaCalls < 10) NG(`meta() の呼び出しが ${metaCalls}件しかない（ページごとに題が変わらない）`)
else OK(`meta() の呼び出し ${metaCalls}件 / 画面 ${pages}個`)
for (const [name, re] of [['canonical', /link\[rel="canonical"\]/], ['OGP', /og:title/],
  ['構造化データ', /application\/ld\+json/], ['twitter card', /twitter:card/]])
  if (re.test(app)) OK(`${name} を出している`); else NG(`${name} を出していない`)

console.log('■ アクセス解析')
if (!cfg.gaId) WA('config.js の gaId が空（GA4 を読み込まない）')
else if (!/^G-[A-Z0-9]{6,}$/.test(cfg.gaId)) NG(`gaId の形がおかしい：${cfg.gaId}`)
else OK(`GA4 ${cfg.gaId}`)
if (/send_page_view: false/.test(app) && /page_view/.test(app)) OK('URLが変わるたびに1ページとして数える')
else NG('画面の中でページが変わったときに数えられていない')
for (const ev of ['member_click', 'member_unlock'])
  if (app.includes(`'${ev}'`)) OK(`イベント ${ev} を送る`); else WA(`イベント ${ev} が無い`)

if (LIVE) {
  console.log('■ 公開中のサイト')
  if (!cfg.siteUrl) NG('siteUrl が無いので確認できません')
  else for (const p of ['/robots.txt', '/sitemap.xml', '/', '/venue/12']) {
    try {
      const r = await fetch(cfg.siteUrl + p, { redirect: 'follow' })
      r.ok ? OK(`${p} → ${r.status}`) : NG(`${p} → ${r.status}`)
    } catch (e) { NG(`${p} → ${e.message}`) }
  }
}

console.log(`\n${err ? `★ 直すところ ${err}件` : '✓ 直すところはありません'}${warn ? `／気になるところ ${warn}件` : ''}`)
process.exit(err ? 1 : 0)
