// 凪の予想配信 ― 画面の動き
// データは Supabase の docs 表（公開モード）か site/_local/（このPCで試すとき）から読む。形は /api/v1 と同じ。
// ページ： #/ #/d/日付（出走表）・#/race/ID・#/tenkai/日付・#/results・#/venues・#/venue/場・#/racer/登番
(() => {
  const C = window.NAGI || {}
  const app = document.getElementById('app')
  const VENUES = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国', 'びわこ', '住之江',
    '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

  // ---------- データ ----------
  const cache = new Map()
  async function doc(key) {
    if (cache.has(key)) return cache.get(key)
    const p = (async () => {
      if (C.mode === 'supabase') {
        const r = await fetch(`${C.supabaseUrl}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=body`,
          { headers: { apikey: C.supabaseAnonKey, Authorization: `Bearer ${C.supabaseAnonKey}` } })
        if (!r.ok) throw new Error('データを読み込めませんでした（' + r.status + '）')
        const a = await r.json()
        return a[0]?.body ?? null
      }
      const r = await fetch('/_local/' + key.replace(/\//g, '__') + '.json', { cache: 'no-store' })
      return r.ok ? r.json() : null
    })()
    cache.set(key, p)
    setTimeout(() => cache.delete(key), 120_000)   // 直前情報が入るので2分で読み直す
    return p
  }

  // ---------- 会員（合言葉） ----------
  // 有料の中身は「合言葉で開ける形」で置き場に入っている（scripts/seal.mjs）。
  // 合言葉から鍵を作ってこの画面で開く。鍵は端末の中だけに置き、どこにも送らない。
  const MEM = 'nagi_member'
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const memberState = () => { try { return JSON.parse(localStorage.getItem(MEM) || 'null') } catch { return null } }
  const periodOfPhrase = (p) => { const m = String(p).trim().match(/^nagi-(\d\d)(\d\d)-/i); return m ? `20${m[1]}-${m[2]}` : null }
  const jaPeriod = (p) => (p ? `${p.slice(0, 4)}年${Number(p.slice(5, 7))}月` : '')
  async function deriveKey(phrase, period) {
    const e = new TextEncoder()
    const base = await crypto.subtle.importKey('raw', e.encode(phrase.trim()), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: e.encode('nagi-paid-v1|' + period), iterations: 210_000, hash: 'SHA-256' }, base, 256)
    return new Uint8Array(bits)
  }
  async function openBox(box) {
    const st = memberState()
    if (!st || !box || st.period !== box.period) return null
    try {
      const key = await crypto.subtle.importKey('raw', b64(st.key), 'AES-GCM', false, ['decrypt'])
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(box.iv) }, key, b64(box.ct))
      return JSON.parse(new TextDecoder().decode(plain))
    } catch { return null }
  }
  const paidDoc = async (key) => openBox(await doc(key))
  /** 有料のところに出す案内。date を渡すと、その月の会員かどうかも見る。 */
  function lockPanel(what, date) {
    const st = memberState()
    const stale = st && date && st.period !== date.slice(0, 7)
    return `<div class="panel lock"><b>${esc(what)}は会員の方だけご覧いただけます</b>
      <p>${stale ? `お手持ちの合言葉は${jaPeriod(st.period)}のものです。${jaPeriod(date.slice(0, 7))}の合言葉を入れてください。`
        : '月額300円の会員になると、全レースの展開予想とAI予想（3連複2点プラン）がご覧いただけます。'}</p>
      <p><a class="cta" href="/member">合言葉を入れる</a>${C.noteUrl ? ` <a class="cta ghost" href="${esc(C.noteUrl)}" target="_blank" rel="noopener">会員になる（月300円）</a>` : ''}</p></div>`
  }
  async function memberPage() {
    setNav('member')
    const st = memberState()
    const now = jstToday().slice(0, 7)
    meta('会員（月額300円）', '月額300円の会員になると、全レースの展開予想とAI予想（3連複2点プラン）がご覧いただけます。')
    const ok = st && st.period === now
    view(`<h1>会員</h1>
      <div class="panel">${ok ? `<p><b>${jaPeriod(st.period)}の会員として開いています。</b></p>
          <p class="sub">合言葉は毎月変わります。翌月ぶんは月末にnoteのメンバーシップでお知らせします。</p>
          <p><button type="button" class="cta ghost" id="mem-clear">この端末から合言葉を消す</button></p>`
        : `<p>noteのメンバーシップ（月額300円）に入ると、毎月の合言葉が届きます。</p>
          <p>その合言葉をここに入れると、この端末では<b>その月のあいだ入れ直さずに</b>、全レースの展開予想とAI予想（3連複2点プラン）が開きます。</p>
          ${st ? `<p class="note">いま入っているのは${jaPeriod(st.period)}の合言葉です。今月（${jaPeriod(now)}）ぶんを入れ直してください。</p>` : ''}`}</div>
      ${ok ? '' : `<div class="panel" style="margin-top:12px">
        <label for="mem-in"><b>合言葉</b></label>
        <p class="sub">例： nagi-2610-XXXX-XXXX（大文字小文字は問いません）</p>
        <div class="mem-form"><input id="mem-in" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="nagi-　　　-　　　-　　　"></div>
        <p><button type="button" class="cta" id="mem-go">開く</button></p>
        <p id="mem-msg" class="sub"></p>
        ${C.noteUrl ? `<p><a href="${esc(C.noteUrl)}" target="_blank" rel="noopener">まだ会員でない方（noteで月額300円）→</a></p>` : ''}</div>`}
      <p class="note">合言葉はこの端末の中だけに保存され、外には送られません。お連れの方やSNSへ教えないでください。</p>`)
    document.getElementById('mem-clear')?.addEventListener('click', () => { localStorage.removeItem(MEM); cache.clear(); route() })
    const go = document.getElementById('mem-go'), input = document.getElementById('mem-in'), msg = document.getElementById('mem-msg')
    const submit = async () => {
      const phrase = (input.value || '').trim()
      const period = periodOfPhrase(phrase)
      if (!period) { msg.textContent = '合言葉の形がちがうようです（nagi- から始まります）。'; return }
      msg.textContent = '確かめています…'; go.disabled = true
      try {
        const key = await deriveKey(phrase, period)
        localStorage.setItem(MEM, JSON.stringify({ period, key: btoa(String.fromCharCode(...key)) }))
        cache.clear()
        // その月の中身がすでにあれば、本当に開けるかここで確かめる
        const probe = await doc(`paid/tenkai/${jstToday()}`)
        if (probe && probe.period === period && !(await openBox(probe))) {
          localStorage.removeItem(MEM); go.disabled = false
          msg.textContent = 'この合言葉では開きませんでした。打ちまちがいがないかご確認ください。'
          return
        }
        track('member_unlock', { period })   // 合言葉が通った＝会員になった人
        navTo('/tenkai')
      } catch (e) { go.disabled = false; msg.textContent = '開けませんでした（' + (e.message || e) + '）' }
    }
    go?.addEventListener('click', submit)
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  }

  // ---------- 小道具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const dash = (v, d = 2) => (v == null || v === '' ? '―' : typeof v === 'number' ? v.toFixed(d) : esc(v))
  const pct = (v) => (v == null ? '―' : v.toFixed(1) + '%')
  const yen = (v) => (v == null ? '―' : Number(v).toLocaleString() + '円')
  const waku = (l) => `<span class="waku w${l}">${l}</span>`
  const cls = (c) => (c ? `<span class="cls cls-${esc(c)}">${esc(c)}</span>` : '')
  const md = (d) => { const [, m, dd] = d.split('-'); return `${Number(m)}/${Number(dd)}` }
  const wd = (d) => '日月火水木金土'[new Date(d + 'T00:00:00+09:00').getDay()]
  const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const nowHM = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16)
  const bar = (p, max = 100) => `<span class="probbar"><i style="width:${Math.max(2, (p ?? 0) / max * 70)}px"></i><b>${pct(p)}</b></span>`
  const MORE = ['schedule', 'analysis', 'venues', 'results', 'member']
  const setNav = (k) => {
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === k || (a.dataset.nav === 'more' && MORE.includes(k))))
    const m = document.getElementById('more'); if (m) { m.hidden = true; document.querySelector('.more-btn')?.setAttribute('aria-expanded', 'false') }
  }
  const view = (html) => { app.innerHTML = html; window.scrollTo(0, 0) }

  // ---------- アクセス解析（GA4）----------
  // config.js の gaId を入れたときだけ読み込む。URLが変わるたびに1ページとして数える
  // （画面の中だけでページが変わる作りなので、そうしないと最初の1ページしか数えられない）。
  if (C.gaId) {
    document.head.appendChild(Object.assign(document.createElement('script'),
      { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${C.gaId}` }))
    window.dataLayer = window.dataLayer || []
    window.gtag = function () { window.dataLayer.push(arguments) }
    window.gtag('js', new Date())
    window.gtag('config', C.gaId, { send_page_view: false })
  }
  const track = (name, params) => { if (window.gtag) window.gtag('event', name, params) }
  const trackPage = () => track('page_view', { page_title: document.title, page_location: location.href, page_path: location.pathname })

  // ---------- 検索エンジン向けの見出し ----------
  // ページごとに題と説明文を変える。全ページ同じだと検索結果で区別がつかず、順位も上がらない。
  const SITE = C.siteName || '凪の予想配信'
  const el = (tag, attrs) => Object.assign(document.createElement(tag), attrs)
  function meta(title, desc, opts = {}) {
    document.title = title === SITE ? title : `${title}｜${SITE}`
    const put = (sel, make, val, attr = 'content') => {
      let e = document.head.querySelector(sel)
      if (!e) { e = make(); document.head.appendChild(e) }
      e.setAttribute(attr, val)
    }
    const url = (C.siteUrl || location.origin) + location.pathname
    put('meta[name="description"]', () => el('meta', { name: 'description' }), desc)
    put('link[rel="canonical"]', () => el('link', { rel: 'canonical' }), url, 'href')
    for (const [p, v] of [['og:title', document.title], ['og:description', desc], ['og:url', url],
      ['og:type', opts.article ? 'article' : 'website'], ['og:site_name', SITE]])
      put(`meta[property="${p}"]`, () => { const m = el('meta'); m.setAttribute('property', p); return m }, v)
    put('meta[name="twitter:card"]', () => el('meta', { name: 'twitter:card' }), 'summary')
    let s = document.getElementById('ld')
    if (!s) { s = el('script', { type: 'application/ld+json', id: 'ld' }); document.head.appendChild(s) }
    s.textContent = JSON.stringify(opts.ld ?? { '@context': 'https://schema.org', '@type': 'WebPage', name: document.title, description: desc, url })
  }
  const fail = (e) => view(`<p class="empty">${esc(e.message || e)}</p>`)

  async function dayTabs(active, base) {
    const meta = await doc('meta')
    const dates = meta?.dates?.length ? meta.dates : [jstToday()]
    if (meta?.updated_at) document.getElementById('updated').textContent = `データ更新：${meta.updated_at}`
    return `<div class="days">${dates.map((d) => `<a href="/${base}/${d}" class="${d === active ? 'on' : ''}">${md(d)}(${wd(d)})${d === jstToday() ? ' 今日' : ''}</a>`).join('')}</div>`
  }

  // ---------- 出走表（トップ） ----------
  async function home(date) {
    setNav('home')
    date = date || jstToday()
    const tabs = await dayTabs(date, 'd')
    const j = await doc(`races/${date}`)
    if (!j || j.status !== 'ok') return view(`<h1>出走表</h1>${tabs}<p class="empty">${md(date)} のレースはまだありません。</p>`)
    const byV = new Map()
    for (const r of j.races) { if (!byV.has(r.jcd)) byV.set(r.jcd, []); byV.get(r.jcd).push(r) }
    const now = nowHM(), isToday = date === jstToday()
    const nextId = isToday ? [...j.races].filter((r) => !r.closed && !r.cancelled).sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''))[0]?.race_id : null

    // 本日の場状況（決着したレースから）
    const st = [...byV].map(([jcd, rs]) => {
      const done = rs.filter((r) => r.result?.order)
      const nige = done.filter((r) => r.result.order.startsWith('1-')).length
      const man = done.filter((r) => (r.result.trifecta_payout ?? 0) >= 10000).length
      const avg = done.length ? done.reduce((a, r) => a + (r.result.trifecta_payout ?? 0), 0) / done.length : 0
      return { jcd, n: done.length, nige, man, avg }
    }).filter((x) => x.n >= 3)
    const allDone = st.reduce((a, x) => a + x.n, 0)
    const status = allDone ? `<h2>本日の場状況 <span class="sub">決着 ${allDone}レース</span></h2>
      <div class="grid two">
        <div class="panel"><b>堅い場</b> <span class="sub">1号艇の1着率</span><ol class="rank">${[...st].sort((a, b) => b.nige / b.n - a.nige / a.n).slice(0, 5)
          .map((x) => `<li><span>${VENUES[x.jcd]}</span><span class="num">${(x.nige / x.n * 100).toFixed(0)}%（${x.nige}/${x.n}）</span></li>`).join('')}</ol></div>
        <div class="panel"><b>荒れている場</b> <span class="sub">3連単の平均配当</span><ol class="rank">${[...st].sort((a, b) => b.avg - a.avg).slice(0, 5)
          .map((x) => `<li><span>${VENUES[x.jcd]}</span><span class="num">${Math.round(x.avg).toLocaleString()}円・万舟${x.man}本</span></li>`).join('')}</ol></div>
      </div>` : ''

    const venues = [...byV].sort((a, b) => a[0] - b[0]).map(([jcd, rs]) => {
      const r0 = rs[0]
      const g = r0.grade && r0.grade !== '一般' ? `<span class="badge warn">${esc(r0.grade)}</span>` : ''
      const chips = rs.sort((a, b) => a.race_no - b.race_no).map((r) => {
        const c = ['rc', r.closed || r.cancelled ? 'done' : '', r.race_id === nextId ? 'next' : '', r.free_pick ? 'free' : ''].join(' ')
        const sub = r.cancelled ? '中止' : r.result?.order ? esc(r.result.order) : esc(r.deadline ?? '')
        return `<a class="${c}" href="/race/${r.race_id}"><b>${r.race_no}R</b><small>${sub}</small></a>`
      }).join('')
      return `<section class="venue"><div class="venue-head"><a class="venue-name" href="/venue/${jcd}" style="color:inherit;text-decoration:none">${VENUES[jcd]}</a>
        ${g}<span class="venue-series">${esc(r0.series ?? '')}${r0.day_no ? `　${r0.day_no}日目${r0.series_days ? '/' + r0.series_days : ''}` : ''}</span></div>
        <div class="races">${chips}</div></section>`
    }).join('')
    // ガチガチ／穴レース・アラート（日和のトップにある特集）
    const F = await doc(`features/${date}`)
    const rlink = (x) => `<a href="/race/${x.race_id}">${esc(x.venue)}${x.race_no}R</a> <span class="sub">${esc(x.deadline ?? '')}</span>`
    const pick = (list, fn, n = 8) => list.filter((x) => !x.closed).slice(0, n).map(fn).join('') || '<li><span class="sub">該当なし（締切前のレース）</span></li>'
    const feat = F ? `<div class="grid two" style="margin-top:12px">
        <div class="panel"><b>ガチガチレース</b> <span class="sub">${esc(F.gachigachi.rule)}</span><ol class="rank">${pick(F.gachigachi.races, (x) =>
          `<li><span>${rlink(x)}</span><span class="num">${waku(x.favorite.lane)} ${pct(x.favorite.win_probability)}</span></li>`)}</ol></div>
        <div class="panel"><b>穴レース</b> <span class="sub">${esc(F.ana.rule)}</span><ol class="rank">${pick(F.ana.races, (x) =>
          `<li><span>${rlink(x)}</span><span class="num">本命${waku(x.favorite.lane)} ${pct(x.favorite.win_probability)}</span></li>`)}</ol></div>
      </div>
      <h2>アラート <span class="sub">当日の直前情報から</span></h2>
      <div class="grid two">
        <div class="panel"><b>まくりアラート</b> <span class="sub">${esc(F.alerts.rules.makuri)}</span><ol class="rank">${pick(F.alerts.makuri, (x) =>
          `<li><span>${rlink(x)}</span><span class="num">${waku(x.lane)} 展示${dash(x.exhibition_time)}（1号艇より${dash(x.diff)}秒速い）</span></li>`)}</ol></div>
        <div class="panel"><b>前づけアラート</b> <span class="sub">${esc(F.alerts.rules.maezuke)}</span><ol class="rank">${pick(F.alerts.maezuke, (x) =>
          `<li><span>${rlink(x)}</span><span class="num">${waku(x.lane)} ${esc(x.name ?? '')} → ${x.course}コース</span></li>`)}</ol></div>
        <div class="panel"><b>チルト跳アラート</b> <span class="sub">${esc(F.alerts.rules.tilt)}</span><ol class="rank">${pick(F.alerts.tilt, (x) =>
          `<li><span>${rlink(x)}</span><span class="num">${waku(x.lane)} ${esc(x.name ?? '')} ${x.previous_tilt != null ? dash(x.previous_tilt, 1) + '→' : ''}${dash(x.tilt, 1)}</span></li>`)}</ol></div>
        <div class="panel"><b>スタートアラート</b> <span class="sub">${esc(F.alerts.rules.start)}</span><ol class="rank">${pick(F.alerts.start, (x) =>
          `<li><span>${rlink(x)}</span><span class="num">${waku(x.outer_lane)}が${waku(x.inner_lane)}より${dash(x.diff)}秒速い</span></li>`)}</ol></div>
      </div>` : ''
    const NI = await doc('news/index')
    const topNews = (NI?.articles ?? []).slice(0, 3)
    const newsBlock = topNews.length ? `<h2>ニュース <a class="sub" href="/news">もっと見る →</a></h2><div class="news-list">${topNews.map(newsItem).join('')}</div>` : ''
    meta(`${md(date)}(${wd(date)})の出走表 全国${byV.size}場${j.races.length}レース`,
      `${date.replaceAll('-', '/')}の全国${byV.size}場${j.races.length}レースの出走表です。締切時刻・選手の成績・モーター・直前情報と、AIが出した1着確率をレースごとにまとめています。`)
    // 並びは「レース一覧 → 特集・アラート → 場状況 → ニュース」。スマホでまず出走表に届くように（2026-09-23）
    view(`<h1>出走表 <span class="sub">${md(date)}(${wd(date)})・${byV.size}場 ${j.races.length}レース</span></h1>${tabs}
      <div class="grid" style="margin-top:12px">${venues}</div>
      <p class="note">「無料」の付いたレースは、1着確率80%以上の本命を単勝1点で無料公開しています。橙の枠は次に締め切るレースです。</p>
      ${feat}${status}${newsBlock}`)
  }

  // ---------- レース詳細 ----------
  async function race(id, tab) {
    setNav('home')
    const j = await doc(`race/${id}`)
    if (!j?.race) return view('<p class="empty">このレースのデータはまだありません。</p>')
    const R = j.race
    const day = await doc(`races/${R.date}`)
    const same = (day?.races ?? []).filter((r) => r.jcd === R.jcd).sort((a, b) => a.race_no - b.race_no)
    const c = R.conditions
    const conds = c ? `<div class="conds"><span>${esc(c.weather ?? '―')}</span><span>気温 ${dash(c.air_temp, 1)}℃</span><span>水温 ${dash(c.water_temp, 1)}℃</span>
      <span>風 ${dash(c.wind_speed, 0)}m</span><span>波 ${dash(c.wave, 0)}cm</span><span class="sub">${esc(c.before_info)}・${esc(c.fetched_at ?? '')}</span></div>` : ''
    meta(`${R.venue}${R.race_no}R ${md(R.date)} 出走表と予想`,
      `${R.venue}${R.race_no}R（${R.date.replaceAll('-', '/')}・締切${R.deadline ?? '―'}）の出走表。${(R.entries ?? []).map((e) => e.name).join('・')}。勝率・モーター2連対率・平均ST・直前情報と、AIの1着確率を載せています。`,
      { ld: { '@context': 'https://schema.org', '@type': 'SportsEvent', name: `${R.venue}${R.race_no}R`,
        startDate: R.deadline ? `${R.date}T${R.deadline}:00+09:00` : R.date, sport: '競艇',
        location: { '@type': 'Place', name: `ボートレース${R.venue}` },
        competitor: (R.entries ?? []).map((e) => ({ '@type': 'Person', name: e.name })) } })
    const state = R.cancelled ? '<span class="badge gray">中止・順延</span>' : R.result ? '<span class="badge gray">確定</span>' : R.closed ? '<span class="badge gray">締切</span>' : ''
    const free = R.free_pick ? `<div class="panel freepick"><b>無料予想</b>　単勝 ${waku(R.free_pick.lane)} ${esc(R.free_pick.racer ?? '')}（1着確率 ${pct(R.free_pick.probability)}）
      ${R.free_pick.hit == null ? '' : R.free_pick.hit ? `<span class="hit">的中 ${yen(R.free_pick.payout)}</span>` : '<span class="miss">不的中</span>'}</div>` : ''
    // 会員ぶん（展開予想・AI予想）。合言葉が入っていなければ開かないので null になる
    const paid = (R.member_only || R.has_member_picks) ? await paidDoc(`paid/race/${id}`) : null
    const p2 = paid?.picks?.plan2
    const aiPick = p2 ? `<div class="panel aipick"><b>AI予想　${esc(p2.name)}</b><span class="badge">自信度 ${p2.confidence}</span>
      <div class="picks">${p2.picks.map((x) => `<span class="combo">${x.combo.split('=').map((l) => waku(l)).join('')}
        <small>${pct(x.probability)}</small>${x.hit == null ? '' : x.hit ? `<b class="hit">的中 ${yen(x.payout)}</b>` : '<b class="miss">不的中</b>'}</span>`).join('')}</div>
      <p class="note">1点100円・2点で200円。回収率は100%未満です。</p></div>` : ''
    const cta = R.has_member_picks && !p2
      ? `<a class="cta" href="/member">このレースのAI予想（3連複2点）を見る（会員・月300円）</a>` : ''
    const E = R.entries ?? []
    const maxP = Math.max(...E.map((e) => e.win_probability ?? 0), 1)

    const T = {
      card: () => `<div class="scroll"><table><thead><tr><th class="l">枠・選手</th><th>全国<br>勝率/2連</th><th>当地<br>勝率/2連</th><th>モーター<br>No/2連</th><th>ボート<br>No/2連</th><th>平均ST</th><th>F</th><th>1着確率</th></tr></thead><tbody>${
        E.map((e) => `<tr><td>${waku(e.lane)} <a class="name" href="/racer/${e.racer_id}">${esc(e.name)}</a> ${cls(e.class)}
          <span class="meta">${esc(e.branch ?? '')} ${e.age ?? ''}歳 ${e.weight ?? ''}kg</span></td>
          <td>${dash(e.win_rate_national)}<span class="meta">${dash(e.top2_rate_national, 1)}%</span></td>
          <td>${dash(e.win_rate_local)}<span class="meta">${dash(e.top2_rate_local, 1)}%</span></td>
          <td>${e.motor_no ?? '―'}<span class="meta">${dash(e.motor_top2_rate, 1)}%</span></td>
          <td>${e.boat_no ?? '―'}<span class="meta">${dash(e.boat_top2_rate, 1)}%</span></td>
          <td>${dash(e.avg_st)}</td><td>${e.f_count ? `<span class="best">F${e.f_count}</span>` : '―'}</td>
          <td>${bar(e.win_probability, maxP)}</td></tr>`).join('')}</tbody></table></div>
        <p class="note">平均STは直近60走・Fは過去180日の、当サイトの集計です。1着確率はAIの予想です。</p>`,
      // 基本情報：直近1年の総合（3連対率・ST順位・事故・優勝/優出/準優）
      basic: () => `<div class="scroll"><table><thead><tr><th class="l">枠・選手</th><th>勝率<br>(1年)</th><th>2連/3連</th><th>平均ST<br>ST順位</th><th>事故<br>F/L/失</th><th>優勝/優出/準優<br>(1年)</th><th>同<br>(2022〜)</th><th>前づけ</th></tr></thead><tbody>${
        E.map((e) => { const s = e.stats_1y; if (!s) return `<tr><td>${waku(e.lane)} ${esc(e.name)}</td><td colspan="7">―</td></tr>`
          const a = s.accidents, t = s.titles_since_2022
          return `<tr><td>${waku(e.lane)} <a class="name" href="/racer/${e.racer_id}">${esc(e.name)}</a><span class="meta">${s.starts}走</span></td>
            <td>${pct(s.win_rate)}</td><td>${pct(s.top2_rate)}<span class="meta">${pct(s.top3_rate)}</span></td>
            <td>${dash(s.avg_st)}<span class="meta">${dash(s.avg_st_rank)}位</span></td>
            <td class="${a.flying + a.late + a.disqualified ? 'best' : ''}">${a.flying}/${a.late}/${a.disqualified}<span class="meta">${pct(s.accident_rate)}</span></td>
            <td>${s.yusho}/${s.yushutsu}/${s.junyu}</td><td>${t.yusho}/${t.yushutsu}/${t.junyu}</td><td>${pct(s.maezuke_rate)}</td></tr>` }).join('')}</tbody></table></div>
        <p class="note">直近1年（今日から365日）の出走から集計。ST順位は同じレースの6艇の中の順位の平均。事故＝フライング/出遅れ/失格。</p>`,
      // 枠別情報：その選手が今回入るコースでの成績（展示の進入が分かればそのコース）
      waku: () => `<div class="scroll"><table><thead><tr><th class="l">枠・選手</th><th>コース</th><th>出走</th><th>1着率</th><th>2連/3連</th><th>平均ST<br>ST順位</th><th class="l">決まり手・負け方</th></tr></thead><tbody>${
        E.map((e) => { const c = e.course_stats
          if (!c) return `<tr><td>${waku(e.lane)} ${esc(e.name)}</td><td colspan="6" class="l">このコースの出走なし（直近1年）</td></tr>`
          const how = c.course === 1
            ? `逃げ${pct(c.escape_rate)}・差され${pct(c.lost_to['差され'])}・まくられ${pct(c.lost_to['まくられ'])}・まくり差され${pct(c.lost_to['まくり差され'])}`
            : c.wins_by_kimarite.slice(0, 3).map((k) => `${esc(k.kimarite)}${pct(k.rate)}`).join('・') || '1着なし'
          return `<tr><td>${waku(e.lane)} <a class="name" href="/racer/${e.racer_id}">${esc(e.name)}</a></td><td>${c.course}${c.course !== e.lane ? ' <span class="badge warn">進入変更</span>' : ''}</td>
            <td>${c.starts}</td><td>${pct(c.win_rate)}</td><td>${pct(c.top2_rate)}<span class="meta">${pct(c.top3_rate)}</span></td>
            <td>${dash(c.avg_st)}<span class="meta">${dash(c.avg_st_rank)}位</span></td><td class="l">${how}</td></tr>` }).join('')}</tbody></table></div>
        <p class="note">直近1年・そのコースに入ったときだけの成績。コースは展示の進入（無ければ枠）。</p>`,
      // モータ情報：今期の通算・直近30日・過去の使用者
      motor: () => `<div class="scroll"><table><thead><tr><th class="l">枠・モーター</th><th>今期<br>1着/2連/3連</th><th>直近30日<br>2連/3連</th><th>展示<br>平均</th><th class="l">過去の使用者（着順）</th></tr></thead><tbody>${
        E.map((e) => { const m = e.motor
          if (!m) return `<tr><td>${waku(e.lane)} ―</td><td colspan="4">―</td></tr>`
          return `<tr><td>${waku(e.lane)} <b>${m.motor_no}号機</b><span class="meta">公式2連 ${dash(e.motor_top2_rate, 1)}%</span></td>
            <td>${pct(m.total.win_rate)}/${pct(m.total.top2_rate)}<span class="meta">${pct(m.total.top3_rate)}・${m.total.starts}走</span></td>
            <td>${pct(m.last_30d.top2_rate)}<span class="meta">${pct(m.last_30d.top3_rate)}・${m.last_30d.starts}走</span></td>
            <td>${dash(m.avg_exhibition_recent)}</td>
            <td class="l">${m.users.slice(0, 3).map((u) => `${esc(u.name)}（${esc(u.results)}）`).join('<br>')}</td></tr>` }).join('')}</tbody></table></div>
        <p class="note">今期＝${esc(E.find((e) => e.motor)?.motor?.period_from ?? '―')}以降（モーター入れ替え後）の当サイト集計。公式2連は番組表の値。</p>`,
      // 今節成績
      konsetsu: () => `<div class="scroll"><table><thead><tr><th class="l">枠・選手</th><th class="l">今節の着順</th><th>2連率</th><th>平均ST</th><th class="l">前日までの内訳（日・R・枠→コース・ST・着）</th></tr></thead><tbody>${
        E.map((e) => { const k = e.konsetsu
          return `<tr><td>${waku(e.lane)} <a class="name" href="/racer/${e.racer_id}">${esc(e.name)}</a></td>
            <td class="l"><b>${esc(k?.series_result ?? '―')}</b></td><td>${pct(k?.top2_rate)}</td><td>${dash(k?.avg_st)}</td>
            <td class="l">${(k?.races ?? []).map((x) => `${md(x.date)} ${x.race_no}R ${x.lane}→${x.course ?? '―'} ${x.st == null ? '' : (x.st_flag === 'F' ? 'F' : '') + Number(x.st).toFixed(2)} <b>${esc(x.rank)}</b>`).join('<br>') || '―'}</td></tr>` }).join('')}</tbody></table></div>
        <p class="note">今節の着順は番組表の値（当日の結果は含まない）。内訳は前日までの出走。</p>`,
      before: () => {
        const has = E.some((e) => e.before?.exhibition_time != null)
        if (!E.some((e) => e.before)) return '<p class="empty">直前情報はまだありません（締切の約20分前から入ります）。</p>'
        return `<div class="scroll"><table><thead><tr><th class="l">枠・選手</th><th>展示<br>タイム</th><th>チルト</th><th>部品交換</th><th>進入</th><th>展示ST</th><th>体重<br>調整</th></tr></thead><tbody>${
          E.map((e) => { const b = e.before ?? {}
            return `<tr><td>${waku(e.lane)} <span class="name">${esc(e.name)}</span></td>
              <td class="${b.exhibition_rank === 1 ? 'best' : ''}">${dash(b.exhibition_time)}${b.exhibition_rank ? `<span class="meta">${b.exhibition_rank}位</span>` : ''}</td>
              <td>${dash(b.tilt, 1)}</td><td class="l">${esc(b.parts_changed ?? '')}</td>
              <td>${b.start_course ?? '―'}${b.start_course && b.start_course !== e.lane ? ' <span class="badge warn">前付け</span>' : ''}</td>
              <td>${b.start_st == null ? '―' : (b.start_flag === 'F' ? 'F' : '') + b.start_st.toFixed(2)}</td>
              <td>${dash(b.weight, 1)}<span class="meta">${b.adjust_weight ? '+' + b.adjust_weight : ''}</span></td></tr>` }).join('')}</tbody></table></div>
          ${has ? '' : '<p class="note">展示はまだです。展示が終わると展示タイムと進入が入ります。</p>'}`
      },
      tenkai: () => {
        const t = R.tenkai ?? paid?.tenkai
        if (!t) return R.member_only ? lockPanel('展開予想', R.date) : '<p class="empty">展開予想はまだありません。</p>'
        const km = t.kimarite.slice(0, 5)
        return `<div class="panel"><div class="shape">${esc(t.shape)}</div>
          <ol class="lines">${t.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div>
          <h2>決まり手の確率</h2><div class="panel km">${km.map((k) => `<span>${esc(k.kimarite)}</span><i style="width:${Math.max(2, k.probability)}%"></i><span class="num">${pct(k.probability)}</span>`).join('')}</div>
          <p class="note">${esc(t.basis)}。オッズは使っていません。</p>`
      },
      result: () => {
        if (R.cancelled) return '<p class="empty">このレースは中止・順延になりました。</p>'
        if (!R.result) return '<p class="empty">結果はまだです。</p>'
        const x = R.result
        const order = (x.order_all ?? x.order).split('-')
        const P = x.payouts ?? { '単勝': { amount: x.win_payout }, '3連単': { amount: x.trifecta_payout }, '3連複': { amount: x.trio_payout } }
        const KIND = ['3連単', '3連複', '2連単', '2連複', '拡連複', '単勝', '複勝']
        const rows = KIND.filter((k) => P[k]).flatMap((k) => (Array.isArray(P[k]) ? P[k] : [P[k]]).map((v, i) =>
          `<tr><td class="l">${i ? '' : k}</td><td class="l">${esc(v.combo ?? '')}</td><td>${yen(v.amount)}</td></tr>`)).join('')
        return `<div class="panel"><div class="race-head"><span class="shape">${order.map((l, i) => `<span class="sub">${i + 1}着</span>${l === '-' ? '―' : waku(l)}`).join(' ')}</span>
          ${x.kimarite ? `<span class="badge">${esc(x.kimarite)}</span>` : ''}</div>
          <div class="scroll" style="margin-top:10px"><table><thead><tr><th class="l">券種</th><th class="l">組番</th><th>払戻</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="note">結果の元：${esc(x.source)}（当日は速報、翌日に競走成績で確定）。払戻は100円あたり</p></div>`
      },
      // オッズ（締切前の最新、終わったレースは確定）
      odds: () => {
        const o = R.odds
        if (!o) return '<p class="empty">オッズはまだありません（締切の約20分前から入ります）。</p>'
        const tri = (obj, a) => [1, 2, 3, 4, 5, 6].filter((b) => b !== a)
        const t3 = o.trifecta ? `<h2>3連単</h2><div class="scroll"><table><thead><tr><th class="l">1着</th><th class="l">2着-3着：オッズ</th></tr></thead><tbody>${
          [1, 2, 3, 4, 5, 6].map((a) => `<tr><td class="l">${waku(a)}</td><td class="l" style="white-space:normal">${tri(o.trifecta, a).flatMap((b) => [1, 2, 3, 4, 5, 6].filter((c) => c !== a && c !== b)
            .map((c) => `<span style="display:inline-block;min-width:92px">${b}-${c} <b>${dash(o.trifecta[`${a}-${b}-${c}`], 1)}</b></span>`)).join('')}</td></tr>`).join('')}</tbody></table></div>` : ''
        const list = (obj, sep, title) => obj ? `<h2>${title}</h2><div class="panel" style="display:flex;flex-wrap:wrap;gap:6px 14px">${Object.entries(obj)
          .sort((a, b) => a[1] - b[1]).map(([k, v]) => `<span class="num">${esc(k.split('-').join(sep))} <b>${dash(v, 1)}</b></span>`).join('')}</div>` : ''
        return `<p class="note">${esc(o.kind)}のオッズ${o.taken_at ? `（${esc(o.taken_at)}・締切${o.minutes_before}分前）` : ''}。${esc(o.note ?? '')}</p>
          ${o.win?.length ? `<h2>単勝・複勝</h2><div class="scroll"><table><thead><tr><th class="l">枠</th><th>単勝</th><th>複勝</th></tr></thead><tbody>${
            o.win.map((w, i) => `<tr><td class="l">${waku(w.lane)}</td><td>${dash(w.odds, 1)}</td><td>${o.place?.[i] ? dash(o.place[i].low, 1) + (o.place[i].high ? '〜' + dash(o.place[i].high, 1) : '') : '―'}</td></tr>`).join('')}</tbody></table></div>
            ${o.win_taken ? `<p class="note">単勝・複勝：${esc(o.win_taken)}</p>` : ''}` : ''}
          ${list(o.trio, '=', '3連複（人気順）')}${list(o.exacta, '-', '2連単（人気順）')}${list(o.quinella, '=', '2連複（人気順）')}${t3}`
      },
      // 出目ランク（この場・このレース番号の直近1年）
      demoku: () => {
        const d = R.demoku
        if (!d?.races) return '<p class="empty">データがありません。</p>'
        return `<p class="note">${esc(R.venue)}の${R.race_no}R・${esc(d.period)}の${d.races}レース</p>
          <div class="grid two"><div><h2>よく出た3連単</h2><div class="scroll"><table><thead><tr><th class="l">順位</th><th class="l">組番</th><th>回数</th><th>出現率</th></tr></thead><tbody>${
            d.trifecta_top.map((x, i) => `<tr><td class="l">${i + 1}</td><td class="l">${x.combo.split('-').map((l) => waku(l)).join('')}</td><td>${x.count}</td><td>${pct(x.rate)}</td></tr>`).join('')}</tbody></table></div></div>
          <div><h2>1着の枠</h2><div class="panel km">${d.first_by_lane.map((x) => `<span>${waku(x.lane)}</span><i style="width:${Math.max(2, x.rate)}%"></i><span class="num">${pct(x.rate)}</span>`).join('')}</div></div></div>`
      },
    }
    const TABS = [['card', '出走表'], ['basic', '基本情報'], ['waku', '枠別情報'], ['motor', 'モータ'], ['konsetsu', '今節'],
      ['before', '直前情報'], ['odds', 'オッズ'], ['tenkai', '展開予想'], ['demoku', '出目'], ['result', '結果']]
    tab = TABS.some(([k]) => k === tab) ? tab : (R.result ? 'result' : 'card')
    view(`<div class="race-head"><h1>${esc(R.venue)} ${R.race_no}R</h1><span class="sub">${md(R.date)}(${wd(R.date)}) 締切 ${esc(R.deadline ?? '―')}</span>${state}</div>
      <div class="sub">${esc(R.title ?? '')}　${esc(R.series ?? '')}${R.day_no ? `　${R.day_no}日目` : ''}</div>${conds}
      <nav class="rnav" aria-label="同じ場のレース">${same.map((r) => `<a href="/race/${r.race_id}/${tab}" class="${r.race_id === id ? 'on' : ''}">${r.race_no}R</a>`).join('')}</nav>
      ${free}${aiPick}${!R.closed ? cta : ''}
      <div class="tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${n}</button>`).join('')}</div>
      <div id="tab">${T[tab]()}</div>`)
    app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => navTo(`/race/${id}/${b.dataset.tab}`)))
  }

  // ---------- 展開予想の一覧 ----------
  async function tenkaiList(date) {
    setNav('tenkai')
    date = date || jstToday()
    const tabs = await dayTabs(date, 'tenkai')
    meta(`${md(date)}の展開予想`,
      `${date.replaceAll('-', '/')}の全レースの展開予想。本線・対抗と、逃げ／差し／まくりの決まり手の確率を、直近1年の実測から出しています。`)
    const j = await doc(`tenkai/${date}`)
    if (!j || j.status !== 'ok') return view(`<h1>展開予想</h1>${tabs}<p class="empty">${md(date)} の展開予想はまだありません。</p>`)
    // 会員ぶん。合言葉があれば全レース、無ければ無料枠のレースだけになる
    const mem = j.races.some((r) => r.member_only) ? await paidDoc(`paid/tenkai/${date}`) : null
    const byId = new Map((mem?.races ?? []).map((r) => [r.race_id, r]))
    const locked = !mem && j.races.filter((r) => r.member_only).length
    const rows = [...j.races].map((r) => byId.get(r.race_id) ?? r)
      .sort((a, b) => (a.closed - b.closed) || (a.deadline ?? '').localeCompare(b.deadline ?? ''))
    view(`<h1>展開予想 <span class="sub">${md(date)}(${wd(date)})</span></h1>${tabs}
      ${locked ? lockPanel(`${locked}レースの展開予想`, date) : ''}
      <div class="scroll"><table><thead><tr><th class="l">レース</th><th class="l">展開</th><th class="l">本線</th><th class="l">対抗</th><th class="l">決まり手</th></tr></thead><tbody>${
      rows.map((r) => { const t = r.tenkai
        if (!t) return `<tr style="opacity:.5"><td class="l"><a href="/race/${r.race_id}/tenkai">${esc(r.venue)}${r.race_no}R</a><span class="meta">${esc(r.deadline ?? '')}</span></td>
          <td class="l" colspan="4"><a href="/member">会員の方だけご覧いただけます →</a></td></tr>`
        return `<tr style="${r.closed ? 'opacity:.55' : ''}"><td class="l"><a href="/race/${r.race_id}/tenkai">${esc(r.venue)}${r.race_no}R</a><span class="meta">${esc(r.deadline ?? '')}</span></td>
          <td class="l">${esc(t.shape)}</td>
          <td class="l">${waku(t.honmei.lane)} ${esc(t.honmei.likely_move ?? '')} ${pct(t.honmei.win_probability)}</td>
          <td class="l">${t.taiko ? `${waku(t.taiko.lane)} ${esc(t.taiko.likely_move ?? '')} ${pct(t.taiko.win_probability)}` : '―'}</td>
          <td class="l">${t.kimarite.slice(0, 2).map((k) => `${esc(k.kimarite)}${k.probability.toFixed(0)}%`).join('・')}</td></tr>` }).join('')}</tbody></table></div>`)
  }

  // ---------- 実績 ----------
  async function results() {
    setNav('results')
    const j = await doc('results/30')
    meta('的中実績', '過去30日の的中率と回収率です。締切前に出した予想だけを、外れた日も含めて集計しています。')
    if (!j) return view('<p class="empty">実績はまだありません。</p>')
    const P = j.products, T = j.total
    const cards = Object.keys(P).filter((k) => T[k]).map((k) => `<div class="stat"><span>${esc(P[k])}</span><b>${pct(T[k].hit_rate)}</b>
      <span>的中 ${T[k].hits}/${T[k].races}・回収 ${pct(T[k].return_rate)}</span></div>`).join('')
    const keys = Object.keys(P)
    view(`<h1>実績 <span class="sub">直近${j.days}日（${esc(j.from)}〜${esc(j.to)}）</span></h1>
      <p class="note">${esc(j.note)}</p><div class="stats">${cards}</div>
      <h2>日別</h2><div class="scroll"><table><thead><tr><th class="l">日付</th>${keys.map((k) => `<th>${esc(P[k])}</th>`).join('')}</tr></thead><tbody>${
      j.daily.map((d) => `<tr><td class="l">${md(d.date)}(${wd(d.date)})</td>${keys.map((k) => d[k] ? `<td>${d[k].hits}/${d[k].races}<span class="meta">回収 ${pct(d[k].return_rate)}</span></td>` : '<td>―</td>').join('')}</tr>`).join('')}</tbody></table></div>
      <p class="note">参考：3連複2点の長期の検証値（学習に使っていない175日・2,689レース）は的中率58.9%・回収率83.1%。実績とは別の数字です。</p>`)
  }

  // ---------- 場 ----------
  async function venues() {
    meta('ボートレース場一覧', '全国24か所のボートレース場の特徴・コース別成績・攻略の要点をまとめています。')
        setNav('venues')
    view(`<h1>場情報</h1><div class="races" style="grid-template-columns:repeat(auto-fill,minmax(88px,1fr))">${
      VENUES.slice(1).map((v, i) => `<a class="rc" href="/venue/${i + 1}"><b>${v}</b><small>${String(i + 1).padStart(2, '0')}</small></a>`).join('')}</div>`)
  }
  async function venue(jcd) {
    setNav('venues')
    const [j, G] = await Promise.all([doc(`venue/${jcd}`), doc(`guide/${jcd}`)])
    const V = j?.venue
    meta(`ボートレース${V.venue}の攻略とデータ`,
      `ボートレース${V.venue}の1コース1着率・コース別の決まり手・波や風での変わり方・当地で強い選手を、直近1年の実測からまとめた攻略ページです。`)
    if (!V) return view('<p class="empty">この場のデータはまだありません。</p>')
    const kmBars = (list, key = 'share') => list.map((k) => `<span>${esc(k.kimarite ?? k.label)}</span><i style="width:${Math.max(2, k[key])}%"></i><span class="num">${pct(k[key])}</span>`).join('')
    const cond = V.course1_by_condition ?? {}
    const condBlock = (title, list) => list?.length ? `<div><h3>${title}</h3><div class="panel km">${list.map((k) => `<span>${esc(k.label)}</span><i style="width:${Math.max(2, k.win_rate)}%"></i><span class="num">${pct(k.win_rate)}</span>`).join('')}</div></div>` : ''
    view(`<h1>${esc(V.venue)}の攻略</h1><div class="sub">直近1年（${esc(V.period.from)}〜）のデータから</div>
      <div class="stats" style="margin-top:12px"><div class="stat"><span>1コース1着率</span><b>${pct(V.by_course[0]?.win_rate)}</b></div>
        <div class="stat"><span>3連単の平均配当</span><b>${yen(V.trifecta.avg_payout)}</b></div>
        <div class="stat"><span>万舟率</span><b>${pct(V.trifecta.over_10000_rate)}</b></div></div>
      ${G?.points?.length ? `<h2>攻略の要点</h2><div class="panel guide"><ul>${G.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><p class="note">${esc(G.points_note)}</p></div>` : ''}
      ${G?.manual ? `<h2>${esc(G.manual.title)}</h2><div class="panel article-body">${G.manual.html}</div>${G.manual.updated ? `<p class="note">更新：${esc(G.manual.updated)}</p>` : ''}` : ''}
      ${G?.related_news?.length ? `<h2>${esc(V.venue)}のニュース</h2><div class="news-list">${G.related_news.map((n) => `<a class="news-item" href="/news/${esc(n.slug)}"><span class="news-date">${n.date ? md(n.date) : ''}</span><b>${esc(n.title)}</b></a>`).join('')}</div>` : ''}
      <h2>コース別</h2><div class="scroll"><table><thead><tr><th class="l">コース</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>出走</th></tr></thead><tbody>${
        V.by_course.map((c) => `<tr><td class="l">${waku(c.course)}</td><td>${bar(c.win_rate, V.by_course[0].win_rate)}</td><td>${pct(c.top2_rate)}</td><td>${pct(c.top3_rate)}</td><td>${c.starts.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>
      <h2>1コースの1着率が条件でどう変わるか</h2><div class="grid two">${condBlock('時間帯', cond.time)}${condBlock('波の高さ', cond.wave)}${condBlock('風の強さ', cond.wind)}${condBlock('グレード', cond.grade)}</div>
      <h2>コースごとの勝ち方</h2><div class="scroll"><table><thead><tr><th class="l">コース</th><th>1着数</th><th class="l">決まり手</th></tr></thead><tbody>${
        (V.kimarite_by_course ?? []).map((c) => `<tr><td class="l">${waku(c.course)}</td><td>${c.wins}</td><td class="l">${c.kimarite.slice(0, 3).map((k) => `${esc(k.kimarite)} ${pct(k.share)}`).join('・')}</td></tr>`).join('')}</tbody></table></div>
      <h2>1コースの強さ（レース番号別）</h2><div class="panel km">${V.course1_win_rate_by_race_no.map((k) => `<span>${k.race_no}R</span><i style="width:${Math.max(2, k.win_rate)}%"></i><span class="num">${pct(k.win_rate)}</span>`).join('')}</div>
      <h2>決まり手（全体）</h2><div class="panel km">${kmBars(V.kimarite)}</div>
      ${V.local_top?.length ? `<h2>当地で強い選手</h2><div class="scroll"><table><thead><tr><th class="l">選手</th><th>出走</th><th>1着率</th><th>2連対率</th></tr></thead><tbody>${
        V.local_top.map((r) => `<tr><td class="l"><a class="name" href="/racer/${r.racer_id}">${esc(r.name)}</a> ${cls(r.class)}</td><td>${r.starts}</td><td>${pct(r.win_rate)}</td><td>${pct(r.top2_rate)}</td></tr>`).join('')}</tbody></table></div><p class="note">${esc(V.local_top_note)}</p>` : ''}`)
  }

  // ---------- 選手 ----------
  const statRow = (label, s) => `<tr><td class="l">${label}</td><td>${s.starts}</td><td>${pct(s.win_rate)}</td><td>${pct(s.top2_rate)}</td><td>${pct(s.top3_rate)}</td><td>${dash(s.avg_st)}</td><td>${dash(s.avg_st_rank)}</td></tr>`
  const statHead = (first) => `<thead><tr><th class="l">${first}</th><th>出走</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>平均ST</th><th>ST順位</th></tr></thead>`
  async function racer(id) {
    setNav('racers')
    const j = await doc(`racer/${id}`)
    const P = j?.racer
    meta(`${P.name}（${P.racer_id}）の成績データ`,
      `競艇選手 ${P.name}（登番${P.racer_id}・${P.branch ?? ''}・${P.class ?? ''}）の勝率・コース別成績・平均ST・場別の成績・直近の出走をまとめています。`,
      { ld: { '@context': 'https://schema.org', '@type': 'Person', name: P.name, identifier: String(P.racer_id),
        jobTitle: '競艇選手', affiliation: P.branch ?? undefined } })
    if (!P) return view('<p class="empty">この選手のデータはまだありません（直近180日に出走した選手を掲載しています）。</p>')
    const S = P.summary_1y, A = S.accidents, T2 = P.titles_since_2022
    const c1 = P.by_course.find((c) => c.course === 1)
    view(`<h1>${esc(P.name)} ${cls(P.class)}</h1><div class="sub">${esc(P.kana ?? '')}　登番${P.racer_id}　${esc(P.branch ?? '')}支部　${P.age ?? ''}歳　${P.height ?? ''}cm/${P.weight ?? ''}kg　${esc(P.blood ?? '')}型</div>
      ${P.upcoming?.length ? `<div class="panel" style="margin-top:12px"><b>出場予定</b>${P.upcoming.map((m) => `<div><a href="/meeting/${m.jcd}/${m.start_date}">${md(m.start_date)}〜${md(m.end_date)} ${esc(m.venue)}</a> ${gradeBadge(m.grade)} <span class="sub">${esc(m.title)}</span></div>`).join('')}</div>` : ''}
      ${P.today?.length ? `<div class="panel freepick" style="margin-top:12px"><b>本日の出走</b>　${P.today.map((t) => `<a href="/race/${t.race_id}">${esc(t.venue)}${t.race_no}R（${t.lane}号艇）</a>`).join('　')}</div>` : ''}
      <div class="stats" style="margin-top:12px">
        <div class="stat"><span>勝率（${esc(P.period ?? '')}期）</span><b>${dash(P.official.win_rate)}</b></div>
        <div class="stat"><span>2連対率（同）</span><b>${pct(P.official.top2_rate)}</b></div>
        <div class="stat"><span>直近1年 3連対率</span><b>${pct(S.top3_rate)}</b></div>
        <div class="stat"><span>平均ST・ST順位</span><b>${dash(S.avg_st)}</b><span>${dash(S.avg_st_rank)}位</span></div>
        <div class="stat"><span>優勝/優出/準優（1年）</span><b>${S.yusho}/${S.yushutsu}/${S.junyu}</b><span>2022年〜 ${T2.yusho}/${T2.yushutsu}/${T2.junyu}</span></div>
        <div class="stat"><span>事故（1年）F/L/失格</span><b>${A.flying}/${A.late}/${A.disqualified}</b><span>事故率 ${pct(S.accident_rate)}</span></div>
      </div>
      ${c1 ? `<h2>1コースのとき</h2><div class="stats">
        <div class="stat"><span>逃げ率</span><b>${pct(c1.escape_rate)}</b><span>${c1.starts}走</span></div>
        <div class="stat"><span>差され</span><b>${pct(c1.lost_to['差され'])}</b></div>
        <div class="stat"><span>まくられ</span><b>${pct(c1.lost_to['まくられ'])}</b></div>
        <div class="stat"><span>まくり差され</span><b>${pct(c1.lost_to['まくり差され'])}</b></div></div>` : ''}
      <h2>コース別（直近1年）</h2><div class="scroll"><table>${statHead('コース')}<tbody>${P.by_course.map((c) => statRow(waku(c.course), c)).join('')}</tbody></table></div>
      <h2>コース別の勝ち方</h2><div class="scroll"><table><thead><tr><th class="l">コース</th><th class="l">決まり手（そのコースの出走に対する割合）</th><th class="l">直近5走（着）</th></tr></thead><tbody>${
        P.by_course.map((c) => `<tr><td class="l">${waku(c.course)}</td><td class="l">${c.wins_by_kimarite.map((k) => `${esc(k.kimarite)} ${k.count}回（${pct(k.rate)}）`).join('・') || '1着なし'}</td>
          <td class="l">${c.recent.map((x) => `<b>${esc(x.rank)}</b>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
      <h2>場別（直近1年）</h2><div class="scroll"><table>${statHead('場')}<tbody>${P.by_venue.map((v) => statRow(`<a href="/venue/${v.jcd}">${esc(v.venue)}</a>`, v)).join('')}</tbody></table></div>
      <div class="grid two"><div><h2>グレード別</h2><div class="scroll"><table>${statHead('グレード')}<tbody>${P.by_grade.map((g) => statRow(esc(g.grade), g)).join('')}</tbody></table></div></div>
        <div><h2>時間帯別</h2><div class="scroll"><table>${statHead('時間帯')}<tbody>${P.by_time.map((g) => statRow(esc(g.band), g)).join('')}${P.by_wave.map((g) => statRow(esc(g.band), g)).join('')}</tbody></table></div></div></div>
      <h2>進入</h2><div class="stats"><div class="stat"><span>前づけ（枠より内へ）</span><b>${pct(P.maezuke.inward_rate)}</b><span>${P.maezuke.inward}回/${P.maezuke.starts}走</span></div>
        <div class="stat"><span>外へ出た</span><b>${pct(P.maezuke.outward_rate)}</b><span>${P.maezuke.outward}回</span></div></div>
      <h2>最近の節</h2><div class="scroll"><table><thead><tr><th class="l">期間</th><th class="l">場・開催</th><th class="l">着順</th><th class="l">結果</th></tr></thead><tbody>${
        P.series_recent.map((s) => `<tr><td class="l">${md(s.from)}〜${md(s.to)}</td><td class="l">${esc(s.venue)}<span class="meta">${esc(s.grade)}　${esc(s.series ?? '')}</span></td>
          <td class="l"><b>${esc(s.line)}</b></td><td class="l">${s.finals ? `<span class="badge${s.finals === '優勝' ? ' warn' : ''}">${esc(s.finals)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <h2>期別成績</h2><div class="scroll"><table><thead><tr><th class="l">期</th><th>級別</th><th>勝率</th><th>2連対率</th><th>出走</th><th>1着</th><th>2着</th></tr></thead><tbody>${
        P.periods.map((x) => `<tr><td class="l">${esc(x.period)}</td><td>${cls(x.class)}</td><td>${dash(x.win_rate)}</td><td>${pct(x.top2_rate)}</td><td>${x.starts ?? '―'}</td><td>${x.firsts ?? '―'}</td><td>${x.seconds ?? '―'}</td></tr>`).join('')}</tbody></table></div>
      <h2>直近20走</h2><div class="scroll"><table><thead><tr><th class="l">日付</th><th class="l">場</th><th>R</th><th>枠</th><th>進入</th><th>ST</th><th>着</th><th class="l">決まり手</th></tr></thead><tbody>${
        P.recent.map((x) => `<tr><td class="l">${md(x.date)}</td><td class="l">${esc(x.venue)}</td><td>${x.race_no}</td><td>${waku(x.lane)}</td><td>${x.course ?? '―'}</td>
          <td>${x.st == null ? '―' : (x.st_flag === 'F' ? 'F' : '') + Number(x.st).toFixed(2)}</td><td class="${x.rank === 1 ? 'best' : ''}">${esc(x.rank ?? '―')}</td><td class="l">${esc(x.kimarite ?? '')}</td></tr>`).join('')}</tbody></table></div>
      <p class="note">${esc(P.period_note)}</p>`)
  }

  // ---------- 選手一覧 ----------
  async function racers(q) {
    setNav('racers')
    const j = await doc('racers')
    meta('競艇選手一覧', '直近180日に出走した競艇選手の一覧です。名前や登番から、勝率・コース別成績・平均STを調べられます。')
    if (!j) return view('<p class="empty">選手一覧はまだありません。</p>')
    const all = j.racers
    const draw = (s) => {
      const k = s.trim()
      const hit = k ? all.filter((r) => (r.name ?? '').includes(k) || (r.kana ?? '').includes(k) || String(r.racer_id).startsWith(k) || (r.branch ?? '').includes(k)) : all
      document.getElementById('rl').innerHTML = hit.slice(0, 300).map((r) => `<tr><td class="l"><a class="name" href="/racer/${r.racer_id}">${esc(r.name)}</a> ${cls(r.class)}<span class="meta">${esc(r.kana ?? '')}</span></td>
        <td>${r.racer_id}</td><td class="l">${esc(r.branch ?? '')}</td><td>${r.age ?? '―'}</td><td>${dash(r.win_rate)}</td><td>${pct(r.top2_rate)}</td></tr>`).join('')
      document.getElementById('rc').textContent = `${hit.length}人${hit.length > 300 ? '（上位300人を表示）' : ''}`
    }
    view(`<h1>選手一覧 <span class="sub">直近180日に出走した${all.length}人・勝率順</span></h1>
      <input id="q" type="search" placeholder="名前・カナ・登番・支部で探す" value="${esc(q ?? '')}"
        style="width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);margin:10px 0">
      <p class="sub" id="rc"></p>
      <div class="scroll"><table><thead><tr><th class="l">選手</th><th>登番</th><th class="l">支部</th><th>年齢</th><th>勝率</th><th>2連対率</th></tr></thead><tbody id="rl"></tbody></table></div>`)
    const inp = document.getElementById('q')
    inp.addEventListener('input', () => draw(inp.value))
    draw(inp.value)
  }

  // ---------- 開催予定 ----------
  const gradeBadge = (g) => (!g || g === '一般' ? '<span class="badge gray">一般</span>' : `<span class="badge warn">${esc(g)}</span>`)
  async function schedule() {
    setNav('schedule')
    const j = await doc('schedule')
    meta('ボートレース開催予定', '全国24場の開催予定と、SG・G1・G2・G3のグレードレースの日程・出場予定選手をまとめています。')
    if (!j?.meetings?.length) return view('<h1>開催予定</h1><p class="empty">開催予定はまだありません。</p>')
    const big = j.meetings.filter((m) => ['SG', 'G1', 'G2', 'G3'].includes(m.grade))
    const row = (m) => `<tr><td class="l">${md(m.start_date)}〜${md(m.end_date)}<span class="meta">${m.days}日間</span></td>
      <td class="l"><a href="/venue/${m.jcd}">${esc(m.venue)}</a></td><td class="l">${gradeBadge(m.grade)}</td>
      <td class="l" style="white-space:normal"><a href="/meeting/${m.jcd}/${m.start_date}">${esc(m.title)}</a></td><td>${m.racers ? m.racers + '人' : '―'}</td></tr>`
    view(`<h1>開催予定 <span class="sub">${md(j.from)}〜${md(j.to)}・${j.meetings.length}開催</span></h1>
      ${big.length ? `<h2>グレードレース</h2><div class="scroll"><table><tbody>${big.map(row).join('')}</tbody></table></div>` : ''}
      <h2>すべての開催</h2><div class="scroll"><table><thead><tr><th class="l">期間</th><th class="l">場</th><th class="l">グレード</th><th class="l">開催名</th><th>出場予定</th></tr></thead><tbody>${j.meetings.map(row).join('')}</tbody></table></div>
      <p class="note">公式の月間スケジュールとあっせん（出場予定選手）から。出場予定は変わることがあります。</p>`)
  }
  async function meeting(jcd, start) {
    setNav('schedule')
    const j = await doc(`meeting/${jcd}/${start}`)
    const M = j?.meeting
    meta(`${M.venue} ${M.title ?? ''}の出場選手`,
      `${M.venue}で${(M.start_date ?? '').replaceAll('-', '/')}から行われる${M.title ?? '開催'}（${M.grade ?? '一般'}）の日程と出場予定選手です。`)
    if (!M) return view('<p class="empty">この開催のデータはまだありません。</p>')
    view(`<h1>${esc(M.venue)} ${gradeBadge(M.grade)}</h1><div class="sub">${esc(M.title)}　${md(M.start_date)}〜${md(M.end_date)}（${M.days}日間）</div>
      <h2>出場予定選手 <span class="sub">${M.racers.length}人・勝率順</span></h2>
      <div class="scroll"><table><thead><tr><th class="l">選手</th><th>登番</th><th class="l">支部</th><th>勝率</th></tr></thead><tbody>${
        M.racers.map((r) => `<tr><td class="l"><a class="name" href="/racer/${r.racer_id}">${esc(r.name)}</a> ${cls(r.class)}</td><td>${r.racer_id}</td><td class="l">${esc(r.branch ?? '')}</td><td>${dash(r.win_rate)}</td></tr>`).join('')}</tbody></table></div>
      <p class="note">公式のあっせん情報から。欠場・追加あっせんで変わることがあります。</p>`)
  }

  // ---------- データ分析 ----------
  async function analysis(kind) {
    setNav('analysis')
    const KINDS = [['average', 'コース別平均'], ['ranking', 'コース別ランキング'], ['demoku', '出目分析'], ['yusho', '優勝戦']]
    kind = KINDS.some(([k]) => k === kind) ? kind : 'average'
    meta(`${KINDS.find(([k]) => k === kind)[1]}｜競艇データ分析`,
      `競艇の${KINDS.find(([k]) => k === kind)[1]}。全国24場の直近1年の実測データから集計しています。`)
    const j = await doc(`analysis/${kind}`)
    const tabs = `<div class="tabs" role="tablist">${KINDS.map(([k, n]) => `<button role="tab" aria-selected="${k === kind}" data-k="${k}">${n}</button>`).join('')}</div>`
    let body = '<p class="empty">データがありません。</p>'
    if (j && kind === 'average') {
      const tbl = (cs) => `<div class="scroll"><table><thead><tr><th class="l">コース</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>平均ST</th><th class="l">決まり手</th></tr></thead><tbody>${
        cs.map((c) => `<tr><td class="l">${waku(c.course)}</td><td>${bar(c.win_rate, 60)}</td><td>${pct(c.top2_rate)}</td><td>${pct(c.top3_rate)}</td><td>${dash(c.avg_st)}</td>
          <td class="l">${c.kimarite.slice(0, 3).map((k) => `${esc(k.kimarite)}${pct(k.share)}`).join('・')}</td></tr>`).join('')}</tbody></table></div>`
      body = `<p class="note">直近1年（${esc(j.period.from)}〜）</p><h2>全国</h2>${tbl(j.national)}
        <h2>場ごと</h2><div class="grid two">${j.venues.map((v) => `<div><h2 style="margin-top:6px"><a href="/venue/${v.jcd}">${esc(v.venue)}</a></h2>${tbl(v.courses)}</div>`).join('')}</div>`
    }
    if (j && kind === 'ranking') {
      body = `<p class="note">${esc(j.rule)}</p>${j.by_course.map((c) => `<h2>${waku(c.course)} コースの1着率</h2><div class="scroll"><table><thead><tr><th class="l">順位</th><th class="l">選手</th><th>出走</th><th>1着率</th><th>2連/3連</th><th>平均ST</th></tr></thead><tbody>${
        c.top.slice(0, 15).map((r, i) => `<tr><td class="l">${i + 1}</td><td class="l"><a class="name" href="/racer/${r.racer_id}">${esc(r.name)}</a> ${cls(r.class)}<span class="meta">${esc(r.branch ?? '')}</span></td>
          <td>${r.starts}</td><td>${pct(r.win_rate)}</td><td>${pct(r.top2_rate)}<span class="meta">${pct(r.top3_rate)}</span></td><td>${dash(r.avg_st)}</td></tr>`).join('')}</tbody></table></div>`).join('')}
        <h2>スタートが速い選手</h2><div class="scroll"><table><thead><tr><th class="l">順位</th><th class="l">選手</th><th>出走</th><th>平均ST</th></tr></thead><tbody>${
          j.fastest_start.slice(0, 20).map((r, i) => `<tr><td class="l">${i + 1}</td><td class="l"><a class="name" href="/racer/${r.racer_id}">${esc(r.name)}</a> ${cls(r.class)}</td><td>${r.starts}</td><td>${dash(r.avg_st)}</td></tr>`).join('')}</tbody></table></div>`
    }
    if (j && kind === 'demoku') {
      const blk = (d) => `<div class="stats"><div class="stat"><span>レース</span><b>${d.races.toLocaleString()}</b></div><div class="stat"><span>3連単の平均配当</span><b>${yen(d.avg_payout)}</b></div>
          <div class="stat"><span>万舟率</span><b>${pct(d.over_10000_rate)}</b></div></div>
        <div class="grid two" style="margin-top:10px"><div class="scroll"><table><thead><tr><th class="l">順位</th><th class="l">3連単</th><th>回数</th><th>出現率</th></tr></thead><tbody>${
          d.trifecta_top.slice(0, 10).map((x, i) => `<tr><td class="l">${i + 1}</td><td class="l">${x.combo.split('-').map((l) => waku(l)).join('')}</td><td>${x.count}</td><td>${pct(x.rate)}</td></tr>`).join('')}</tbody></table></div>
          <div class="panel km">${d.first_by_lane.map((x) => `<span>${waku(x.lane)} 1着</span><i style="width:${Math.max(2, x.rate)}%"></i><span class="num">${pct(x.rate)}</span>`).join('')}</div></div>`
      body = `<p class="note">直近1年（${esc(j.period.from)}〜）</p><h2>全国</h2>${blk(j.national)}
        <h2>場ごと</h2><select id="dv" style="font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink)">${
          j.venues.map((v, i) => `<option value="${i}">${esc(v.venue)}</option>`).join('')}</select><div id="dvb" style="margin-top:10px">${blk(j.venues[0])}</div>`
    }
    if (j && kind === 'yusho') {
      const tbl = (rs) => `<div class="scroll"><table><thead><tr><th class="l">日付</th><th class="l">場・開催</th><th class="l">優勝</th><th class="l">着順</th><th class="l">決まり手</th><th>3連単</th></tr></thead><tbody>${
        rs.map((r) => `<tr><td class="l">${md(r.date)}</td><td class="l">${esc(r.venue)} ${gradeBadge(r.grade)}<span class="meta">${esc(r.series ?? '')}</span></td>
          <td class="l">${r.winner ? `${waku(r.winner.lane)} <a class="name" href="/racer/${r.winner.racer_id}">${esc(r.winner.name)}</a>` : '―'}</td>
          <td class="l">${esc(r.order)}</td><td class="l">${esc(r.kimarite ?? '')}</td><td>${yen(r.trifecta_payout)}</td></tr>`).join('')}</tbody></table></div>`
      body = `${j.big.length ? `<h2>SG・G1・G2</h2>${tbl(j.big)}` : ''}<h2>すべての優勝戦 <span class="sub">${esc(j.period)}</span></h2>${tbl(j.races)}`
    }
    view(`<h1>データ分析</h1>${tabs}${body}`)
    app.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => navTo(`/analysis/${b.dataset.k}`)))
    const dv = document.getElementById('dv')
    if (dv) dv.addEventListener('change', () => {
      const d = j.venues[Number(dv.value)]
      document.getElementById('dvb').innerHTML = `<div class="stats"><div class="stat"><span>レース</span><b>${d.races.toLocaleString()}</b></div><div class="stat"><span>3連単の平均配当</span><b>${yen(d.avg_payout)}</b></div><div class="stat"><span>万舟率</span><b>${pct(d.over_10000_rate)}</b></div></div>
        <div class="grid two" style="margin-top:10px"><div class="scroll"><table><tbody>${d.trifecta_top.slice(0, 10).map((x, i) => `<tr><td class="l">${i + 1}</td><td class="l">${x.combo.split('-').map((l) => waku(l)).join('')}</td><td>${x.count}</td><td>${pct(x.rate)}</td></tr>`).join('')}</tbody></table></div>
        <div class="panel km">${d.first_by_lane.map((x) => `<span>${waku(x.lane)} 1着</span><i style="width:${Math.max(2, x.rate)}%"></i><span class="num">${pct(x.rate)}</span>`).join('')}</div></div>`
    })
  }

  // ---------- ニュース ----------
  const newsItem = (n) => `<a class="news-item" href="/news/${esc(n.slug)}"><span class="news-date">${n.date ? md(n.date) : ''}</span>
    <b>${esc(n.title)}</b>${n.summary ? `<span class="news-sum">${esc(n.summary.slice(0, 70))}…</span>` : ''}</a>`
  async function newsList(tag) {
    setNav('news')
    const j = await doc('news/index')
    meta(tag ? `${tag}のニュース` : '競艇ニュース',
      tag ? `${tag}に関する競艇のニュース・データのまとめです。` : '前日の優勝戦・高配当ランキング・今日の開催・グレードレースの予告など、競艇のニュースをデータからまとめています。')
    const all = j?.articles ?? []
    const tags = [...new Set(all.flatMap((n) => n.tags ?? []))].slice(0, 12)
    const list = tag ? all.filter((n) => (n.tags ?? []).includes(tag)) : all
    view(`<h1>ニュース</h1>
      ${tags.length ? `<div class="chips"><a href="/news" class="${tag ? '' : 'on'}">すべて</a>${tags.map((t) => `<a href="/news/tag/${encodeURIComponent(t)}" class="${t === tag ? 'on' : ''}">${esc(t)}</a>`).join('')}</div>` : ''}
      <div class="news-list">${list.map(newsItem).join('') || '<p class="empty">記事はまだありません。</p>'}</div>`)
  }
  async function article(slug) {
    setNav('news')
    const a = await doc(`news/${slug}`)
    meta(a.title, (a.summary ?? a.title).slice(0, 110),
      { article: true, ld: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: a.title,
        datePublished: a.date ?? undefined, dateModified: a.date ?? undefined,
        publisher: { '@type': 'Organization', name: SITE } } })
    if (!a) return view('<p class="empty">この記事は見つかりません。</p>')
    view(`<article class="article"><div class="sub">${a.date ? md(a.date) : ''}${(a.tags ?? []).map((t) => ` <a class="badge" href="/news/tag/${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>
      <h1>${esc(a.title)}</h1><div class="article-body">${a.html}</div>
      ${a.venue ? `<p><a href="/venue/${a.venue}">${VENUES[a.venue]}の攻略ページへ →</a></p>` : ''}
      <p class="note">予想は的中を約束するものではありません。舟券の購入は20歳からです。</p>
      <p><a href="/news">← ニュース一覧へ</a></p></article>`)
  }

  // ---------- 振り分け ----------
  // URL は実際のパス（/race/… ）。ハッシュ（#/race/… ）だと検索エンジンから見て1ページしか無いことになり、
  // どのページも検索に出てこない。古い #/ のURLは実URLへ送る。
  function navTo(path, replace) {
    if (location.pathname + location.search === path) return
    history[replace ? 'replaceState' : 'pushState'](null, '', path)
    route()
  }
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target.closest?.('a')
    const href = a?.getAttribute('href')
    if (!href) return
    if (C.noteUrl && href === C.noteUrl) track('member_click', { page_path: location.pathname })   // 申し込みへ進んだ数
    if (href === '/member') track('member_page', { page_path: location.pathname })
    if (!href.startsWith('/') || a.target === '_blank') return
    e.preventDefault(); navTo(href)
  })
  window.addEventListener('popstate', route)

  async function route() {
    if (location.hash.startsWith('#/')) return navTo(location.hash.slice(1), true)
    const p = location.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    try {
      if (!p[0]) return await home()
      if (p[0] === 'd') return await home(p[1])
      if (p[0] === 'race') return await race(p[1], p[2])
      if (p[0] === 'tenkai') return await tenkaiList(p[1])
      if (p[0] === 'results') return await results()
      if (p[0] === 'venues') return await venues()
      if (p[0] === 'venue') return await venue(Number(p[1]))
      if (p[0] === 'racer') return await racer(Number(p[1]))
      if (p[0] === 'racers') return await racers(decodeURIComponent(p[1] ?? ''))
      if (p[0] === 'news' && p[1] === 'tag') return await newsList(decodeURIComponent(p[2] ?? ''))
      if (p[0] === 'news' && p[1]) return await article(p[1])
      if (p[0] === 'news') return await newsList()
      if (p[0] === 'schedule') return await schedule()
      if (p[0] === 'meeting') return await meeting(Number(p[1]), p[2])
      if (p[0] === 'analysis') return await analysis(p[1])
      if (p[0] === 'member') return await memberPage()
      return await home()
    } catch (e) { fail(e) }
    finally { trackPage() }
  }
  document.querySelector('.more-btn')?.addEventListener('click', (e) => {
    const m = document.getElementById('more'); m.hidden = !m.hidden
    e.currentTarget.setAttribute('aria-expanded', String(!m.hidden))
  })
  window.addEventListener('hashchange', route)   // 古い #/ のURLで来た人を実URLへ送るため
  route()
})()
