// LINE登録者に配る「無料予想の合言葉」を出す。月替わり。
//
//   node scripts/free-key.mjs              今月と来月の鍵・リッチメニューのURL
//   node scripts/free-key.mjs --next       来月ぶんだけ（月末に前もって貼り替える用）
//   node scripts/free-key.mjs --month 2026-11
//   node scripts/free-key.mjs --push       10時の配信文（今月ぶん）
//   node scripts/free-key.mjs --env        Cloudflare に入れる秘密を出す（初回だけ）
//
// ★有料会員の合言葉（paid-secret.json）とは**別の秘密**から作る。
//   片方が漏れても、もう片方は無傷のまま。
//
// ★なぜ月替わりにするのか（2026-10-05 本人判断）
//   リッチメニューのURLは友だちにしか見えないが、転送されれば渡る。
//   固定だと一度漏れたら永久に開く。月替わりなら、漏れても最長1か月で閉じる。
//
// ★代わりに、毎月1回リッチメニューのURLを貼り替える手間が増える。
//   貼り替え忘れても困らないよう、**月初の7日間は先月の鍵も通す**。
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET = join(ROOT, 'data', 'free-secret.json')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

/** 秘密。無ければ作る。これを失うと過去の鍵が出せなくなる。 */
export function master() {
  if (!existsSync(SECRET)) {
    mkdirSync(dirname(SECRET), { recursive: true })
    writeFileSync(SECRET, JSON.stringify({ master: randomBytes(32).toString('hex'),
      created: new Date().toISOString(),
      note: 'LINE無料予想の鍵のもと。これを失うと過去の鍵が出せなくなる。控えを取ること。' }, null, 2))
    console.error(`※ ${SECRET} を作りました。控えを取ってください。`)
  }
  const m = JSON.parse(readFileSync(SECRET, 'utf8')).master
  if (!m || m.length < 32) throw new Error('data/free-secret.json の master が不正')
  return Buffer.from(m, 'hex')
}

/** その月の鍵。Pages Functions 側（[[path]].js）も同じ計算をする。 */
export const freeKeyOf = (period, mk = master()) =>
  createHmac('sha256', mk).update('freekey:' + period).digest('base64url').slice(0, 22)

// ⚠ 日付は toISOString(UTC) で比べない。深夜0〜9時に前月と判定されることがある。
const p2 = (n) => String(n).padStart(2, '0')
const jstNow = () => new Date(Date.now() + 9 * 3600e3)
const periodOfJst = (d = jstNow()) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`
const nextOf = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${p2(m + 1)}` }
const ja = (p) => { const [y, m] = p.split('-').map(Number); return `${y}年${m}月` }

const SITE = (() => {
  try {
    const win = {}
    new Function('window', readFileSync(join(ROOT, 'site', 'config.js'), 'utf8'))(win)
    return (win.NAGI?.siteUrl || '').replace(/\/+$/, '') || 'https://kyotei-site.pages.dev'
  } catch { return 'https://kyotei-site.pages.dev' }
})()

if (has('--env')) {
  console.log('Cloudflare Pages → kyotei-site → 設定 → 変数とシークレット に、')
  console.log('名前 FREE_SECRET で「シークレット」として入れてください。')
  console.log('')
  console.log(JSON.parse(readFileSync(SECRET, 'utf8')).master)
  process.exit(0)
}

const period = val('--month') || (has('--next') ? nextOf(periodOfJst()) : periodOfJst())
const key = freeKeyOf(period)
const url = `${SITE}/?k=${key}`

if (has('--push')) {
  console.log(`おはようございます。
きょうの無料予想（単勝1点）を公開しました。

▼ きょうの予想
${url}

1着確率80%以上の本命だけを選んでいます。
外れた日も消さずに実績に残しています。

※ 舟券の購入は20歳からです。回収率は100%未満です。`)
  process.exit(0)
}

console.log(`【${ja(period)}の無料予想リンク】`)
console.log('')
console.log('  ' + url)
console.log('')
console.log('リッチメニューの「今日の無料予想」に、これを貼ってください。')
console.log('ほかのボタン（実績・会員・開催予定など）は鍵が要らないので、そのままで大丈夫です。')
console.log('')
console.log(`来月（${ja(nextOf(period))}）ぶん：`)
console.log('  ' + `${SITE}/?k=${freeKeyOf(nextOf(period))}`)
console.log('')
console.log('※ 月初の7日間は先月の鍵も通します。貼り替えが数日遅れても止まりません。')
console.log('※ 10時の配信文は  node scripts/free-key.mjs --push')
