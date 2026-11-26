// /data/… の窓口（Pages Functions）の判定だけを、ブラウザ抜きで確かめる。
//
//   node scripts/test-data-gate.mjs
//
// ★なぜこれが要るか（2026-10-05）
//   無料予想の鍵（FREE_KEY）を足した。ここを間違えると
//   「誰でも見られる」か「友だちでも見られない」のどちらかになる。
//   wrangler pages dev は _redirects のSPA差し戻しが先に効いてしまい、
//   窓口まで届かないので、窓口の関数を**直接呼んで**確かめる。
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'site', 'functions', 'data', '[[path]].js')).href)

const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const KEY = 'test-key-ABC123'
// 月替わりの鍵（scripts/free-key.mjs と同じ計算）。窓口が同じ値を出せるかを確かめる。
const { createHmac } = await import('node:crypto')
const p2 = (n) => String(n).padStart(2, '0')
const jd = new Date(Date.now() + 9 * 3600e3)
const THIS = `${jd.getUTCFullYear()}-${p2(jd.getUTCMonth() + 1)}`
const PREV = jd.getUTCMonth() === 0 ? `${jd.getUTCFullYear() - 1}-12` : `${jd.getUTCFullYear()}-${p2(jd.getUTCMonth())}`
const NEXT = jd.getUTCMonth() === 11 ? `${jd.getUTCFullYear() + 1}-01` : `${jd.getUTCFullYear()}-${p2(jd.getUTCMonth() + 2)}`
const monthKey = (period) => createHmac('sha256', Buffer.from(SECRET, 'hex'))
  .update('freekey:' + period).digest('base64url').slice(0, 22)
const DAY = jd.getUTCDate()
// R2 の代わり。member/free/… と races/… だけ「ある」ことにする。
const DATA = {
  async get(path) {
    if (['member/free/2026-10-05.json', 'member/alerts/2026-10-05.json', 'races/2026-10-05.json'].includes(path))
      return { body: JSON.stringify({ ok: path }), httpEtag: '"e1"' }
    return null
  },
}
// Supabase への問い合わせは外へ出さない。Bearer good- で始まるときだけ本人とする。
const origFetch = globalThis.fetch
globalThis.fetch = async (url, opt) => {
  const a = opt?.headers?.Authorization ?? ''
  return new Response(a.startsWith('Bearer good-') ? JSON.stringify({ id: 'u1' }) : 'no',
    { status: a.startsWith('Bearer good-') ? 200 : 401 })
}

const call = async (path, { key, qkey, bearer, env: extra } = {}) => {
  const u = new URL('https://example.test/data/' + path)
  if (qkey) u.searchParams.set('k', qkey)
  const h = new Headers()
  if (key != null) h.set('x-free-key', key)
  if (bearer) h.set('authorization', 'Bearer ' + bearer)
  const env = { DATA, FREE_KEY: KEY, FREE_SECRET: SECRET, SUPABASE_URL: 'https://sb.test', SUPABASE_KEY: 'anon', ...extra }
  const params = { path: path.split('?')[0].split('/') }
  return mod.onRequestGet({ params, env, request: new Request(u, { headers: h }) })
}

let ok = 0, ng = 0
const T = async (name, want, run) => {
  let got
  try { got = (await run()).status } catch (e) { got = 'throw: ' + e.message }
  const pass = got === want
  pass ? ok++ : ng++
  console.log(`  ${pass ? '✓' : '✗'} ${name}　期待${want} / 実際${got}`)
}
const F = 'member/free/2026-10-05.json'

console.log('■ 鍵の判定')
await T('鍵なし → 401', 401, () => call(F))
await T('正しい鍵（ヘッダ） → 200', 200, () => call(F, { key: KEY }))
await T('正しい鍵（?k=） → 200', 200, () => call(F, { qkey: KEY }))
await T('違う鍵 → 401', 401, () => call(F, { key: 'wrong' }))
await T('空の鍵 → 401', 401, () => call(F, { key: '' }))
await T('前方一致だけ → 401', 401, () => call(F, { key: KEY.slice(0, 5) }))
await T('末尾に1文字 → 401', 401, () => call(F, { key: KEY + 'x' }))
await T('鍵を2回つなげる → 401', 401, () => call(F, { key: KEY + KEY }))
await T('大小を変える → 401', 401, () => call(F, { key: KEY.toLowerCase() }))
await T('ヘッダの前後の空白は落ちるので 200', 200, () => call(F, { key: ' ' + KEY + ' ' }))
await T('?k= の前後に空白 → 401', 401, () => call(F, { qkey: ' ' + KEY + ' ' }))
await T('鍵の1文字を変える → 401', 401, () => call(F, { key: KEY.slice(0, -1) + 'Z' }))
await T('ヘッダと?k=の両方（片方だけ正）→ 200', 200, () => call(F, { key: 'wrong', qkey: KEY }))

