// 公開サイト用のデータを作って、Supabase（無料プラン）へ送る。画面は Netlify に置いた site/ がこれを読む。
//
//   node scripts/sync-public.mjs --local            site/_local/ に書き出すだけ（アカウント無しで画面を確かめる用）
//   node scripts/sync-public.mjs --once             今日・前日・翌日と、選手・場・実績をまとめて送る
//   node scripts/sync-public.mjs --live             常駐。3分ごとに、直前情報や結果が変わったレースだけ送る
//
// ★決まり（2026-09-22）
//   ・**有料の買い目（prediction / picks の2点プラン・4点・B2・企画枠）は絶対に送らない。**
//     noteで売っている中身なので、公開の置き場に出した時点で無料で見えてしまう。
//     無料枠（単勝1点）だけは公開用の予想なので free_pick として載せる。
//   ・形は /api/v1 と同じ（api.mjs で作ったものから有料部分を外すだけ）。画面もアプリも同じ形を読む。
//   ・Supabase には docs 表（key・body・updated_at）1つだけ。作り方は supabase/schema.sql。
//   ・接続情報は data/supabase.json（git に載らない場所）。{ "url": "...", "service_key": "..." }
//     service_key は書き込み用の強い鍵なので、画面（site/）には絶対に入れない。画面には anon_key だけ。
//   ・無料枠を守るため、中身が変わっていないものは送らない（前回の中身の指紋と比べる）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { apiRoute } from './api.mjs'
import { seal, isSealed, periodOf, phraseOf, open as unseal } from './seal.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const LOCAL = argv.includes('--local'), LIVE = argv.includes('--live')
const OUT = join(ROOT, 'site', '_local')
const STATE = join(ROOT, 'data', 'sync-public-state.json')   // 送った中身の指紋
const jst = () => new Date(Date.now() + 9 * 3600e3)
const today = () => jst().toISOString().slice(0, 10)
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(jst().toISOString().slice(11, 16), ...a)

// ---------- 接続情報 ----------
let CFG = null
if (!LOCAL) {
  const f = join(ROOT, 'data', 'supabase.json')
  if (!existsSync(f)) { console.error('data/supabase.json がありません（{ "url": "https://xxx.supabase.co", "service_key": "..." }）。画面だけ試すなら --local'); process.exit(1) }
  CFG = JSON.parse(readFileSync(f, 'utf8'))
  if (!CFG.url || !CFG.service_key) { console.error('data/supabase.json に url と service_key が必要'); process.exit(1) }
}

// ---------- api.mjs の中身を受け取る ----------
function call(path) {
  let body = null, code = 0
  apiRoute(new URL(path, 'http://x'), { writeHead: (c) => { code = c }, end: (b) => { body = b } })
  return code === 200 ? JSON.parse(body) : null
}

// ---------- 有料部分を外す ----------
function publicRace(j) {
  if (!j?.race) return null
  const { prediction, picks, tenkai, ...race } = j.race
  const free = picks?.free_win ? { lane: picks.free_win.lane, racer: picks.free_win.racer,
    probability: picks.free_win.probability, hit: picks.free_win.hit, payout: picks.free_win.payout } : null
  // 無料枠（単勝1点）のレースだけは、展開予想も入口として無料で見せる
  return { api_version: j.api_version, prediction_generated_at: j.prediction_generated_at,
    race: { ...race, free_pick: free, tenkai: free ? tenkai : null,
      member_only: !free && !!tenkai, has_member_picks: !!(picks?.plan2 || picks?.haishin) } }
}
// 会員（月300円）に見せるぶん。これは必ず seal() で閉じてから送る。
function memberRace(j) {
  if (!j?.race) return null
  const { prediction, picks, tenkai } = j.race
  if (!tenkai && !picks?.plan2 && !picks?.haishin) return null
  const { free_win, spot, ...paidPicks } = picks ?? {}
  return { race_id: j.race.race_id, tenkai: tenkai ?? null,
    picks: Object.keys(paidPicks).length ? paidPicks : null, prediction: prediction ?? null }
}
function assertNoPaid(key, obj) {
  const s = JSON.stringify(obj)
  // 二重の安全装置：有料の項目名が1つでも混ざっていたら送らない
  //   （実績の集計 results の plan2・b2 などは的中率の数字だけで買い目ではないので対象外。買い目は必ず配列で入る）
  for (const bad of ['"prediction":', '"picks":', '"trio":[', '"trifecta":[', '"exacta":['])
    if (s.includes(bad)) throw new Error(`${key} に有料の項目 ${bad} が入っている。送らずに止める`)
}

