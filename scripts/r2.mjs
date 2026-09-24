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
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFGF = join(ROOT, 'data', 'r2.json')

export function r2Config() {
  if (!existsSync(CFGF)) return null
  const c = JSON.parse(readFileSync(CFGF, 'utf8'))
  for (const k of ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey'])
    if (!c[k]) throw new Error(`data/r2.json に ${k} がありません`)
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

/** 1件置く。key は 'race/20260924-01-01.json' のような形。 */
export async function putObject(cfg, key, bodyStr, contentType = 'application/json; charset=utf-8') {
  const body = Buffer.from(bodyStr, 'utf8')
  const { url, headers } = signed(cfg, 'PUT', key, body, contentType)
  const res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`R2 への書き込みに失敗 ${res.status} ${(await res.text()).slice(0, 200)}`)
}

/** 1件消す。 */
export async function deleteObject(cfg, key) {
  const { url, headers } = signed(cfg, 'DELETE', key, '', null)
  const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) })
  // 204 も 404 も「もう無い」ので成功あつかい
  if (!res.ok && res.status !== 404) throw new Error(`R2 の削除に失敗 ${res.status}`)
}

/** つながるか確かめる（小さいファイルを置いて消す）。 */
export async function r2Check(cfg) {
  const key = '_check.json'
  await putObject(cfg, key, JSON.stringify({ ok: true, at: new Date().toISOString() }))
  await deleteObject(cfg, key)
  return true
}

// 単体で動かすと接続確認になる： node scripts/r2.mjs
if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`) {
  const cfg = r2Config()
  if (!cfg) { console.error('data/r2.json がありません'); process.exit(1) }
  await r2Check(cfg)
  console.log(`R2 につながりました（バケット ${cfg.bucket}）`)
}