console.log('■ 月替わりの鍵（2026-10-05〜）')
await T('今月の鍵 → 200', 200, () => call(F, { key: monthKey(THIS) }))
await T('今月の鍵（?k=） → 200', 200, () => call(F, { qkey: monthKey(THIS) }))
await T('来月の鍵はまだ通らない → 401', 401, () => call(F, { key: monthKey(NEXT) }))
await T(`先月の鍵は${DAY <= 7 ? '7日まで通る' : '通らない'} → ${DAY <= 7 ? 200 : 401}`,
  DAY <= 7 ? 200 : 401, () => call(F, { key: monthKey(PREV) }))
await T('よその秘密で作った鍵 → 401', 401,
  () => call(F, { key: monthKey(THIS), env: { FREE_SECRET: 'ff'.repeat(32) } }))
await T('FREE_SECRET 未設定でも旧FREE_KEYは通る → 200', 200,
  () => call(F, { key: KEY, env: { FREE_SECRET: undefined } }))
await T('FREE_SECRET だけ（旧鍵なし）で今月の鍵 → 200', 200,
  () => call(F, { key: monthKey(THIS), env: { FREE_KEY: undefined } }))
await T('両方なし → 401', 401,
  () => call(F, { key: monthKey(THIS), env: { FREE_KEY: undefined, FREE_SECRET: undefined } }))

console.log('■ 以前のメール登録（Supabase）')
await T('正しい入場券 → 200', 200, () => call(F, { bearer: 'good-1' }))
await T('古い入場券 → 401', 401, () => call(F, { bearer: 'bad-1' }))
await T('Bearer でない → 401', 401, () => call(F, { bearer: '' }))

console.log('■ 置き場ごとの扱い')
await T('公開ぶんは鍵なしで 200', 200, () => call('races/2026-10-05.json'))
await T('公開ぶんの無いもの → 404', 404, () => call('races/1999-01-01.json'))
await T('有料は鍵では開かない（無いので404）', 404, () => call('paid/race/x.json', { key: KEY }))
await T('鍵ありでも無いものは 404', 404, () => call('member/free/1999-01-01.json', { key: KEY }))

// アラートも member/ 置き場（2026-10-06・「リッチメニューLINE登録が必須」）
const AL = 'member/alerts/2026-10-05.json'
await T('アラートは鍵なしで 401', 401, () => call(AL))
await T('アラートは鍵ありで 200', 200, () => call(AL, { key: KEY }))
await T('アラートは ?k= でも 200', 200, () => call(AL, { qkey: KEY }))
await T('アラートは違う鍵だと 401', 401, () => call(AL, { key: 'x'.repeat(22) }))
await T('アラートはメール登録でも 200', 200, () => call(AL, { bearer: 'good-1' }))

console.log('■ 設定が欠けているとき')
await T('FREE_KEY 未設定 → 鍵は効かない 401', 401, () => call(F, { key: KEY, env: { FREE_KEY: undefined } }))
await T('FREE_KEY が空文字 → 401', 401, () => call(F, { key: '', env: { FREE_KEY: '' } }))
await T('R2 の割り当てが無い → 500', 500, () => call(F, { key: KEY, env: { DATA: undefined } }))
await T('Supabaseの設定なし＋鍵ありは 200', 200,
  () => call(F, { key: KEY, env: { SUPABASE_URL: undefined, SUPABASE_KEY: undefined } }))

console.log('■ 変なパス')
await T('上へ登る .. → 400', 400, () => call('member/../paid/x.json', { key: KEY }))
await T('先頭スラッシュ → 400', 400, () => call('/member/x.json', { key: KEY }))
await T('空のパス → 400', 400, () => call(''))

console.log('■ 返す札（ヘッダ）')
{
  const r = await call(F, { key: KEY })
  const cc = r.headers.get('cache-control') ?? ''
  const pass = cc.includes('private')
  pass ? ok++ : ng++
  console.log(`  ${pass ? '✓' : '✗'} member は private でためない　実際「${cc}」`)
  const r2 = await call('races/2026-10-05.json')
  const cc2 = r2.headers.get('cache-control') ?? ''
  const p2 = cc2.includes('public')
  p2 ? ok++ : ng++
  console.log(`  ${p2 ? '✓' : '✗'} 公開ぶんは public でためる　実際「${cc2}」`)
  const r3 = await call(F)
  const j = await r3.json()
  const p3 = j.error === 'line_required'
  p3 ? ok++ : ng++
  console.log(`  ${p3 ? '✓' : '✗'} 断るときの合図は line_required　実際「${j.error}」`)
  const r4 = await call(F, { key: KEY })
  const et = r4.headers.get('etag')
  const p4 = et === '"e1"'
  p4 ? ok++ : ng++
  console.log(`  ${p4 ? '✓' : '✗'} etag を返す　実際「${et}」`)
}

globalThis.fetch = origFetch
console.log('')
console.log(ng ? `★ ${ng}件おかしい（通ったのは${ok}件）` : `✓ ${ok}件すべて期待どおり`)
process.exitCode = ng ? 1 : 0
