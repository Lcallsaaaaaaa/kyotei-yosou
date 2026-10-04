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
//     FREE_KEY      … LINEのリッチメニューのURLに入れる合言葉（?k=… / x-free-key）
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
function hasFreeKey(request, env, url) {
  const want = env.FREE_KEY
  if (!want) return false
  // ⚠ 「ヘッダ || ?k=」にすると、古い鍵がヘッダに入っているだけで
  //    新しい ?k= を見ないまま断ってしまう。**どちらか合っていれば通す**。
  return [request.headers.get('x-free-key'), url.searchParams.get('k')].some((got) => {
    if (got == null) return false
    let diff = got.length ^ want.length
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i % want.length)
    return diff === 0
  })
}

export async function onRequestGet({ params, env, request }) {
  const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '')
  // 上へ登るような指定は拒否する
  if (!path || path.includes('..') || path.startsWith('/')) return new Response('bad path', { status: 400 })
  if (!env.DATA) return new Response('R2 bucket binding "DATA" がありません', { status: 500 })

  const isMember = path.startsWith('member/')
  // 合言葉を先に見る（外へ問い合わせないので速い）。駄目なら以前のメール登録を見る。
  if (isMember && !hasFreeKey(request, env, new URL(request.url)) && !(await signedIn(request, env)))
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
