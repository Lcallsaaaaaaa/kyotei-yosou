// ページごとの静的HTMLを書き出す。
//
//   node scripts/sync-public.mjs --local      先にデータを作る（site/_local）
//   node scripts/prerender.mjs                その中身からHTMLを書き出す
//
// ★なぜ要るのか（2026-09-23）
//   この画面はJavaScriptで組み立てている。**SNS（X・LINE・Facebook）のクローラーは
//   JavaScriptを一切実行しない**ので、どのページのURLを貼っても index.html のまま＝
//   全部おなじ題・おなじ説明・おなじ画像になってしまう。
//   Googleは実行してくれるが、2,000ページあると拾われ終わるまで数ヶ月かかる。
//   そこで「題・説明・OGP・構造化データ＋本文の要点」を埋めたHTMLをURLごとに置く。
//   開いたあとは今までどおりJavaScriptが中身を描き直すので、見た目は変わらない。
//
// ★置き方
//   /race/20260923-02-08 → site/race/20260923-02-08/index.html
//   Netlify も Cloudflare Pages も「実在するファイルが _redirects より先」なので、
//   このファイルがあればそれが返り、無ければ今までどおり index.html（SPA）になる。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'site')
const LOCAL = join(SITE, '_local')
const VENUES = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国', 'びわこ', '住之江',
  '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

if (!existsSync(LOCAL)) { console.error('site/_local がありません。先に node scripts/sync-public.mjs --local'); process.exit(1) }
const cfg = (() => { const w = {}; new Function('window', readFileSync(join(SITE, 'config.js'), 'utf8'))(w); return w.NAGI ?? {} })()
const BASE = (cfg.siteUrl || '').replace(/\/+$/, '')
const SITE_NAME = cfg.siteName || 'ボートレース研究所'
const shell = readFileSync(join(SITE, 'index.html'), 'utf8')

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const doc = (key) => {
  const f = join(LOCAL, key.replaceAll('/', '__') + '.json')
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null } catch { return null }
}
const md = (d) => { const [, m, dd] = String(d).split('-'); return `${Number(m)}/${Number(dd)}` }
const pct = (v) => (v == null ? '―' : Number(v).toFixed(1) + '%')
const num = (v, d = 2) => (v == null ? '―' : Number(v).toFixed(d))

