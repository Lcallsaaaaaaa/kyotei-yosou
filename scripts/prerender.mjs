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
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'site')
const LOCAL = join(SITE, '_local')
const VENUES = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国', 'びわこ', '住之江',
  '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

if (!existsSync(LOCAL)) { console.error('site/_local がありません。先に node scripts/sync-public.mjs --local'); process.exit(1) }
// ★古いまま書き出さない（2026-10-05）
//   10/05、固定ページ（このサイトについて・規約・プライバシー）を書き換えて
//   R2 には届いていたのに、**書き出したHTMLは9日前の中身のまま**だった。
//   画面はR2から読むので人には新しく見えるが、**検索エンジンが見るのは古いほう**。
//   SEOのためのサイトでこれは致命的なので、古かったら止める。
// 固定ページ（about/privacy/terms）は原稿から直に読むので、ここでは見ない。
// レース・ニュース・場・選手は site/_local が元なので、そこが古いと
// **古い出走表を書き出して検索エンジンに出し続ける**。いちばん新しい日付で見る。
{
  const ages = readdirSync(LOCAL).filter((f) => f.startsWith('races__'))
    .map((f) => (Date.now() - statSync(join(LOCAL, f)).mtimeMs) / 3600e3)
  const newest = ages.length ? Math.min(...ages) : null
  if ((newest == null || newest > 24) && !process.argv.includes('--force')) {
    console.error(`site/_local のレースが ${newest == null ? '見つかりません' : Math.round(newest) + '時間前のもの'}。`)
    console.error('そのまま書き出すと、検索エンジンに古い出走表を見せ続けます。')
    console.error('  直す： node scripts/sync-public.mjs --once --write-local')
    console.error('  承知のうえで進める： node scripts/prerender.mjs --force')
    process.exit(1)
  }
}
const cfg = (() => { const w = {}; new Function('window', readFileSync(join(SITE, 'config.js'), 'utf8'))(w); return w.NAGI ?? {} })()
const BASE = (cfg.siteUrl || '').replace(/\/+$/, '')
const SITE_NAME = cfg.siteName || 'ボートレース研究所'
// ⚠ canonical と og:url は**外枠から外してから**付け直す（2026-10-10に実際に踏んだ）
//   stampAssets と同じ罠。外枠（shell）は site/index.html を読んでいて、
//   その index.html も page() の出力としてここで書き出している。
//   page() は </head> の直前に canonical と og:url を**足している**ので、
//   次の回はそれを含む index.html を外枠として読み、また足す。
//   実際に13回ぶん溜まり、**全2,036ページに canonical が14個**（13個がトップ指し）
//   という状態になっていた。Googleは canonical が複数あると**全部無視する**ので、
//   SEOのためのサイトで canonical が丸ごと効いていなかった。
//   （ld+json は溜まらない。トップページは ld を渡していないので足されない）
const stripInjected = (html) => html
  .replace(/^[ \t]*<link rel="canonical"[^>]*>\r?\n?/gm, '')
  .replace(/^[ \t]*<meta property="og:url"[^>]*>\r?\n?/gm, '')
const shell = stripInjected(readFileSync(join(SITE, 'index.html'), 'utf8'))

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const doc = (key) => {
  const f = join(LOCAL, key.replaceAll('/', '__') + '.json')
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null } catch { return null }
}
const md = (d) => { const [, m, dd] = String(d).split('-'); return `${Number(m)}/${Number(dd)}` }
const pct = (v) => (v == null ? '―' : Number(v).toFixed(1) + '%')
const num = (v, d = 2) => (v == null ? '―' : Number(v).toFixed(d))