// ---------- 送る（または書き出す） ----------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const hash = (o) => createHash('sha1').update(JSON.stringify(o)).digest('hex')
let sent = 0, skipped = 0
async function put(docs) {
  for (const [key, body] of docs) {
    if (!body) continue
    if (key.startsWith('paid/')) throw new Error(`${key} は putPaid で送ること`)
    assertNoPaid(key, body)
  }
  await putRaw(docs)
}
async function putRaw(docs) {
  const todo = []
  for (const [key, body] of docs) {
    if (!body) continue
    const h = hash(body)
    if (!LOCAL && state[key] === h) { skipped++; continue }
    todo.push({ key, body, h })
  }
  if (!todo.length) return
  if (LOCAL) {
    for (const d of todo) {
      const f = join(OUT, d.key.replace(/\//g, '__') + '.json')
      mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(d.body))
      sent++
    }
    return
  }
  // Supabase（PostgREST）へ、同じ key なら上書きでまとめて送る
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50)
    const res = await fetch(`${CFG.url}/rest/v1/docs?on_conflict=key`, {
      method: 'POST',
      headers: { apikey: CFG.service_key, Authorization: `Bearer ${CFG.service_key}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk.map((d) => ({ key: d.key, body: d.body, updated_at: new Date().toISOString() }))),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Supabase への送信に失敗 ${res.status} ${await res.text()}`)
    for (const d of chunk) state[d.key] = d.h
    sent += chunk.length
  }
  writeFileSync(STATE, JSON.stringify(state))
}
// ---------- 会員ぶん（合言葉で開く）----------
// 中身は seal() で閉じてから送る。置き場は誰でも読めるが、合言葉がなければ中身は読めない。
// 閉じ忘れ・閉じそこないを防ぐため、ここで3つ確かめてから送る。
async function putPaid(docs, date) {
  const period = periodOf(date)
  const out = []
  for (const [key, body] of docs) {
    if (!body) continue
    if (!key.startsWith('paid/')) throw new Error(`${key} は paid/ で始めること`)
    const box = seal(body, period, key)
    if (!isSealed(box)) throw new Error(`${key} を閉じられていない`)
    const s = JSON.stringify(box)
    for (const bad of ['"prediction":', '"picks":', '"tenkai":', '"trio":['])
      if (s.includes(bad)) throw new Error(`${key} に平文が残っている（${bad}）。送らずに止める`)
    if (JSON.stringify(unseal(box, phraseOf(period))) !== JSON.stringify(body)) throw new Error(`${key} を開け直せない`)
    out.push([key, box])
  }
  if (!out.length) return
  // put() は paid/ を弾くので、確かめ終えたここだけ通す
  const keys = out.map(([k]) => k)
  for (const k of keys) if (!k.startsWith('paid/')) throw new Error('ありえない')
  await putRaw(out)
}

async function removeOld(keepDates) {
  // 古い日のレースは消して、無料枠の500MBを守る（手元の本体には全部残っている）
  const keep = new Set(keepDates.map((d) => d.replace(/-/g, '')))
  if (LOCAL) {
    // 試し用も消す。残しておくと、決まりを変える前の古い書き出し（展開予想が全部公開だった頃のもの）が
    // 残って点検が通らなくなる（2026-09-23にそうなった）
    for (const f of existsSync(OUT) ? readdirSync(OUT) : []) {
      const k = f.replace(/\.json$/, '').replaceAll('__', '/')
      const m = k.match(/^(?:paid\/)?race\/(\d{8})-/) ?? k.match(/^(?:paid\/)?(?:races|tenkai|features)\/(\d{4}-\d{2}-\d{2})$/)
      if (m && !keep.has(m[1].replace(/-/g, ''))) rmSync(join(OUT, f))
    }
    return
  }
  for (const k of Object.keys(state)) {
    const m = k.match(/^(?:paid\/)?race\/(\d{8})-/) ?? k.match(/^(?:paid\/)?(?:races|tenkai|features)\/(\d{4}-\d{2}-\d{2})$/)
    if (!m) continue
    const ymd = m[1].replace(/-/g, '')
    if (keep.has(ymd)) continue
    const res = await fetch(`${CFG.url}/rest/v1/docs?key=eq.${encodeURIComponent(k)}`, { method: 'DELETE',
      headers: { apikey: CFG.service_key, Authorization: `Bearer ${CFG.service_key}` } })
    if (res.ok) delete state[k]
  }
  writeFileSync(STATE, JSON.stringify(state))
}

// ---------- 1日ぶん ----------
async function syncDay(date, withRacers) {
  const races = call(`/api/v1/races?date=${date}`)
  if (!races || races.status !== 'ok') return 0
  const docs = [], paid = [], free = new Set()
  for (const r of races.races) {
    const j = call(`/api/v1/race?id=${r.race_id}`)
    const d = publicRace(j)
    r.free_pick = d?.race?.free_pick ? d.race.free_pick.lane : null   // 一覧に「無料」の印を出すため
    if (r.free_pick) free.add(r.race_id)
    r.member_only = !!d?.race?.member_only                            // 一覧に「会員」の印を出すため
    docs.push([`race/${r.race_id}`, d])
    const m = memberRace(j)
    if (m) paid.push([`paid/race/${r.race_id}`, m])
  }
  // 展開予想の一覧。無料枠のレースだけ中身を出し、ほかは会員ぶん（合言葉で開く）へ回す
  const tk = call(`/api/v1/tenkai?date=${date}`)
  if (tk?.races?.length) {
    paid.push([`paid/tenkai/${date}`, { date, races: tk.races }])
    tk.races = tk.races.map((r) => (free.has(r.race_id) ? r : { ...r, tenkai: null, member_only: !!r.tenkai }))
  }
  docs.unshift([`races/${date}`, races], [`tenkai/${date}`, tk], [`features/${date}`, call(`/api/v1/features?date=${date}`)])
  await put(docs)
  await putPaid(paid, date)
  if (withRacers) {
    const ids = new Set()
    for (const [k, d] of docs) if (k.startsWith('race/')) for (const e of d?.race?.entries ?? []) if (e.racer_id) ids.add(e.racer_id)
    const rd = []
    for (const id of ids) rd.push([`racer/${id}`, call(`/api/v1/racer?id=${id}`)])
    await put(rd)
  }
  return races.races.length
}
async function syncCommon() {
  const docs = [['results/30', call('/api/v1/results?days=30')]]
  // 開催予定と、各開催の出場予定選手（あっせん）
  const sch = call('/api/v1/schedule')
  docs.push(['schedule', sch])
  for (const m of sch?.meetings ?? []) docs.push([`meeting/${m.jcd}/${m.start_date}`, call(`/api/v1/meeting?jcd=${m.jcd}&start=${m.start_date}`)])
  // データ分析（全国・場のコース別平均／コース別ランキング／出目分析／優勝戦）
  for (const k of ['average', 'ranking', 'demoku', 'yusho']) docs.push([`analysis/${k}`, call(`/api/v1/analysis?kind=${k}`)])
  for (let j = 1; j <= 24; j++) docs.push([`venue/${j}`, call(`/api/v1/venue?jcd=${j}`)])
  // 選手一覧と、直近180日に出走した全選手のページ（日和の「選手一覧」にあたる）。1日1回
  const list = call('/api/v1/racers')
  docs.push(['racers', list])
  await put(docs)
  const rd = []
  for (const r of list?.racers ?? []) {
    rd.push([`racer/${r.racer_id}`, call(`/api/v1/racer?id=${r.racer_id}`)])
    if (rd.length >= 100) { await put(rd.splice(0)) }
  }
  await put(rd)
}
// ---------- 記事（ニュース・場の攻略） ----------
// ニュース：content/news/*.md（scripts/news.mjs の自動生成＋人やGPTが書いたもの）→ news/index と news/<名前>
// 場の攻略：データから作る要点（全国平均と比べた事実だけ）＋ content/venues/NN.md（人が書く部分）→ guide/<場>
function venueGuide(jcd, v, avg, dem, manual, news) {
  const nat1 = avg?.national?.[0]?.win_rate, natMan = dem?.national?.over_10000_rate
  const c1 = v.by_course?.[0]?.win_rate, man = v.trifecta?.over_10000_rate
  const cmp = (a, b, hi, lo) => (a == null || b == null ? '' : a - b >= 3 ? hi : b - a >= 3 ? lo : '全国平均並み')
  const pts = []
  if (c1 != null) pts.push(`1コースの1着率は${c1.toFixed(1)}%（全国平均${nat1?.toFixed(1) ?? '―'}%）。${cmp(c1, nat1, 'インが強い水面です。', 'インが弱く、外からの決着が多い水面です。')}`)
  if (man != null) pts.push(`3連単の万舟率は${man.toFixed(1)}%（全国${natMan?.toFixed(1) ?? '―'}%）、平均配当は${v.trifecta.avg_payout?.toLocaleString() ?? '―'}円。${cmp(man, natMan, '荒れやすい場です。', '堅く決まりやすい場です。')}`)
  const ext = (list, label) => {
    if (!list || list.length < 2) return
    const s = [...list].sort((a, b) => b.win_rate - a.win_rate)
    if (s[0].win_rate - s.at(-1).win_rate >= 4) pts.push(`${label}で見ると、1コースの1着率は「${s[0].label}」が${s[0].win_rate.toFixed(1)}%でいちばん高く、「${s.at(-1).label}」は${s.at(-1).win_rate.toFixed(1)}%まで下がります。`)
  }
  ext(v.course1_by_condition?.wave, '波の高さ'); ext(v.course1_by_condition?.wind, '風の強さ'); ext(v.course1_by_condition?.time, '時間帯')
  const k2 = v.kimarite_by_course?.[1]?.kimarite?.[0], k3 = v.kimarite_by_course?.[2]?.kimarite?.[0]
  if (k2) pts.push(`2コースの勝ちは「${k2.kimarite}」が${k2.share.toFixed(1)}%${k3 ? `、3コースの勝ちは「${k3.kimarite}」が${k3.share.toFixed(1)}%` : ''}。`)
  const best = [...(v.course1_win_rate_by_race_no ?? [])].sort((a, b) => b.win_rate - a.win_rate)
  if (best.length) pts.push(`1コースがいちばん強いのは${best[0].race_no}R（${best[0].win_rate.toFixed(1)}%）、いちばん弱いのは${best.at(-1).race_no}R（${best.at(-1).win_rate.toFixed(1)}%）。`)
  if (v.local_top?.length) pts.push(`当地で1着率が高い選手：${v.local_top.slice(0, 3).map((r) => `${r.name}（${r.win_rate.toFixed(1)}%・${r.starts}走）`).join('、')}。`)
  return { jcd, venue: v.venue, period: v.period, points: pts, points_note: '直近1年（当地の選手は直近2年）の出走から当サイトが集計した事実だけです',
    manual: manual ? { title: manual.meta.title, updated: manual.meta.date ?? null, html: manual.html } : null,
    related_news: news.filter((n) => n.meta.venue === jcd).slice(0, 5).map((n) => ({ slug: n.slug, title: n.meta.title, date: n.meta.date })) }
}
async function syncArticles() {
  const { loadDir } = await import('./md.mjs')
  const news = loadDir(join(ROOT, 'content', 'news'))
    .sort((a, b) => String(b.meta.date ?? '').localeCompare(String(a.meta.date ?? '')) || b.slug.localeCompare(a.slug))
  const docs = [['news/index', { articles: news.slice(0, 200).map((n) => ({ slug: n.slug, title: n.meta.title, date: n.meta.date ?? null,
    tags: n.meta.tags, venue: n.meta.venue, summary: n.summary })) }]]
  for (const n of news.slice(0, 200)) docs.push([`news/${n.slug}`, { slug: n.slug, title: n.meta.title, date: n.meta.date ?? null, tags: n.meta.tags,
    venue: n.meta.venue, html: n.html }])
  const manual = new Map(loadDir(join(ROOT, 'content', 'venues')).map((m) => [Number(m.slug), m]))
  const avg = call('/api/v1/analysis?kind=average'), dem = call('/api/v1/analysis?kind=demoku')
  for (let j = 1; j <= 24; j++) {
    const v = call(`/api/v1/venue?jcd=${j}`)?.venue
    if (v) docs.push([`guide/${j}`, venueGuide(j, v, avg, dem, manual.get(j), news)])
  }
  await put(docs)
}

async function syncMeta(dates) {
  await put([['meta', { site: '凪の予想配信', dates, updated_at: jst().toISOString().replace('T', ' ').slice(0, 16) }]])
}

// ---------- 実行 ----------
if (!LIVE) {
  const d0 = today(), dates = [addDays(d0, -1), d0, addDays(d0, 1)]
  const t0 = Date.now()
  for (const d of dates) log(`${d}: ${await syncDay(d, d === d0)}レース`)
  await syncCommon()
  await syncArticles()
  await syncMeta(dates.filter((d) => existsSync(join(ROOT, 'data', `predict-${d}.json`)) || d <= d0))
  await removeOld(dates)
  log(`${LOCAL ? '書き出し' : '送信'} ${sent}件・変化なしで省略 ${skipped}件（${((Date.now() - t0) / 1000).toFixed(0)}秒）${LOCAL ? '　→ ' + OUT : ''}`)
  process.exit(0)
}

// 常駐：3分ごとに、その日のレースで中身が変わったもの（直前情報・結果・オッズの反映など）だけ送る。
// 選手・場・実績は1日1回（日付が変わった最初の回と、毎朝7時台）。
log('=== 公開データの送信（常駐）===')
let lastFull = ''
for (;;) {
  try {
    const d0 = today()
    const full = lastFull !== d0 || (jst().getUTCHours() === 7 && lastFull !== d0 + '-7')
    const before = sent
    await syncDay(d0, full)
    if (full) {
      await syncDay(addDays(d0, 1), false)
      await syncCommon()
      await syncArticles()
      await syncMeta([addDays(d0, -1), d0, addDays(d0, 1)])
      await removeOld([addDays(d0, -1), d0, addDays(d0, 1)])
      lastFull = jst().getUTCHours() === 7 ? d0 + '-7' : d0
    }
    if (sent > before) log(`送信 ${sent - before}件`)
  } catch (e) { log('失敗:', e.message) }
  await sleep(3 * 60_000)
}
