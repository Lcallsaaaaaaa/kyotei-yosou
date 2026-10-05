// 新しいドメインでサイトが開くようになるまで待つ。
//
//   node scripts/wait-site.mjs https://boatrace-nagi.top/ 240
//
// ★ネームサーバーを切り替えてから、Cloudflare がゾーンを有効にし、
//   証明書が出るまでに時間がかかる。開いたら知らせる。
const url = process.argv[2]
const MAX_MIN = Number(process.argv[3] ?? 240)
if (!url) { console.error('URLを渡してください'); process.exit(1) }

const t0 = Date.now()
for (let i = 0; ; i++) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15_000)
  let status = null, why = ''
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'manual', cache: 'no-store' })
    status = r.status
  } catch (e) { why = e.cause?.code ?? e.name } finally { clearTimeout(timer) }

  const min = ((Date.now() - t0) / 60000).toFixed(0)
  if (status && status < 500) {
    console.log(`✓ ${url} が開きました（${min}分後・${status}）`)
    process.exitCode = 0
    break
  }
  if ((Date.now() - t0) / 60000 >= MAX_MIN) {
    console.log(`✗ ${MAX_MIN}分待っても開きません（${status ?? why}）`)
    process.exitCode = 1
    break
  }
  if (i % 5 === 0) console.log(`  …まだ開きません（${min}分・${status ?? why}）`)
  await new Promise((r) => setTimeout(r, 60_000))
}