// ---------- HTMLの外枠を差し替える ----------
function page({ path, title, desc, body, ld, article }) {
  const full = title.startsWith(SITE_NAME) ? title : `${title}｜${SITE_NAME}`
  const url = BASE + path
  let h = shell
  h = h.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(full)}</title>`)
  h = h.replace(/<meta name="description" content="[\s\S]*?">/, `<meta name="description" content="${esc(desc)}">`)
  h = h.replace(/<meta property="og:title" content="[\s\S]*?">/, `<meta property="og:title" content="${esc(full)}">`)
  h = h.replace(/<meta property="og:description" content="[\s\S]*?">/, `<meta property="og:description" content="${esc(desc)}">`)
  h = h.replace(/<meta property="og:type" content="[\s\S]*?">/, `<meta property="og:type" content="${article ? 'article' : 'website'}">`)
  const head = [
    BASE ? `<link rel="canonical" href="${esc(url)}">` : '',
    BASE ? `<meta property="og:url" content="${esc(url)}">` : '',
    ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : '',
  ].filter(Boolean).join('\n')
  h = h.replace('</head>', head + '\n</head>')
  // 本文。JavaScriptが動いたらここは描き直される
  h = h.replace(/<main id="app" tabindex="-1">[\s\S]*?<\/main>/, `<main id="app" tabindex="-1">${body}</main>`)
  return h
}

let written = 0
const wrote = new Set()
function out(path, html) {
  const rel = path === '/' ? 'index.html' : join(path.replace(/^\//, ''), 'index.html')
  const f = join(SITE, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, html)
  wrote.add(rel.replaceAll('\\', '/'))
  written++
}

// ---------- 各ページ ----------
const meta = doc('meta')
const dates = meta?.dates ?? []
const today = dates.at(-1) ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)

// トップ・日付ごとの出走表
for (const d of dates) {
  const j = doc(`races/${d}`)
  if (!j?.races?.length) continue
  const byV = new Map()
  for (const r of j.races) { if (!byV.has(r.jcd)) byV.set(r.jcd, []); byV.get(r.jcd).push(r) }
  const isToday = d === today
  const body = `<h1>${isToday ? esc(SITE_NAME) : `${md(d)}の出走表`}</h1>
    <p>${md(d)}は全国${byV.size}場で${j.races.length}レースが行われます。締切時刻・選手の成績・モーター・直前情報と、AIの1着確率をまとめています。</p>
    ${[...byV].sort((a, b) => a[0] - b[0]).map(([jcd, rs]) => `<section><h2>${esc(VENUES[jcd])}</h2><p>${
      rs.sort((a, b) => a.race_no - b.race_no).map((r) => `<a href="/race/${esc(r.race_id)}">${r.race_no}R ${esc(r.deadline ?? '')}</a>`).join(' ')}</p></section>`).join('')}
    <p><a href="/tenkai">展開予想</a>　<a href="/venues">場情報・攻略</a>　<a href="/racers">選手</a>　<a href="/results">的中実績</a></p>`
  out(isToday ? '/' : `/d/${d}`, page({
    path: isToday ? '/' : `/d/${d}`,
    title: isToday ? `${SITE_NAME}｜競艇の出走表・展開予想・データ` : `${md(d)}の出走表 全国${byV.size}場${j.races.length}レース`,
    desc: isToday
      ? `全国24場の出走表・直前情報・オッズ・結果と、AIの1着確率。場ごとの攻略、選手データ、データ分析も公開。きょうは${byV.size}場${j.races.length}レース。`
      : `${d.replaceAll('-', '/')}の全国${byV.size}場${j.races.length}レースの出走表。締切時刻・選手の成績・モーター・直前情報とAIの1着確率。`,
    body,
  }))
}

// レース
for (const f of readdirSync(LOCAL)) {
  if (!f.startsWith('race__')) continue
  const j = JSON.parse(readFileSync(join(LOCAL, f), 'utf8'))
  const R = j?.race
  if (!R) continue
  const E = R.entries ?? []
  const rows = E.map((e) => `<tr><td>${e.lane}</td><td>${esc(e.name)}</td><td>${esc(e.class ?? '')}</td>
    <td>${num(e.win_rate_national)}</td><td>${pct(e.top2_rate_national)}</td><td>${pct(e.top3_rate_national)}</td>
    <td>${e.motor_no ?? '―'}</td><td>${num(e.avg_st)}</td></tr>`).join('')
  const body = `<h1>${esc(R.venue)} ${R.race_no}R</h1>
    <p>${R.date.replaceAll('-', '/')}・締切 ${esc(R.deadline ?? '―')}${R.title ? `・${esc(R.title)}` : ''}${R.series ? `（${esc(R.series)}）` : ''}</p>
    <table><caption>出走表</caption><thead><tr><th>枠</th><th>選手</th><th>級別</th><th>全国勝率</th><th>2連対率</th><th>3連対率</th><th>モーター</th><th>平均ST</th></tr></thead><tbody>${rows}</tbody></table>
    ${R.result?.order ? `<p>結果：${esc(R.result.order_all ?? R.result.order)}（${esc(R.result.kimarite ?? '')}）　3連単 ${R.result.trifecta_payout?.toLocaleString() ?? '―'}円</p>` : ''}
    <p><a href="/venue/${R.jcd}">${esc(R.venue)}の攻略</a>　<a href="/d/${esc(R.date)}">${md(R.date)}の出走表</a></p>`
  out(`/race/${R.race_id}`, page({
    path: `/race/${R.race_id}`,
    title: `${R.venue}${R.race_no}R ${md(R.date)} 出走表と予想`,
    desc: `${R.venue}${R.race_no}R（${R.date.replaceAll('-', '/')}・締切${R.deadline ?? '―'}）の出走表。${E.map((e) => e.name).slice(0, 3).join('・')}ほか。勝率・モーター・平均ST・直前情報とAIの1着確率。`,
    body,
    ld: { '@context': 'https://schema.org', '@type': 'SportsEvent', name: `${R.venue}${R.race_no}R`,
      startDate: R.deadline ? `${R.date}T${R.deadline}:00+09:00` : R.date, sport: '競艇',
      location: { '@type': 'Place', name: `ボートレース${R.venue}` },
      competitor: E.map((e) => ({ '@type': 'Person', name: e.name })) },
  }))
}

// 選手
for (const f of readdirSync(LOCAL)) {
  if (!f.startsWith('racer__')) continue
  const P = JSON.parse(readFileSync(join(LOCAL, f), 'utf8'))?.racer
  if (!P?.name) continue
  const c1 = (P.by_course ?? []).find((c) => c.course === 1)
  const body = `<h1>${esc(P.name)}</h1>
    <p>登番 ${P.racer_id}${P.branch ? `・${esc(P.branch)}支部` : ''}${P.class ? `・${esc(P.class)}` : ''}${P.age ? `・${P.age}歳` : ''}</p>
    ${P.summary_1y ? `<p>直近1年：${P.summary_1y.starts}走・1着率 ${pct(P.summary_1y.win_rate)}・2連対率 ${pct(P.summary_1y.top2_rate)}・3連対率 ${pct(P.summary_1y.top3_rate)}・平均ST ${num(P.summary_1y.avg_st)}</p>` : ''}
    ${c1 ? `<p>1コースでの成績：${c1.starts}走・1着率 ${pct(c1.win_rate)}</p>` : ''}
    ${(P.by_course ?? []).length ? `<table><caption>コース別成績（直近1年）</caption><thead><tr><th>コース</th><th>出走</th><th>1着率</th><th>2連対率</th><th>3連対率</th></tr></thead><tbody>${
      P.by_course.map((c) => `<tr><td>${c.course}</td><td>${c.starts}</td><td>${pct(c.win_rate)}</td><td>${pct(c.top2_rate)}</td><td>${pct(c.top3_rate)}</td></tr>`).join('')}</tbody></table>` : ''}
    <p><a href="/racers">選手一覧</a></p>`
  out(`/racer/${P.racer_id}`, page({
    path: `/racer/${P.racer_id}`,
    title: `${P.name}（${P.racer_id}）の成績データ`,
    desc: `競艇選手 ${P.name}（登番${P.racer_id}・${P.branch ?? ''}・${P.class ?? ''}）の勝率・コース別成績・平均ST・場別の成績・直近の出走をまとめています。`,
    body,
    ld: { '@context': 'https://schema.org', '@type': 'Person', name: P.name, identifier: String(P.racer_id),
      jobTitle: '競艇選手', affiliation: P.branch ?? undefined },
  }))
}

// 場（攻略）
for (let jcd = 1; jcd <= 24; jcd++) {
  const G = doc(`guide/${jcd}`), V = doc(`venue/${jcd}`)?.venue
  if (!G && !V) continue
  const name = G?.venue ?? V?.venue ?? VENUES[jcd]
  const body = `<h1>${esc(name)}の攻略</h1>
    ${G?.points?.length ? `<ul>${G.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${G?.points_note ? `<p>${esc(G.points_note)}</p>` : ''}
    ${G?.manual?.html ?? ''}
    <p><a href="/venues">ほかの場を見る</a></p>`
  out(`/venue/${jcd}`, page({
    path: `/venue/${jcd}`,
    title: `ボートレース${name}の攻略とデータ`,
    desc: `ボートレース${name}の1コース1着率・コース別の決まり手・波や風での変わり方・当地で強い選手を、直近1年の実測からまとめた攻略ページです。`,
    body,
  }))
}

