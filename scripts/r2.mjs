// Cloudflare R2 へファイルを置く。外部パッケージは使わない（このリポジトリは依存ゼロ）。
//
// ★なぜ R2 か（2026-09-24）
//   Supabase の無料枠は**送信5GB/月で全サービスが402で止まる**。データ44MBなので
//   月1,000〜2,500人で頭打ちになる。R2 は**送信が永久に無料**で、読み取りも月1,000万回まで無料。
//   さらに Cloudflare の各地のエッジから配信されるので、日本からも速い。
//
// ★接続情報は data/r2.json（git に載らない）
//   {
//     "accountId": "…", "bucket": "nagi-data",
//     "accessKeyId": "…", "secretAccessKey": "…"
//   }
//   R2 の APIトークンは「オブジェクトの読み書き」権限だけで足りる。
//
// ★S3互換のAPIを使う。署名（AWS SigV4）は node:crypto で自分で作る。
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFGF = join(ROOT, 'data', 'r2.json')

export function r2Config() {
  if (!existsSync(CFGF)) return null
  const c = JSON.parse(readFileSync(CFGF, 'utf8'))
  for (const k of ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'])
    if (!c[k]) throw new Error(`data/r2.json に ${k} がありません`)
  // ひな形のまま実行されたときに、分かりにくいエラーで止まらないようにする
  const todo = ['accountId', 'accessKeyId', 'secretAccessKey'].filter((k) => String(c[k]).startsWith('ここに'))
  if (todo.length) throw new Error(
    `data/r2.json がまだひな形のままです（${todo.join('・')} が未入力）。\n` +
    '  Cloudflare → R2 → Manage R2 API Tokens で作ったトークンの値を入れてください。\n' +
    '  Account ID は R2 の画面の右側に出ています。')
  return c
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const hmac = (key, s) => createHmac('sha256', key).update(s).digest()
// S3の決まり：パスの各区切りは「/」のまま、それ以外は %XX にする（* や ! も対象）
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const encPath = (p) => p.split('/').map(enc).join('/')

/** 1件ぶんの署名つきリクエストを作る。 */
function signed(cfg, method, key, body, contentType) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`
  const path = `/${enc(cfg.bucket)}/${encPath(key)}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')   // 20260924T012345Z
  const day = amzDate.slice(0, 8)
  const payload = sha256(body ?? '')

  const headers = { host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate }
  if (contentType) headers['content-type'] = contentType
  const names = Object.keys(headers).sort()
  const canonHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('')
  const signedHeaders = names.join(';')

  const canon = [method, path, '', canonHeaders, signedHeaders, payload].join('\n')
  const scope = `${day}/auto/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canon)].join('\n')
  const kSign = hmac(hmac(hmac(hmac('AWS4' + cfg.secretAccessKey, day), 'auto'), 's3'), 'aws4_request')
  const sig = createHmac('sha256', kSign).update(toSign).digest('hex')

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
  return { url: `https://${host}${path}`, headers }
}

/** 失敗したときに「何を直せばいいか」が分かる形にする。
 *  fetch は原因を 'fetch failed' の一言で返してくるので、そのままだと手が止まる。 */
function explain(e, cfg) {
  const code = String(e?.cause?.code ?? '')
  const msg = String(e?.cause?.message ?? '')
  const both = code + ' ' + msg
  const wrongId = `accountId がまちがっているようです（${cfg.accountId}）。\n` +
    '  Cloudflare の管理画面のURL「dash.cloudflare.com/◯◯◯/…」の ◯◯◯ の部分（32桁）を入れてください。\n' +
    '  R2 の画面の右側にある「Account ID」のコピーボタンでも同じ値が取れます。'
  // 存在しない accountId は、DNSは通るが**証明書が合わずハンドシェイクで切られる**（2026-09-24に実測）。
  // ここを拾わないと 'fetch failed' の一言で終わってしまい、何を直せばいいか分からない。
  if (/handshake failure|alert number 40|ERR_SSL/i.test(both)) return wrongId
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME/.test(both)) return wrongId
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED/.test(both) || e?.name === 'TimeoutError')
    return 'R2 につながりませんでした（回線かCloudflare側の一時的な問題）。少し待って試してください。'
  if (/CERT|SELF_SIGNED/i.test(both)) return `通信の証明書で弾かれました（${code}）。`
  return `${e?.message || String(e)}${code ? `（${code}）` : ''}`
}
function status(res, body, cfg, key) {
  const head = `R2 への書き込みに失敗（${res.status}）`
  if (res.status === 401 || res.status === 403)
    return `${head}：accessKeyId か secretAccessKey がまちがっているか、このトークンに ${cfg.bucket} への書き込み権限がありません。\n` +
      '  Cloudflare → R2 → Manage R2 API Tokens で、Object Read & Write と対象バケットを確かめてください。'
  if (res.status === 404)
    return `${head}：バケット ${cfg.bucket} が見つかりません。名前を確かめてください。`
  return `${head}：${key}\n  ${body.slice(0, 200)}`
}

/** 1件置く。key は 'race/20260924-01-01.json' のような形。 */
export async function putObject(cfg, key, bodyStr, contentType = 'application/json; charset=utf-8') {
  const body = Buffer.from(bodyStr, 'utf8')
  const { url, headers } = signed(cfg, 'PUT', key, body, contentType)
  let res
  try { res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(60_000) }) }
  catch (e) { throw new Error(explain(e, cfg)) }
  if (!res.ok) throw new Error(status(res, await res.text(), cfg, key))
}

/** 1件消す。 */
export async function deleteObject(cfg, key) {
  const { url, headers } = signed(cfg, 'DELETE', key, '', null)
  let res
  try { res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) }) }
  catch (e) { throw new Error(explain(e, cfg)) }
  // 204 も 404 も「もう無い」ので成功あつかい
  if (!res.ok && res.status !== 404) throw new Error(status(res, await res.text(), cfg, key))
}

/** つながるか確かめる（小さいファイルを置いて消す）。 */
export async function r2Check(cfg) {
  const key = '_check.json'
  await putObject(cfg, key, JSON.stringify({ ok: true, at: new Date().toISOString() }))
  await deleteObject(cfg, key)
  return true
}

// 単体で動かすと接続確認になる： node scripts/r2.mjs
// ⚠ パスの比較は pathToFileURL で行う。フォルダ名が日本語（競艇予想）だと
//    import.meta.url 側は %E7%AB%B6… と符号化されるので、素の文字列比較では一致しない。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cfg = r2Config()
    if (!cfg) { console.error('data/r2.json がありません'); process.exit(1) }
    await r2Check(cfg)
    console.log(`R2 につながりました（バケット ${cfg.bucket}）`)
  } catch (e) {
    console.error('✗ ' + (e.message || e))
    process.exit(1)
  }
}