// ---------- 置き換えたJS/CSSを確実に読ませる ----------
// ★2026-10-05。_headers が app.js / style.css / core.css を 5分ためる設定なので、
//   公開しても**ブラウザは古いものを握ったまま**。この日2回つまずいた。
//     ・枠線ボタンの白文字を直したのに直らない（core.css が古い）
//     ・/alerts を足したのに「ページが見つかりません」（app.js が古い・90,567→93,807バイト）
//   もっと悪いのは、**新しいHTMLと古いJSが混ざる**こと。中身の形が変わっていたら壊れる。
//   ファイルの中身から短い印を作ってURLに付ければ、変わった時だけ必ず読み直される。
const ASSETS = ['app.js', 'style.css', 'core.css', 'config.js']
const VER = (() => {
  const h = createHash('sha1')
  for (const f of ASSETS) { try { h.update(readFileSync(join(SITE, f))) } catch { /* 無ければ飛ばす */ } }
  return h.digest('hex').slice(0, 8)
})()
// ⚠ 先に付いている印を**必ず外してから**付け直すこと（2026-10-06に実際に踏んだ）
//   外枠（shell）は site/index.html を読んでいて、その index.html もここで書き出している。
//   つまり2回目以降は `"/app.js?v=xxxx"` の形になっていて `"/app.js"` に当たらない。
//   そのため**印が最初の1回で固まり、中身を変えても更新されなかった**。
//   結果：新しい app.js を公開しても、ブラウザは同じURLを握ったまま古い中身を使う
//   （/alerts をLINE限定にしたのに画面が変わらなかった）。
const stampAssets = (html) => {
  // ① 先に付いている印を外す（"/app.js?v=abcd1234" → "/app.js"）
  let s = html
  for (const f of ASSETS) {
    for (;;) {
      const i = s.indexOf(`"/${f}?v=`)
      if (i < 0) break
      const end = s.indexOf('"', i + 1)
      if (end < 0) break
      s = s.slice(0, i) + `"/${f}"` + s.slice(end + 1)
    }
  }
  // ② 付け直す
  for (const f of ASSETS) s = s.replaceAll(`"/${f}"`, `"/${f}?v=${VER}"`)
  return s
}

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
  return stampAssets(h)
}

let written = 0
const wrote = new Set()
// ★「<パス>.html」で置く（2026-09-24に変更）
//   前は <パス>/index.html にしていたが、Cloudflare Pages は /race/x を /race/x/ へ
//   **308でリダイレクト**してしまい、canonical（末尾スラッシュ無し）と食い違っていた。
//   .html で置けばリダイレクトなしでそのまま返る。
function out(path, html) {
  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '') + '.html'
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

// 試し読み（登録なしで見られる毎日1レース）。印は裏側（sync-public）が付けている。
const tasterCache = new Map()
const tasterPick = (date) => {
  if (!tasterCache.has(date)) tasterCache.set(date, doc(`taster/${date}`)?.pick ?? null)
  return tasterCache.get(date)
}
/** そのレースが試し読みなら、予想の一文を返す。違えば null。 */
function tasterOf(R) {
  if (!R?.taster) return null
  const p = tasterPick(R.date)
  if (!p || p.race_id !== R.race_id) return null
  // ⚠ 「きょうの」と書かないこと。前日のレースページにも印が付くので、日付と食い違う。
  return `<p><b>${p.lane === 1 ? '1号艇1着の無料予想' : '無料予想'}</b>（登録なしで見られる、その日の試し読み1レース）：
    単勝 <b>${p.lane}号艇 ${esc(p.racer ?? '')}</b>${p.win_probability != null ? `・1着確率 ${pct(p.win_probability)}` : ''}${
      p.hit == null ? '' : p.hit ? `・<b>的中</b>${p.payout ? ` ${p.payout.toLocaleString()}円` : ''}` : '・不的中'}。
    ほかのレースの無料予想は<a href="/line">LINE登録（無料）</a>でご覧いただけます。</p>`
}

