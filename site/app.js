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
      const r = await fetch('_local/' + key.replace(/\//g, '__') + '.json', { cache: 'no-store' })
      return r.ok ? r.json() : null
    })()
    cache.set(key, p)
    setTimeout(() => cache.delete(key), 120_000)   // 直前情報が入るので2分で読み直す
    return p
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
  const setNav = (k) => document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === k))
  const view = (html) => { app.innerHTML = html; window.scrollTo(0, 0) }
  const fail = (e) => view(`<p class="empty">${esc(e.message || e)}</p>`)

  async function dayTabs(active, base) {
    const meta = await doc('meta')
    const dates = meta?.dates?.length ? meta.dates : [jstToday()]
    if (meta?.updated_at) document.getElementById('updated').textContent = `データ更新：${meta.updated_at}`
    return `<div class="days">${dates.map((d) => `<a href="#/${base}/${d}" class="${d === active ? 'on' : ''}">${md(d)}(${wd(d)})${d === jstToday() ? ' 今日' : ''}</a>`).join('')}</div>`
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
        return `<a class="${c}" href="#/race/${r.race_id}"><b>${r.race_no}R</b><small>${sub}</small></a>`
      }).join('')
      return `<section class="venue"><div class="venue-head"><a class="venue-name" href="#/venue/${jcd}" style="color:inherit;text-decoration:none">${VENUES[jcd]}</a>
        ${g}<span class="venue-series">${esc(r0.series ?? '')}${r0.day_no ? `　${r0.day_no}日目${r0.series_days ? '/' + r0.series_days : ''}` : ''}</span></div>
        <div class="races">${chips}</div></section>`
    }).join('')
    view(`<h1>出走表 <span class="sub">${md(date)}(${wd(date)})・${byV.size}場 ${j.races.length}レース</span></h1>${tabs}${status}
      <h2>レース一覧</h2><div class="grid">${venues}</div>
      <p class="note">「無料」の付いたレースは、1着確率80%以上の本命を単勝1点で無料公開しています。橙の枠は次に締め切るレースです。</p>`)
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
    const state = R.cancelled ? '<span class="badge gray">中止・順延</span>' : R.result ? '<span class="badge gray">確定</span>' : R.closed ? '<span class="badge gray">締切</span>' : ''
    const free = R.free_pick ? `<div class="panel freepick"><b>無料予想</b>　単勝 ${waku(R.free_pick.lane)} ${esc(R.free_pick.racer ?? '')}（1着確率 ${pct(R.free_pick.probability)}）
      ${R.free_pick.hit == null ? '' : R.free_pick.hit ? `<span class="hit">的中 ${yen(R.free_pick.payout)}</span>` : '<span class="miss">不的中</span>'}</div>` : ''
    const cta = C.noteUrl ? `<a class="cta" href="${esc(C.noteUrl)}" target="_blank" rel="noopener">このレースの買い目（3連複2点）はnoteで</a>` : ''
    const E = R.entries ?? []
    const maxP = Math.max(...E.map((e) => e.win_probability ?? 0), 1)

    const T = {
      card: () => `<div class="scroll"><table><thead><tr><th class="l">枠・選手</th><th>全国<br>勝率/2連</th><th>当地<br>勝率/2連</th><th>モーター<br>No/2連</th><th>ボート<br>No/2連</th><th>平均ST</th><th>F</th><th>1着確率</th></tr></thead><tbody>${
        E.map((e) => `<tr><td>${waku(e.lane)} <a class="name" href="#/racer/${e.racer_id}">${esc(e.name)}</a> ${cls(e.class)}
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
          return `<tr><td>${waku(e.lane)} <a class="name" href="#/racer/${e.racer_id}">${esc(e.name)}</a><span class="meta">${s.starts}走</span></td>
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
          return `<tr><td>${waku(e.lane)} <a class="name" href="#/racer/${e.racer_id}">${esc(e.name)}</a></td><td>${c.course}${c.course !== e.lane ? ' <span class="badge warn">進入変更</span>' : ''}</td>
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
          return `<tr><td>${waku(e.lane)} <a class="name" href="#/racer/${e.racer_id}">${esc(e.name)}</a></td>
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
        const t = R.tenkai
        if (!t) return '<p class="empty">展開予想はまだありません。</p>'
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
        return `<div class="panel"><div class="race-head"><span class="shape">${x.order.split('-').map((l) => waku(l)).join(' ')}</span>
          ${x.kimarite ? `<span class="badge">${esc(x.kimarite)}</span>` : ''}</div>
          <div class="scroll" style="margin-top:10px"><table><tbody>
          <tr><td class="l">単勝</td><td>${yen(x.win_payout)}</td></tr>
          <tr><td class="l">3連単</td><td>${yen(x.trifecta_payout)}</td></tr>
          <tr><td class="l">3連複</td><td>${yen(x.trio_payout)}</td></tr></tbody></table></div>
          <p class="note">結果の元：${esc(x.source)}（当日は速報、翌日に競走成績で確定）</p></div>`
      },
    }
    const TABS = [['card', '出走表'], ['basic', '基本情報'], ['waku', '枠別情報'], ['motor', 'モータ'], ['konsetsu', '今節'],
      ['before', '直前情報'], ['tenkai', '展開予想'], ['result', '結果']]
    tab = TABS.some(([k]) => k === tab) ? tab : (R.result ? 'result' : 'card')
    view(`<div class="race-head"><h1>${esc(R.venue)} ${R.race_no}R</h1><span class="sub">${md(R.date)}(${wd(R.date)}) 締切 ${esc(R.deadline ?? '―')}</span>${state}</div>
      <div class="sub">${esc(R.title ?? '')}　${esc(R.series ?? '')}${R.day_no ? `　${R.day_no}日目` : ''}</div>${conds}
      <nav class="rnav" aria-label="同じ場のレース">${same.map((r) => `<a href="#/race/${r.race_id}/${tab}" class="${r.race_id === id ? 'on' : ''}">${r.race_no}R</a>`).join('')}</nav>
      ${free}${!R.closed && j.race && (day?.races ?? []).find((r) => r.race_id === id)?.has_paid_picks ? cta : ''}
      <div class="tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${n}</button>`).join('')}</div>
      <div id="tab">${T[tab]()}</div>`)
    app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/race/${id}/${b.dataset.tab}` }))
  }

  // ---------- 展開予想の一覧 ----------
  async function tenkaiList(date) {
    setNav('tenkai')
    date = date || jstToday()
    const tabs = await dayTabs(date, 'tenkai')
    const j = await doc(`tenkai/${date}`)
    if (!j || j.status !== 'ok') return view(`<h1>展開予想</h1>${tabs}<p class="empty">${md(date)} の展開予想はまだありません。</p>`)
    const rows = [...j.races].sort((a, b) => (a.closed - b.closed) || (a.deadline ?? '').localeCompare(b.deadline ?? ''))
    view(`<h1>展開予想 <span class="sub">${md(date)}(${wd(date)})</span></h1>${tabs}
      <div class="scroll"><table><thead><tr><th class="l">レース</th><th class="l">展開</th><th class="l">本線</th><th class="l">対抗</th><th class="l">決まり手</th></tr></thead><tbody>${
      rows.map((r) => { const t = r.tenkai; if (!t) return ''
        return `<tr style="${r.closed ? 'opacity:.55' : ''}"><td class="l"><a href="#/race/${r.race_id}/tenkai">${esc(r.venue)}${r.race_no}R</a><span class="meta">${esc(r.deadline ?? '')}</span></td>
          <td class="l">${esc(t.shape)}</td>
          <td class="l">${waku(t.honmei.lane)} ${esc(t.honmei.likely_move ?? '')} ${pct(t.honmei.win_probability)}</td>
          <td class="l">${t.taiko ? `${waku(t.taiko.lane)} ${esc(t.taiko.likely_move ?? '')} ${pct(t.taiko.win_probability)}` : '―'}</td>
          <td class="l">${t.kimarite.slice(0, 2).map((k) => `${esc(k.kimarite)}${k.probability.toFixed(0)}%`).join('・')}</td></tr>` }).join('')}</tbody></table></div>`)
  }

  // ---------- 実績 ----------
  async function results() {
    setNav('results')
    const j = await doc('results/30')
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
    setNav('venues')
    view(`<h1>場情報</h1><div class="races" style="grid-template-columns:repeat(auto-fill,minmax(88px,1fr))">${
      VENUES.slice(1).map((v, i) => `<a class="rc" href="#/venue/${i + 1}"><b>${v}</b><small>${String(i + 1).padStart(2, '0')}</small></a>`).join('')}</div>`)
  }
  async function venue(jcd) {
    setNav('venues')
    const j = await doc(`venue/${jcd}`)
    const V = j?.venue
    if (!V) return view('<p class="empty">この場のデータはまだありません。</p>')
    view(`<h1>${esc(V.venue)} <span class="sub">直近1年（${esc(V.period.from)}〜）</span></h1>
      <div class="stats"><div class="stat"><span>1コース1着率</span><b>${pct(V.by_course[0]?.win_rate)}</b></div>
        <div class="stat"><span>3連単の平均配当</span><b>${yen(V.trifecta.avg_payout)}</b></div>
        <div class="stat"><span>万舟率</span><b>${pct(V.trifecta.over_10000_rate)}</b></div></div>
      <h2>コース別</h2><div class="scroll"><table><thead><tr><th class="l">コース</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>出走</th></tr></thead><tbody>${
        V.by_course.map((c) => `<tr><td class="l">${waku(c.course)}</td><td>${bar(c.win_rate, V.by_course[0].win_rate)}</td><td>${pct(c.top2_rate)}</td><td>${pct(c.top3_rate)}</td><td>${c.starts.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>
      <h2>決まり手</h2><div class="panel km">${V.kimarite.map((k) => `<span>${esc(k.kimarite)}</span><i style="width:${Math.max(2, k.share)}%"></i><span class="num">${pct(k.share)}</span>`).join('')}</div>
      <h2>1コースの強さ（レース番号別）</h2><div class="panel km">${V.course1_win_rate_by_race_no.map((k) => `<span>${k.race_no}R</span><i style="width:${Math.max(2, k.win_rate)}%"></i><span class="num">${pct(k.win_rate)}</span>`).join('')}</div>`)
  }

  // ---------- 選手 ----------
  const statRow = (label, s) => `<tr><td class="l">${label}</td><td>${s.starts}</td><td>${pct(s.win_rate)}</td><td>${pct(s.top2_rate)}</td><td>${pct(s.top3_rate)}</td><td>${dash(s.avg_st)}</td><td>${dash(s.avg_st_rank)}</td></tr>`
  const statHead = (first) => `<thead><tr><th class="l">${first}</th><th>出走</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>平均ST</th><th>ST順位</th></tr></thead>`
  async function racer(id) {
    setNav('racers')
    const j = await doc(`racer/${id}`)
    const P = j?.racer
    if (!P) return view('<p class="empty">この選手のデータはまだありません（直近180日に出走した選手を掲載しています）。</p>')
    const S = P.summary_1y, A = S.accidents, T2 = P.titles_since_2022
    const c1 = P.by_course.find((c) => c.course === 1)
    view(`<h1>${esc(P.name)} ${cls(P.class)}</h1><div class="sub">${esc(P.kana ?? '')}　登番${P.racer_id}　${esc(P.branch ?? '')}支部　${P.age ?? ''}歳　${P.height ?? ''}cm/${P.weight ?? ''}kg　${esc(P.blood ?? '')}型</div>
      ${P.today?.length ? `<div class="panel freepick" style="margin-top:12px"><b>本日の出走</b>　${P.today.map((t) => `<a href="#/race/${t.race_id}">${esc(t.venue)}${t.race_no}R（${t.lane}号艇）</a>`).join('　')}</div>` : ''}
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
      <h2>場別（直近1年）</h2><div class="scroll"><table>${statHead('場')}<tbody>${P.by_venue.map((v) => statRow(`<a href="#/venue/${v.jcd}">${esc(v.venue)}</a>`, v)).join('')}</tbody></table></div>
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
    if (!j) return view('<p class="empty">選手一覧はまだありません。</p>')
    const all = j.racers
    const draw = (s) => {
      const k = s.trim()
      const hit = k ? all.filter((r) => (r.name ?? '').includes(k) || (r.kana ?? '').includes(k) || String(r.racer_id).startsWith(k) || (r.branch ?? '').includes(k)) : all
      document.getElementById('rl').innerHTML = hit.slice(0, 300).map((r) => `<tr><td class="l"><a class="name" href="#/racer/${r.racer_id}">${esc(r.name)}</a> ${cls(r.class)}<span class="meta">${esc(r.kana ?? '')}</span></td>
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

  // ---------- 振り分け ----------
  async function route() {
    const p = location.hash.replace(/^#\/?/, '').split('/')
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
      return await home()
    } catch (e) { fail(e) }
  }
  window.addEventListener('hashchange', route)
  route()
})()
