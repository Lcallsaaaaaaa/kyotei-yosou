// ドメインが世界のDNSに出たかを待つ。出たら知らせて終わる。
//
//   node scripts/wait-dns.mjs boatrace-nagi.top
//
// ★なぜ要るか（2026-10-05）
//   取得直後のドメインはレジストリに載るまで数十分かかる。その間、
//   Cloudflare の「サイトを追加」は**何の要求も出さずに黙って失敗する**
//   （送信前の検証で止まる）。設定ミスに見えるが、ただ待てばよい。
import { Resolver } from 'node:dns/promises'

const name = process.argv[2]
if (!name) { console.error('ドメイン名を渡してください'); process.exit(1) }
const MAX_MIN = Number(process.argv[3] ?? 110)

const servers = [['8.8.8.8', 'Google'], ['1.1.1.1', 'Cloudflare']]
const look = async (ip) => {
  const r = new Resolver({ timeout: 5000, tries: 1 })
  r.setServers([ip])
  try { return await r.resolveNs(name) } catch { return null }
}

const t0 = Date.now()
for (let i = 0; ; i++) {
  const got = []
  for (const [ip, label] of servers) {
    const ns = await look(ip)
    if (ns?.length) got.push(`${label}: ${ns.join(', ')}`)
  }
  const min = ((Date.now() - t0) / 60000).toFixed(0)
  if (got.length) {
    console.log(`✓ ${name} がDNSに出ました（${min}分後）`)
    for (const g of got) console.log('  ' + g)
    process.exitCode = 0
    break
  }
  if ((Date.now() - t0) / 60000 >= MAX_MIN) {
    console.log(`✗ ${MAX_MIN}分待っても ${name} が出ませんでした。ConoHa側を見直してください`)
    process.exitCode = 1
    break
  }
  if (i % 6 === 0) console.log(`  …まだ出ていません（${min}分）`)
  await new Promise((r) => setTimeout(r, 30_000))
}
