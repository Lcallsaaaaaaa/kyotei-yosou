// R2 に置いたデータを、サイトと同じドメインから返す窓口（Cloudflare Pages Functions）。
//
//   /data/race/20260926-01-01.json  →  R2 の race/20260926-01-01.json
//
// ★なぜ窓口を挟むのか
//   ・同じドメインから返せるので CORS の設定が要らない
//   ・エッジでキャッシュされ、R2 への読み取り回数（無料枠1,000万回/月）も減る
//   ・**member/ の中身は、メール登録した人にだけ返せる**（下の確認）
//
// ★3つの置き場の違い
//   race/ races/ news/ …   誰でも見られる（公式データ・記事）
//   member/ …              LINEの友だちだけ。合言葉（FREE_KEY）か、以前のメール登録を確かめる
//   paid/ …                月300円の会員。中身が暗号文なので誰が取っても読めない（確認しない）
//
// ★設定（Cloudflare Pages → Settings → Functions）
//   R2 bucket bindings : 変数名 DATA ／ バケット kyotei-data
//   Environment variables :
//     FREE_SECRET   … LINEの月替わりの鍵のもと（node scripts/free-key.mjs --env で出る）
//     FREE_KEY      … 旧・固定の鍵。FREE_SECRET に移ったら消してよい
//     SUPABASE_URL  … https://xxxx.supabase.co（以前のメール登録者ぶん。無くてよい）
//     SUPABASE_KEY  … publishable（公開用）の鍵（同上）
//   どれも未設定だと member/ は開けません（誰にも返しません）。
//
// ★なぜ「合言葉」で、LINEログインではないのか（2026-10-05）
//   友だち追加は LCall で**複数の公式アカウントへ散らす**。LINEログインは
//   1チャネル＝1公式アカウントに紐づくので、散らすのと噛み合わない。
//   そこで、**友だちにしか見えないリッチメニューのURL**を鍵として使う。
//   友だちが人に転送すれば渡ってしまうが、ここは無料の撒き餌なので割り切る。
//   有料（paid/）は暗号文なので、この鍵では一切開かない。

/** メール登録した本人かを Supabase に問い合わせる。合っていれば true。 */
async function signedIn(request, env) {
  const auth = request.headers.get('authorization') || ''
  if (!auth.startsWith('Bearer ') || !env.SUPABASE_URL || !env.SUPABASE_KEY) return false
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: auth },
      cf: { cacheTtl: 0 },
    })
    if (!r.ok) return false
    const u = await r.json()
    return !!u?.id
  } catch { return false }
}

/** リッチメニューの合言葉が合っているか。
 *  ⚠ 長さ比較で先に落とすと、長さだけは漏れる。timingSafeEqual が無いので、
 *     長さを揃えずに全文字を走査して差をためる（早抜けしない）。 */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** その月の鍵を作る。scripts/free-key.mjs と同じ計算にすること。 */
async function freeKeyOf(secret, period) {
  const k = await crypto.subtle.importKey('raw', hexBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('freekey:' + period))
  return b64u(sig).slice(0, 22)
}
const hexBytes = (hex) => {
  const a = new Uint8Array(hex.length / 2)
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return a
}
/** いま有効な月。月初7日間は先月も通す（リッチメニューの貼り替えが遅れても止めないため）。 */
function periodsNow() {
  // ⚠ UTCで月を出すと、JSTの深夜0〜9時に前月と判定される。+9時間してから見る。
  const d = new Date(Date.now() + 9 * 3600e3)
  const p2 = (n) => String(n).padStart(2, '0')
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1
  const cur = `${y}-${p2(m)}`
  if (d.getUTCDate() > 7) return [cur]
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1
  return [cur, `${py}-${p2(pm)}`]
}
/** 早抜けしない突き合わせ（長さの違いも差に含める）。 */
const same = (got, want) => {
  let diff = got.length ^ want.length
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i % want.length)
  return diff === 0
}

async function hasFreeKey(request, env, url) {
  // ⚠ 「ヘッダ || ?k=」にすると、古い鍵がヘッダに入っているだけで
  //    新しい ?k= を見ないまま断ってしまう。**どちらか合っていれば通す**。
  const given = [request.headers.get('x-free-key'), url.searchParams.get('k')].filter((x) => x != null)
  if (!given.length) return false
  // 月替わり（2026-10-05〜）。FREE_SECRET から毎月の鍵を作る。
  if (env.FREE_SECRET) {
    for (const period of periodsNow()) {
      const want = await freeKeyOf(env.FREE_SECRET, period)
      if (given.some((g) => same(g, want))) return true
    }
  }
  // 固定鍵（移行のあいだの保険）。FREE_SECRET に移ったら消してよい。
  if (env.FREE_KEY && given.some((g) => same(g, env.FREE_KEY))) return true
  return false
}

export async function onRequestGet({ params, env, request }) {
  const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '')
  // 上へ登るような指定は拒否する
  if (!path || path.includes('..') || path.startsWith('/')) return new Response('bad path', { status: 400 })
  if (!env.DATA) return new Response('R2 bucket binding "DATA" がありません', { status: 500 })

  const isMember = path.startsWith('member/')
  // 合言葉を先に見る（外へ問い合わせないので速い）。駄目なら以前のメール登録を見る。
  if (isMember && !(await hasFreeKey(request, env, new URL(request.url))) && !(await signedIn(request, env)))
    return new Response(JSON.stringify({ error: 'line_required' }),
      { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

  const obj = await env.DATA.get(path)
  if (!obj) return new Response('not found', { status: 404 })

  const h = new Headers()
  h.set('content-type', 'application/json; charset=utf-8')
  h.set('etag', obj.httpEtag)
  // member/ は人によって出し分けるので、途中でためない（各自のブラウザにだけ短く）
  h.set('cache-control', isMember ? 'private, max-age=30' : 'public, max-age=60, stale-while-revalidate=120')
  if (request.headers.get('if-none-match') === obj.httpEtag) return new Response(null, { status: 304, headers: h })
  return new Response(obj.body, { headers: h })
}