// ニュース記事
const news = doc('news/index')?.articles ?? []
for (const n of news) {
  const a = doc(`news/${n.slug}`)
  if (!a?.html) continue
  out(`/news/${a.slug}`, page({
    path: `/news/${a.slug}`,
    title: a.title,
    desc: (a.summary ?? a.title).slice(0, 110),
    article: true,
    body: `<article><h1>${esc(a.title)}</h1>${a.date ? `<p>${esc(a.date)}</p>` : ''}${a.html}<p><a href="/news">ニュース一覧</a></p></article>`,
    ld: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: a.title,
      datePublished: a.date ?? undefined, dateModified: a.date ?? undefined,
      publisher: { '@type': 'Organization', name: SITE_NAME } },
  }))
}

// 固定ページ
for (const slug of ['about', 'privacy']) {
  const p = doc(`page/${slug}`)
  if (!p?.html) continue
  out(`/${slug}`, page({ path: `/${slug}`, title: p.title, desc: p.description ?? p.title,
    body: `<article><h1>${esc(p.title)}</h1>${p.html}</article>` }))
}

// 一覧・そのほか（中身は軽いが、題と説明だけでも入れておく）
const listPages = [
  ['/tenkai', '展開予想', '全レースの展開予想。本線・対抗と、逃げ／差し／まくりの決まり手の確率を、直近1年の実測から出しています。'],
  ['/news', '競艇ニュース', '前日の優勝戦・高配当ランキング・今日の開催・グレードレースの予告など、競艇のニュースをデータからまとめています。'],
  ['/venues', 'ボートレース場一覧', '全国24か所のボートレース場の特徴・コース別成績・攻略の要点をまとめています。'],
  ['/racers', '競艇選手一覧', '直近180日に出走した競艇選手の一覧です。名前や登番から、勝率・コース別成績・平均STを調べられます。'],
  ['/racers/all', '競艇選手 全一覧', '直近180日に出走した競艇選手を、支部ごと・五十音順に並べています。'],
  ['/schedule', 'ボートレース開催予定', '全国24場の開催予定と、SG・G1・G2・G3のグレードレースの日程・出場予定選手をまとめています。'],
  ['/results', '的中実績', '過去30日の的中率と回収率です。締切前に出した予想だけを、外れた日も含めて集計しています。'],
  ['/member', '会員（月額300円）', '月額300円の会員になると、全レースの展開予想とAI予想（3連複2点プラン）、各レースの1着確率がご覧いただけます。'],
  ['/analysis/average', 'コース別平均｜競艇データ分析', '競艇のコース別平均。全国24場の直近1年の実測データから集計しています。'],
  ['/analysis/ranking', 'コース別ランキング｜競艇データ分析', '競艇のコース別ランキング。全国24場の直近1年の実測データから集計しています。'],
  ['/analysis/demoku', '出目分析｜競艇データ分析', '競艇の出目分析。全国24場の直近1年の実測データから集計しています。'],
  ['/analysis/yusho', '優勝戦｜競艇データ分析', '競艇の優勝戦。全国24場の直近1年の実測データから集計しています。'],
]
for (const [path, title, desc] of listPages)
  out(path, page({ path, title, desc, body: `<h1>${esc(title.split('｜')[0])}</h1><p>${esc(desc)}</p>` }))

// ---------- 古いHTMLを片づける ----------
// レースは3日で消えるので、置きっぱなしにすると「データの無いページ」が検索に残る
let removed = 0
const sweep = (dir) => {
  const abs = join(SITE, dir)
  if (!existsSync(abs)) return
  for (const name of readdirSync(abs)) {
    const p = join(abs, name)
    if (!statSync(p).isDirectory()) continue
    const rel = `${dir}/${name}/index.html`
    if (!wrote.has(rel)) { rmSync(p, { recursive: true, force: true }); removed++ }
  }
}
for (const d of ['race', 'racer', 'd']) sweep(d)

console.log(`HTMLを ${written} ページ書き出し、古いものを ${removed} ページ片づけました`)
if (!BASE) console.log('⚠ site/config.js の siteUrl が空なので、canonical と og:url は入れていません')
