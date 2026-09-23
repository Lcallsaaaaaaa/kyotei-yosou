// 有料会員の「合言葉」を出す。
//
//   node scripts/paid-key.mjs            今月と来月の合言葉
//   node scripts/paid-key.mjs --note     note のメンバーシップに貼る文面（今月ぶん）
//   node scripts/paid-key.mjs --note --next   来月ぶん（月末に前もって出しておく用）
//   node scripts/paid-key.mjs --month 2026-11
//   node scripts/paid-key.mjs --check    暗号を閉じて開け直せるか確かめる
//
// 合言葉は master（data/paid-secret.json）と年月から決まるので、控えを無くしても何度でも出せる。
// ただし master を失うと過去ぶんも出せなくなる。
import { phraseOf, periodOf, seal, open, master } from './seal.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

const jst = () => new Date(Date.now() + 9 * 3600e3)
const thisMonth = periodOf(jst().toISOString().slice(0, 10))
const nextMonth = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}` }
const ja = (p) => { const [y, m] = p.split('-').map(Number); return `${y}年${m}月` }

if (has('--check')) {
  const p = thisMonth
  const box = seal({ hello: '凪', n: 1 }, p, 'paid/test')
  const back = open(box, phraseOf(p))
  const again = seal({ hello: '凪', n: 1 }, p, 'paid/test')
  console.log('閉じて開ける：', back.hello === '凪' ? 'OK' : 'NG')
  console.log('同じ中身なら同じ暗号文（送信をはぶける）：', box.ct === again.ct ? 'OK' : 'NG')
  const diff = seal({ hello: '凪', n: 2 }, p, 'paid/test')
  console.log('中身が変われば IV も変わる：', diff.iv !== box.iv ? 'OK' : 'NG')
  let ng = false
  try { open(box, 'nagi-9999-XXXX-XXXX') } catch { ng = true }
  console.log('まちがった合言葉では開かない：', ng ? 'OK' : 'NG')
  process.exit(0)
}

const mk = master()
const period = val('--month') || (has('--next') ? nextMonth(thisMonth) : thisMonth)

if (has('--note')) {
  const ph = phraseOf(period, mk)
  console.log(`------------ ここから note のメンバーシップ限定の投稿に貼る ------------
【${ja(period)}の合言葉】

${ph}

ボートレース研究所のサイトで、右上の「会員」から上の合言葉を入れてください。
入れるのは月に1回だけです。${ja(period)}のあいだは、展開予想とAI予想（3連複2点プラン）がすべて開きます。

・サイト： https://（ここにサイトのURL）
・合言葉は毎月変わります。翌月ぶんは月末にこの投稿でお知らせします。
・合言葉を他の方に教えたり、SNSに貼ったりしないでください。

舟券の購入は20歳からです。予想は的中を優先したもので、利益を約束するものではありません。
------------ ここまで ------------`)
} else {
  console.log(`${ja(thisMonth)}（今月）：  ${phraseOf(thisMonth, mk)}`)
  console.log(`${ja(nextMonth(thisMonth))}（来月）：  ${phraseOf(nextMonth(thisMonth), mk)}`)
  console.log('')
  console.log('note に貼る文面は  node scripts/paid-key.mjs --note')
}
