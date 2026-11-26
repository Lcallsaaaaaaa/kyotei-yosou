// 手元でサイトを本物どおりに動かす。会員のログインを実機で確かめるため。
//
//   node scripts/dev-site.mjs            http://localhost:8130
//   node scripts/dev-site.mjs --port 9000
//
// ★なぜ要るか（2026-10-09）
//   会員（合言葉）の試験はコードの上では通る。だが**実際にログインして
//   中身が出るか**は、画面を動かさないと分からない。
//   かといって本番サイトに合言葉を打ち込んで試すのは筋が悪い。
//
//   そこで手元に立てる。site/ をそのまま配り、**データの読み取り（/data/…）だけ
//   本番へ中継する**。画面のコードは本番と同じものが動くので、
//   「手元では動くが本番では動かない」というすれ違いが起きにくい。
//
// ★`wrangler pages dev` ではできない
//   `_redirects` の `/* /index.html 200` が先に効いて、/data/… が窓口まで届かない。
//   （[[boatrace-line-entry]] の落とし穴に書いてある）
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'site')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const PORT = Number(flag('port', 8130))
const UPSTREAM = flag('upstream', 'https://boatrace-nagi.top')
const LOCAL_DATA = argv.includes('--local-data')   // /data/… を本番でなく site/_local から返す

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2',
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = decodeURIComponent(url.pathname)

  // ①' まだ本番に無いデータを試すとき（--local-data）。site/_local から返す。
  //   ⚠ 窓口（Pages Functions）を通さないので **member/ の鍵は効かない**。
  //     鍵の判定そのものは scripts/test-data-gate.mjs で見ること。
  //     ここで確かめるのは「画面がどう描くか」だけ。
  if (LOCAL_DATA && path.startsWith('/data/')) {
    const key = path.slice('/data/'.length).replace(/\.json$/, '')
    try {
      const buf = await readFile(join(SITE, '_local', key.replaceAll('/', '__') + '.json'))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(buf)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found (local)')
    }
  }

  // ① データは本番へ中継する（窓口の鍵の判定も本番のものが効く）
  if (path.startsWith('/data/')) {
    try {
      const h = {}
      // 鍵のヘッダはそのまま渡す。これが無いと member/ が開かない
      for (const k of ['x-free-key', 'authorization', 'if-none-match']) {
        const v = req.headers[k]; if (v) h[k] = v
      }
      const r = await fetch(UPSTREAM + path + url.search, { headers: h, redirect: 'follow' })
      const body = Buffer.from(await r.arrayBuffer())
      res.writeHead(r.status, {
        'content-type': r.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(body)
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('中継に失敗: ' + e.message)
    }
  }

  // ② それ以外は site/ から配る。無ければ index.html（画面側が道筋を決める）
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  let file = join(SITE, safe)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch { file = join(SITE, 'index.html') }
  try {
    const buf = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',          // 手元では必ず最新を読ませる
    })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`手元のサイト  http://localhost:${PORT}`)
  console.log(`  画面は site/ から・データは ${UPSTREAM} から`)
  console.log('  止めるには Ctrl+C')
})