// トップ・日付ごとの出走表
for (const d of dates) {
  const j = doc(`races/${d}`)
  if (!j?.races?.length) continue
  const byV = new Map()
  for (const r of j.races) { if (!byV.has(r.jcd)) byV.set(r.jcd, []); byV.get(r.jcd).push(r) }
  const isToday = d === today
  // ★試し読みの1レースは、JavaScriptが動かなくても見えるようにする（2026-10-10）
  //   検索エンジンとSNSのクローラーが見るのはこのHTMLで、**未登録と同じ立場**。
  //   以前はここに予想が1文字も無く、クローラーには「鍵のかかった案内」しか見えていなかった。
  //   taster/<日付> は誰でも読める置き場で、入っているのは1本だけ。
  const T = doc(`taster/${d}`)
  const tp = T?.pick ?? null
  const tasterBox = !tp ? '' : `<section><h2>${tp.lane === 1 ? 'きょうの1号艇1着の無料予想' : 'きょうの無料予想'}
      <span class="sub">試し読み1レース</span></h2>
    <p><a href="/race/${esc(tp.race_id)}">${esc(tp.venue ?? VENUES[tp.jcd] ?? '')}${tp.race_no}R</a>
      ${tp.deadline ? `（締切 ${esc(tp.deadline)}）` : ''}　単勝 <b>${tp.lane}号艇 ${esc(tp.racer ?? '')}</b>
      ${tp.win_probability != null ? `・1着確率 ${pct(tp.win_probability)}` : ''}
      ${tp.hit == null ? '' : tp.hit ? `・<b>的中</b>${tp.payout ? ` ${tp.payout.toLocaleString()}円` : ''}` : '・不的中'}</p>
    <p>登録なしで見られるのは毎日この1レースです。${T.total > 1 ? `きょうは全部で${T.total}本出しています。残りは` : ''}
      <a href="/line">LINE登録（無料）</a>${T.total > 1 ? 'でご覧いただけます' : 'で毎朝お届けしています'}。
      買い目は100円換算で、外れたぶんも<a href="/results">実績</a>に残しています。</p></section>`
  const body = `<h1>${isToday ? esc(SITE_NAME) : `${md(d)}の出走表`}</h1>
    <p>${md(d)}は全国${byV.size}場で${j.races.length}レースが行われます。締切時刻・選手の成績・モーター・直前情報と、AIの1着確率をまとめています。</p>
    ${isToday ? tasterBox : ''}
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
    ${tasterOf(R) ?? ''}
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
  // ★JavaScriptを動かさない相手にも中身を見せる（2026-10-11）
  //   それまで選手ページのHTMLは**本文261文字**しかなく、題・1行要約・コース別表だけだった。
  //   画面（app.js）は場別・グレード別・時間帯別・進入・直近の節まで全部出しているのに、
  //   **クローラーが見るHTMLには入っていなかった**。選手ページは1,627枚＝サイトの76%。
  //   ・Googleは描き直してくれるが、1,627枚ぶんは後回しにされる
  //   ・SNSのクローラーとAI系のクローラー（GPTBot等）は**そもそもJavaScriptを動かさない**
  //     ＝AIに引用されたいなら、ここに書いていないものは存在しないのと同じ
  //   ・薄いページを大量に置くこと自体が、Googleの「大量生成コンテンツの不正使用」に近づく
  //   doc に入っているものを出すだけなので、集計も通信も増えない。
  const c1 = (P.by_course ?? []).find((c) => c.course === 1)
  const S = P.summary_1y, T = P.titles_since_2022, MZ = P.maezuke
  const statTable = (cap, head, rows) => !rows?.length ? ''
    : `<table><caption>${cap}</caption><thead><tr><th>${head}</th><th>出走</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>平均ST</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${r.label}</td><td>${r.starts}</td><td>${pct(r.win_rate)}</td><td>${pct(r.top2_rate)}</td><td>${pct(r.top3_rate)}</td><td>${num(r.avg_st)}</td></tr>`).join('')}</tbody></table>`
  // 場別は1着率の高い順に並べる（表で見たいのはこれ）。
  // ⚠ ただし本文で「いちばんよい場」と書いてはいけない。**最大値を同じ標本から選ぶと偏る**ので、
  //   15走で66.7%のような上振れを「得意な場」と言い切ることになる（2026-10-11に書きかけた）。
  //   本文で触れるのは**いちばん多く走っている場**（選び方で偏らないし、主戦場のほうが知りたい情報）。
  const venues = [...(P.by_venue ?? [])].sort((a, b) => b.win_rate - a.win_rate)
  const mainV = [...(P.by_venue ?? [])].sort((a, b) => b.starts - a.starts)[0]
  const body = `<h1>${esc(P.name)}</h1>
    <p>登番 ${P.racer_id}${P.branch ? `・${esc(P.branch)}支部` : ''}${P.class ? `・${esc(P.class)}` : ''}${P.age ? `・${P.age}歳` : ''}${P.height ? `・${P.height}cm` : ''}${P.weight ? `・${P.weight}kg` : ''}</p>
    ${S ? `<p>競艇選手${esc(P.name)}（登番${P.racer_id}）の<strong>直近1年</strong>の成績は、${S.starts}走で1着率 ${pct(S.win_rate)}・2連対率 ${pct(S.top2_rate)}・3連対率 ${pct(S.top3_rate)}、平均STは ${num(S.avg_st)}（レース内の平均順位 ${num(S.avg_st_rank)}番手）です。${
      c1 ? `1コースに入ったときは${c1.starts}走で1着率 ${pct(c1.win_rate)}。` : ''}${
      mainV ? `いちばん多く走っているのは${esc(mainV.venue)}で、${mainV.starts}走・1着率 ${pct(mainV.win_rate)}です。` : ''}</p>` : ''}
    ${T ? `<p>2022年8月以降の実績：優勝 ${T.yusho}回・優出 ${T.yushutsu}回・準優 ${T.junyu}回。</p>` : ''}
    ${statTable('コース別成績（直近1年）', 'コース', (P.by_course ?? []).map((c) => ({ ...c, label: `${c.course}コース` })))}
    ${statTable('場別成績（直近1年・1着率の高い順）', '場', venues.map((v) => ({ ...v, label: v.venue })))}
    ${statTable('グレード別（直近1年）', 'グレード', (P.by_grade ?? []).map((g) => ({ ...g, label: g.grade })))}
    ${statTable('時間帯・波の高さ別（直近1年）', '条件', [...(P.by_time ?? []), ...(P.by_wave ?? [])].map((g) => ({ ...g, label: g.band })))}
    ${MZ?.starts ? `<p>進入：${MZ.starts}走のうち、枠より内へ入った（前づけ）のが ${MZ.inward}回（${pct(MZ.inward_rate)}）、外へ出たのが ${MZ.outward}回（${pct(MZ.outward_rate)}）。</p>` : ''}
    ${(P.winning_moves ?? []).length ? `<p>1着になったときの決まり手：${P.winning_moves.map((w) => `${esc(w.kimarite)} ${w.count}回（${pct(w.share)}）`).join('・')}。</p>` : ''}
    ${(P.periods ?? []).length ? `<table><caption>期別の公式成績</caption><thead><tr><th>期</th><th>級別</th><th>勝率</th><th>2連対率</th><th>出走</th></tr></thead><tbody>${
      P.periods.map((q) => `<tr><td>${esc(q.period)}</td><td>${esc(q.class ?? '')}</td><td>${num(q.win_rate)}</td><td>${pct(q.top2_rate)}</td><td>${q.starts}</td></tr>`).join('')}</tbody></table>` : ''}
    ${(P.series_recent ?? []).length ? `<table><caption>直近の節</caption><thead><tr><th>期間</th><th>場</th><th>グレード</th></tr></thead><tbody>${
      P.series_recent.map((s) => `<tr><td>${esc(s.from)}〜${esc(s.to)}</td><td>${esc(s.venue)}</td><td>${esc(s.grade ?? '')}${s.series ? `　${esc(s.series)}` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    ${P.period_note ? `<p>${esc(P.period_note)}</p>` : ''}
    <p><a href="/racers">選手一覧</a>${P.branch ? `　<a href="/racers/all">支部別の選手一覧</a>` : ''}${
      mainV ? `　<a href="/venue/${mainV.jcd}">${esc(mainV.venue)}のデータ攻略</a>` : ''}</p>`
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
  // ★きょうの開催もここに出す（2026-10-11・app.js の venue() と同じ中身）
  //   「桐生 競艇」で来た人がいちばん先に知りたいのは**きょう何が走るか**。
  //   ⚠ app.js に節を足したら、ここにも足すこと。画面では気づけない
  //     （画面は常に正しく見える。クローラーが見るのはこちら）。
  const mine = (doc(`races/${today}`)?.races ?? []).filter((r) => r.jcd === jcd)
    .sort((a, b) => a.race_no - b.race_no)
  const head = mine[0]
  const todayBox = !mine.length ? ''
    : `<h2>きょうの${esc(name)}（${md(today)}）</h2>
      <p>${esc(head.series ?? '')}${head.grade ? `（${esc(head.grade)}）` : ''}${
        head.day_no ? `　${head.day_no}日目${head.series_days ? `/全${head.series_days}日` : ''}` : ''}・全${mine.length}レース</p>
      <table><caption>きょうの出走と結果</caption><thead><tr><th>R</th><th>締切</th><th>状況</th><th>着順</th><th>決まり手</th><th>3連単</th></tr></thead><tbody>${
        mine.map((r) => `<tr><td><a href="/race/${esc(r.race_id)}">${r.race_no}R</a></td><td>${esc(r.deadline ?? '―')}</td>
          <td>${r.cancelled ? '中止' : r.result ? '確定' : r.closed ? '締切' : '受付中'}</td>
          <td>${esc(r.result?.order_all ?? '―')}</td><td>${esc(r.result?.kimarite ?? '―')}</td>
          <td>${r.result?.trifecta_payout ? r.result.trifecta_payout.toLocaleString() + '円' : '―'}</td></tr>`).join('')}</tbody></table>`
  const body = `<h1>${esc(name)}の攻略</h1>
    ${todayBox}
    ${G?.points?.length ? `<ul>${G.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${G?.points_note ? `<p>${esc(G.points_note)}</p>` : ''}
    ${G?.manual?.html ?? ''}
    <p><a href="/venues">ほかの場を見る</a>　<a href="/schedule">開催予定</a></p>`
  out(`/venue/${jcd}`, page({
    path: `/venue/${jcd}`,
    title: `ボートレース${name}の攻略とデータ`,
    desc: mine.length
      ? `きょう（${md(today)}）のボートレース${name}は${mine.length}レース${head?.series ? `「${head.series}」` : ''}。締切時刻と結果、1コース1着率・決まり手・波や風での変わり方・当地で強い選手を実測からまとめています。`
      : `ボートレース${name}の1コース1着率・コース別の決まり手・波や風での変わり方・当地で強い選手を、直近1年の実測からまとめた攻略ページです。`,
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
// ★原稿（content/pages/*.md）から直に読む（2026-10-05）
//   以前は site/_local 経由だったので、R2 には新しい中身が届いているのに
//   **書き出したHTMLだけ9日前のまま**になっていた。人には新しく見えて、
//   検索エンジンには古いものを見せ続ける。元が手元にあるのだから直接読む。
{
  const { loadDir } = await import('./md.mjs')
  for (const p of loadDir(join(ROOT, 'content', 'pages'))) {
    if (!p?.html) continue
    const title = p.meta.title ?? p.slug
    out(`/${p.slug}`, page({ path: `/${p.slug}`, title, desc: p.meta.description ?? p.summary ?? title,
      body: `<article><h1>${esc(title)}</h1>${p.html}</article>` }))
  }
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
  ['/member', '会員（月額500円）', '月額500円の会員になると、全レースの展開予想（展開の図つき）と、レースごとに選べるAI予想の型（本命・堅実・中穴・大穴）、各レースの1着確率がご覧いただけます。'],
  ['/alerts', '展示のアラート｜まくり・前づけ・チルト・スタート', '展示タイム・進入・チルト・展示STから、荒れそうなレースを機械的に拾っています。効き目を228,685レースで実測した結果もそのまま載せています。'],
  ['/line', 'LINEで無料予想を受け取る', 'ボートレース研究所の無料予想（単勝1点・1着確率80%以上の本命だけ）を、LINEで毎朝10時にお届けします。費用はかかりません。'],
]
// ★/news だけは記事一覧を本文に入れる（2026-11-13）。
//   ここは長らく**題と説明だけ**で、記事へのリンクが1本も無かった。
//   記事そのもの（/news/<slug>）は上で書き出していてサイトマップにも載るが、
//   一覧から辿れないので、クローラーから見ると行き止まりだった。
//   11/01 に実測して 0本、11/13 の公開後も 0本のまま。
//   記事は doc('news/index') に入っている。出すだけでいい。
//   選手ページ・データ分析と同じ穴（[[boatrace-racer-pages-thin]]）。
const newsListHtml = () => {
  if (!news.length) return ''
  const byYm = new Map()
  for (const n of news) {
    const ym = String(n.date ?? '').slice(0, 7) || 'そのほか'
    if (!byYm.has(ym)) byYm.set(ym, [])
    byYm.get(ym).push(n)
  }
  return [...byYm.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([ym, list]) =>
    `<section><h2>${esc(ym === 'そのほか' ? ym : ym.replace('-', '年') + '月')}</h2><ul>${
      list.map((n) => `<li><a href="/news/${esc(n.slug)}">${esc(n.title ?? n.slug)}</a>${
        n.date ? `　<time datetime="${esc(n.date)}">${esc(n.date)}</time>` : ''}${
        n.summary ? `<br>${esc(String(n.summary).slice(0, 110))}` : ''}</li>`).join('')
    }</ul></section>`).join('')
}
for (const [path, title, desc] of listPages) {
  const extra = path === '/news' ? newsListHtml() : ''
  out(path, page({ path, title, desc, body: `<h1>${esc(title.split('｜')[0])}</h1><p>${esc(desc)}</p>${extra}` }))
}

// ---------- データ分析（2026-10-11に中身を入れた）----------
// ★それまで本文が42文字（題と一文だけ）しか無かった。
//   画面（app.js）は24場ぶんの表を出しているのに、クローラーには空っぽ同然だった。
//   選手ページと同じ穴（[[boatrace-racer-pages-thin]]）。doc に入っているものを出すだけ。
// ★ここは**場をまたいで比べられる唯一のページ**でもある。
//   「1コースが強い場は」「荒れる場は」という問いに答えるので、場ページ24枚の親になる。
{
  const vlink = (jcd, name) => `<a href="/venue/${jcd}">${esc(name)}</a>`
  // コース別平均
  const A = doc('analysis/average')
  if (A?.national?.length) {
    const v1 = (A.venues ?? []).map((v) => ({ ...v, c1: v.courses?.find((c) => c.course === 1) }))
      .filter((v) => v.c1).sort((a, b) => b.c1.win_rate - a.c1.win_rate)
    out('/analysis/average', page({
      path: '/analysis/average', title: 'コース別平均｜競艇データ分析',
      desc: `競艇のコース別1着率を全国24場の直近1年（${A.period?.from}〜）の実測から集計。1コースの1着率は全国平均${num(A.national[0]?.win_rate, 1)}%で、場によって${num(v1.at(-1)?.c1.win_rate, 1)}%〜${num(v1[0]?.c1.win_rate, 1)}%の開きがあります。`,
      body: `<h1>コース別平均</h1>
        <p>全国24場の直近1年（${esc(A.period?.from ?? '')}〜${esc(A.period?.to ?? '')}）の実測です。コースは進入コース（枠番ではありません）。</p>
        <table><caption>全国平均（コース別）</caption><thead><tr><th>コース</th><th>出走</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>平均ST</th></tr></thead><tbody>${
          A.national.map((c) => `<tr><td>${c.course}コース</td><td>${c.starts?.toLocaleString()}</td><td>${pct(c.win_rate)}</td><td>${pct(c.top2_rate)}</td><td>${pct(c.top3_rate)}</td><td>${num(c.avg_st)}</td></tr>`).join('')}</tbody></table>
        <h2>1コースが強い場・弱い場</h2>
        <table><caption>場別の1コース1着率（高い順）</caption><thead><tr><th>場</th><th>1コース1着率</th><th>2連対率</th><th>出走</th></tr></thead><tbody>${
          v1.map((v) => `<tr><td>${vlink(v.jcd, v.venue)}</td><td>${pct(v.c1.win_rate)}</td><td>${pct(v.c1.top2_rate)}</td><td>${v.c1.starts?.toLocaleString()}</td></tr>`).join('')}</tbody></table>
        <p>いちばん高いのは${vlink(v1[0].jcd, v1[0].venue)}の${pct(v1[0].c1.win_rate)}、いちばん低いのは${vlink(v1.at(-1).jcd, v1.at(-1).venue)}の${pct(v1.at(-1).c1.win_rate)}です。各場の詳しい事情は<a href="/venues">場ごとのページ</a>にまとめています。</p>`,
    }))
  }
  // 出目
  const D = doc('analysis/demoku')
  if (D?.national) {
    const vs = [...(D.venues ?? [])].sort((a, b) => (b.over_10000_rate ?? 0) - (a.over_10000_rate ?? 0))
    out('/analysis/demoku', page({
      path: '/analysis/demoku', title: '出目分析｜競艇データ分析',
      desc: `3連単の出目の出やすさと配当の水準を、直近1年${D.national.races?.toLocaleString()}レースの実測から集計。いちばん多い出目は${D.national.trifecta_top?.[0]?.combo}（${D.national.trifecta_top?.[0]?.rate}%）、万舟率は全国${num(D.national.over_10000_rate, 1)}%です。`,
      body: `<h1>出目分析</h1>
        <p>直近1年・${D.national.races?.toLocaleString()}レースの実測です。3連単の平均配当は${D.national.avg_payout?.toLocaleString()}円、万舟（1万円以上）の率は${pct(D.national.over_10000_rate)}。</p>
        <table><caption>よく出る3連単の出目（全国）</caption><thead><tr><th>出目</th><th>回数</th><th>割合</th></tr></thead><tbody>${
          (D.national.trifecta_top ?? []).slice(0, 20).map((t) => `<tr><td>${esc(t.combo)}</td><td>${t.count?.toLocaleString()}</td><td>${pct(t.rate)}</td></tr>`).join('')}</tbody></table>
        <h2>荒れる場・堅い場</h2>
        <table><caption>場別の万舟率（高い順）</caption><thead><tr><th>場</th><th>万舟率</th><th>3連単の平均配当</th><th>レース</th></tr></thead><tbody>${
          vs.map((v) => `<tr><td>${vlink(v.jcd, v.venue)}</td><td>${pct(v.over_10000_rate)}</td><td>${v.avg_payout?.toLocaleString()}円</td><td>${v.races?.toLocaleString()}</td></tr>`).join('')}</tbody></table>
        <p>⚠ 平均配当が高いことは「儲かる」という意味ではありません。控除率25%はどの場でも同じで、荒れる場は当たる回数が減ります（<a href="/news/2026-10-10-kojoritsu">控除率25%とは何か</a>）。</p>`,
    }))
  }
  // コース別の上位選手
  const R = doc('analysis/ranking')
  if (R?.by_course?.length) {
    out('/analysis/ranking', page({
      path: '/analysis/ranking', title: 'コース別ランキング｜競艇データ分析',
      desc: `コースごとに1着率の高い選手と、平均STの速い選手を直近1年の実測から並べています（${esc(R.rule ?? '')}）。`,
      body: `<h1>コース別ランキング</h1><p>${esc(R.rule ?? '')}の実測です。</p>
        ${R.by_course.map((c) => `<h2>${c.course}コース</h2>
          <table><thead><tr><th>選手</th><th>級別</th><th>出走</th><th>1着率</th><th>平均ST</th></tr></thead><tbody>${
            (c.top ?? []).slice(0, 10).map((r) => `<tr><td><a href="/racer/${r.racer_id}">${esc(r.name)}</a></td><td>${esc(r.class ?? '')}</td><td>${r.starts}</td><td>${pct(r.win_rate)}</td><td>${num(r.avg_st)}</td></tr>`).join('')}</tbody></table>`).join('')}
        <h2>平均STの速い選手</h2>
        <table><thead><tr><th>選手</th><th>級別</th><th>出走</th><th>平均ST</th></tr></thead><tbody>${
          (R.fastest_start ?? []).slice(0, 30).map((r) => `<tr><td><a href="/racer/${r.racer_id}">${esc(r.name)}</a></td><td>${esc(r.class ?? '')}</td><td>${r.starts}</td><td>${num(r.avg_st)}</td></tr>`).join('')}</tbody></table>`,
    }))
  }
  // 優勝戦
  const Y = doc('analysis/yusho')
  if (Y?.races?.length) {
    const row = (r) => `<tr><td>${esc(r.date)}</td><td>${vlink(r.jcd, r.venue)}</td><td>${esc(r.grade ?? '')}</td><td>${esc(r.series ?? '')}</td><td>${esc(r.winner?.name ?? '')}</td><td>${esc(r.kimarite ?? '')}</td><td>${esc(r.order ?? '')}</td><td>${r.trifecta_payout?.toLocaleString() ?? '―'}円</td></tr>`
    out('/analysis/yusho', page({
      path: '/analysis/yusho', title: '優勝戦｜競艇データ分析',
      desc: `${esc(Y.period ?? '直近90日')}の優勝戦${Y.races.length}本の結果。優勝者・決まり手・着順・3連単の配当を一覧にしています。`,
      body: `<h1>優勝戦</h1><p>${esc(Y.period ?? '直近90日')}の優勝戦${Y.races.length}本です。</p>
        ${(Y.big ?? []).length ? `<h2>グレードレースの優勝戦</h2><table><thead><tr><th>日付</th><th>場</th><th>格</th><th>開催</th><th>優勝</th><th>決まり手</th><th>着順</th><th>3連単</th></tr></thead><tbody>${Y.big.map(row).join('')}</tbody></table>` : ''}
        <h2>すべての優勝戦</h2><table><thead><tr><th>日付</th><th>場</th><th>格</th><th>開催</th><th>優勝</th><th>決まり手</th><th>着順</th><th>3連単</th></tr></thead><tbody>${
          Y.races.slice(0, 120).map(row).join('')}</tbody></table>`,
    }))
  }
}

// ---------- 節（開催）----------
// ★2026-10-11まで、/meeting/<場>/<開始日> は **103本すべてサイトマップに載っているのに
//   HTMLが1枚も無かった**。実在しないので Pages が index.html を返し、
//   **103本すべてがトップページの複製（canonical も「/」）**になっていた。
//   出場選手一覧という中身はあるので、ちゃんと書き出す。
for (const f of readdirSync(LOCAL)) {
  if (!f.startsWith('meeting__')) continue
  const M = JSON.parse(readFileSync(join(LOCAL, f), 'utf8'))?.meeting
  if (!M?.venue || !M.start_date) continue
  const path = `/meeting/${M.jcd}/${M.start_date}`
  const rs = (M.racers ?? []).slice().sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0))
  const span = `${esc(M.start_date)}〜${esc(M.end_date ?? '')}`
  out(path, page({
    path,
    title: `${M.venue}「${M.title ?? ''}」${md(M.start_date)}開幕`,
    desc: `ボートレース${M.venue}「${M.title ?? ''}」（${M.grade ?? ''}・${M.start_date}〜${M.end_date ?? ''}・${M.days ?? ''}日間）の出場予定選手${rs.length}人を勝率順にまとめています。`,
    body: `<h1>${esc(M.venue)}「${esc(M.title ?? '')}」</h1>
      <p>${span}（${M.days ?? '―'}日間）${M.grade ? `・${esc(M.grade)}` : ''}・ボートレース${esc(M.venue)}</p>
      ${rs.length ? `<table><caption>出場予定選手（勝率の高い順・${rs.length}人）</caption><thead><tr><th>選手</th><th>級別</th><th>支部</th><th>勝率</th></tr></thead><tbody>${
        rs.map((r) => `<tr><td><a href="/racer/${r.racer_id}">${esc(r.name)}</a></td><td>${esc(r.class ?? '')}</td><td>${esc(r.branch ?? '')}</td><td>${num(r.win_rate)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p><a href="/venue/${M.jcd}">${esc(M.venue)}のデータ攻略</a>　<a href="/schedule">開催予定</a></p>`,
    ld: { '@context': 'https://schema.org', '@type': 'SportsEvent', name: `${M.venue} ${M.title ?? ''}`,
      startDate: M.start_date, endDate: M.end_date ?? undefined, sport: '競艇',
      location: { '@type': 'Place', name: `ボートレース${M.venue}` } },
  }))
}

// ---------- 古いHTMLを片づける ----------
// レースは3日で消えるので、置きっぱなしにすると「データの無いページ」が検索に残る
let removed = 0
// ⚠ フォルダを問答無用で消してはいけない（2026-10-11に踏んだ）
//   もとは「前の作り（<パス>/index.html）の残り」を片づけるつもりで
//   **フォルダを見つけたら中身ごと削除**していた。
//   ところが節ページは /meeting/<場>/<開始日> と入れ子なので、
//   `sweep('meeting')` が meeting/1/ などを**作った直後に消していた**
//   （書き出し2,184枚と報告されるのに、実際に残るのは2,053枚だった）。
//   → 入れ子はたどって、**この回に書かなかったHTMLだけ**を消す。
//     空になったフォルダと古い index.html は、下の purge() が片づける。
const sweep = (dir) => {
  const abs = join(SITE, dir)
  if (!existsSync(abs)) return
  for (const name of readdirSync(abs)) {
    const p = join(abs, name)
    if (statSync(p).isDirectory()) { sweep(`${dir}/${name}`); continue }
    if (!name.endsWith('.html')) continue
    if (!wrote.has(`${dir}/${name}`)) { rmSync(p, { force: true }); removed++ }
  }
}
for (const d of ['race', 'racer', 'd', 'news', 'venue', 'analysis', 'racers', 'meeting']) sweep(d)

// 前の作り（<パス>/index.html）の残りを全部消す。
// いまは site/index.html だけが index.html で、ほかは <パス>.html。
// 残っていると Pages が /about → /about/ へ308で飛ばしてしまう。
const KEEP_DIR = new Set(['_local', 'assets', 'functions'])
const purge = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (dir === SITE && KEEP_DIR.has(name)) continue
    if (statSync(p).isDirectory()) { purge(p); try { if (!readdirSync(p).length) rmSync(p, { recursive: true }) } catch {} }
    else if (name === 'index.html' && dir !== SITE) { rmSync(p, { force: true }); removed++ }
  }
}
purge(SITE)

console.log(`HTMLを ${written} ページ書き出し、古いものを ${removed} ページ片づけました`)
if (!BASE) console.log('⚠ site/config.js の siteUrl が空なので、canonical と og:url は入れていません')
