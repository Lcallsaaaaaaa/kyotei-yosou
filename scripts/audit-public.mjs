// 公開データの点検。送る前・デプロイ前にこれを通す。
//
//   node scripts/audit-public.mjs            site/_local/ を点検
//   node scripts/audit-public.mjs --remote   Supabase に入っているものを点検（data/supabase.json が要る）
//
// 見るのは「言葉」ではなく「決まりを守れているか」。
//   ① 公開ぶんに買い目（plan2 / haishin / trio / trifecta / prediction）が無いこと
//   ② 展開予想が出ているのは、無料枠（単勝1点）のあるレースだけであること
//   ③ 有料ぶん（paid/）は全部が暗号文の形をしていること
//   ④ 有料ぶんが、その月の合言葉で開けること
//
// 言葉で探すだけだと、無料で出している展開予想まで「漏れ」に見えてしまう（2026-09-23に実際そうなった）。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSealed, open as unseal, phraseOf } from './seal.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REMOTE = process.argv.includes('--remote')
const LOCAL_DIR = join(ROOT, 'site', '_local')

async function load() {
  if (!REMOTE) {
    if (!existsSync(LOCAL_DIR)) { console.error('site/_local がありません。先に node scripts/sync-public.mjs --local'); process.exit(1) }
    return readdirSync(LOCAL_DIR).map((f) => [f.replace(/\.json$/, '').replaceAll('__', '/'),
      JSON.parse(readFileSync(join(LOCAL_DIR, f), 'utf8'))])
  }
  const cfg = JSON.parse(readFileSync(join(ROOT, 'data', 'supabase.json'), 'utf8'))
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${cfg.url}/rest/v1/docs?select=key,body`, {
      headers: { apikey: cfg.service_key, Authorization: `Bearer ${cfg.service_key}`, Range: `${from}-${from + 999}` } })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    const a = await res.json()
    out.push(...a.map((r) => [r.key, r.body]))
    if (a.length < 1000) break
  }
  return out
}

const docs = await load()
const pub = docs.filter(([k]) => !k.startsWith('paid/'))
const paid = docs.filter(([k]) => k.startsWith('paid/'))
let ng = 0
const fail = (...a) => { ng++; if (ng <= 20) console.log('  ✗', ...a) }

// ① 買い目が公開ぶんに無いこと（results の的中率の集計は買い目ではないので除く）
for (const [k, b] of pub) {
  if (k.startsWith('results/')) continue
  const s = JSON.stringify(b)
  for (const bad of ['"picks":', '"prediction":', '"trio":[', '"trifecta":[', '"exacta":['])
    if (s.includes(bad)) fail(k, 'に買い目', bad)
}

// ② 展開予想は無料枠のレースだけ
const freeOf = new Map()
for (const [k, b] of pub) if (k.startsWith('race/')) freeOf.set(b?.race?.race_id ?? k.slice(5), !!b?.race?.free_pick)
let openTenkai = 0
for (const [k, b] of pub) {
  if (k.startsWith('race/')) {
    if (b?.race?.tenkai) { openTenkai++; if (!b.race.free_pick) fail(k, 'は無料枠でないのに展開予想が出ている') }
  } else if (k.startsWith('tenkai/')) {
    for (const r of b?.races ?? []) if (r.tenkai && !freeOf.get(r.race_id)) fail(k, r.race_id, 'の展開予想が一覧に出ている')
  }
}

// ③④ 有料ぶんは暗号文で、その月の合言葉で開けること
const periods = new Set()
for (const [k, b] of paid) {
  if (!isSealed(b)) { fail(k, 'が暗号文の形をしていない'); continue }
  periods.add(b.period)
  try { const o = unseal(b, phraseOf(b.period)); if (!o || typeof o !== 'object') fail(k, 'を開いたら中身が空') }
  catch { fail(k, 'をその月の合言葉で開けない') }
}

console.log(`公開ぶん ${pub.length}件／有料ぶん ${paid.length}件（${[...periods].join('・') || '―'}）`)
console.log(`無料で出している展開予想 ${openTenkai}件（無料枠のレースぶん）`)
if (ng > 20) console.log(`  … ほか ${ng - 20}件`)
console.log(ng ? `★ 決まりに反するもの ${ng}件。直すまで公開しないこと` : '✓ 決まりに反するものはありません')
process.exit(ng ? 1 : 0)
