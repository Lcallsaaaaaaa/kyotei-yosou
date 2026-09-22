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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { apiRoute } from './api.mjs'

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
  const { prediction, picks, ...race } = j.race
  const free = picks?.free_win ? { lane: picks.free_win.lane, racer: picks.free_win.racer,
    probability: picks.free_win.probability, hit: picks.free_win.hit, payout: picks.free_win.payout } : null
  return { api_version: j.api_version, prediction_generated_at: j.prediction_generated_at,
    race: { ...race, free_pick: free } }
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
  const todo = []
  for (const [key, body] of docs) {
    if (!body) continue
    assertNoPaid(key, body)
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
async function removeOld(keepDates) {
  // 古い日のレースは消して、無料枠の500MBを守る（手元の本体には全部残っている）
  if (LOCAL) return
  const keep = new Set(keepDates.map((d) => d.replace(/-/g, '')))
  for (const k of Object.keys(state)) {
    const m = k.match(/^race\/(\d{8})-/) ?? k.match(/^(?:races|tenkai)\/(\d{4}-\d{2}-\d{2})$/)
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
  const docs = [[`races/${date}`, races], [`tenkai/${date}`, call(`/api/v1/tenkai?date=${date}`)]]
  for (const r of races.races) {
    const d = publicRace(call(`/api/v1/race?id=${r.race_id}`))
    r.free_pick = d?.race?.free_pick ? d.race.free_pick.lane : null   // 一覧に「無料」の印を出すため
    docs.push([`race/${r.race_id}`, d])
  }
  await put(docs)
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
async function syncMeta(dates) {
  await put([['meta', { site: '凪の予想配信', dates, updated_at: jst().toISOString().replace('T', ' ').slice(0, 16) }]])
}

// ---------- 実行 ----------
if (!LIVE) {
  const d0 = today(), dates = [addDays(d0, -1), d0, addDays(d0, 1)]
  const t0 = Date.now()
  for (const d of dates) log(`${d}: ${await syncDay(d, d === d0)}レース`)
  await syncCommon()
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
      await syncMeta([addDays(d0, -1), d0, addDays(d0, 1)])
      await removeOld([addDays(d0, -1), d0, addDays(d0, 1)])
      lastFull = jst().getUTCHours() === 7 ? d0 + '-7' : d0
    }
    if (sent > before) log(`送信 ${sent - before}件`)
  } catch (e) { log('失敗:', e.message) }
  await sleep(3 * 60_000)
}
