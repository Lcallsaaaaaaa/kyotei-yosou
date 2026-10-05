// ネームサーバーの切り替えがレジストリに反映されるのを待つ。
//
//   node scripts/wait-ns.mjs boatrace-nagi.top cloudflare
//
// ★レジストリ（.top の権威サーバー）に直接きく。
//   8.8.8.8 などは古い答えをためているので、切り替え直後は当てにならない。
import { Resolver } from 'node:dns/promises'

const name = process.argv[2]
const want = (process.argv[3] ?? 'cloudflare').toLowerCase()
const MAX_MIN = Number(process.argv[4] ?? 180)
if (!name) { console.error('ドメイン名を渡してください'); process.exit(1) }

const TLD = name.split('.').pop()
const reg = new Resolver({ timeout: 6000, tries: 1 })

async function registryServers() {
  const r = new Resolver({ timeout: 6000, tries: 1 })
  r.setServers(['8.8.8.8'])
  try { return await r.resolveNs(TLD) } catch { return [] }
}
async function askRegistry(server) {
  const ips = await (async () => {
    const r = new Resolver({ timeout: 6000, tries: 1 })
    r.setServers(['8.8.8.8'])
    try { return await r.resolve4(server) } catch { return [] }
  })()
  if (!ips.length) return null
  reg.setServers([ips[0]])
  try { return await reg.resolveNs(name) } catch { return null }
}

const servers = await registryServers()
if (!servers.length) { console.error(`.${TLD} の権威サーバーが引けません`); process.exit(1) }

const t0 = Date.now()
for (let i = 0; ; i++) {
  let ns = null
  for (const s of servers.slice(0, 3)) { ns = await askRegistry(s); if (ns?.length) break }
  const min = ((Date.now() - t0) / 60000).toFixed(0)
  if (ns?.length && ns.some((x) => x.toLowerCase().includes(want))) {
    console.log(`✓ ${name} のネームサーバーが切り替わりました（${min}分後）`)
    console.log('  ' + ns.join(', '))
    process.exitCode = 0
    break
  }
  if ((Date.now() - t0) / 60000 >= MAX_MIN) {
    console.log(`✗ ${MAX_MIN}分待っても切り替わりません。いまは ${ns?.join(', ') ?? '引けず'}`)
    process.exitCode = 1
    break
  }
  if (i % 4 === 0) console.log(`  …まだ ${ns?.join(', ') ?? '引けず'}（${min}分）`)
  await new Promise((r) => setTimeout(r, 60_000))
}
