// 静的HTML（検索エンジンとSNSが見るほう）を作り直して公開する。
//
//   node scripts/publish-static.mjs            レース中なら自分で止まる
//   node scripts/publish-static.mjs --force    承知のうえで走らせる
//   node scripts/publish-static.mjs --no-deploy  書き出すだけ（確認用）
//
// ★なぜ要るか（2026-10-11に気づいた）
//   記事（news.mjs・venue-article.mjs）は毎日できて、R2 へも自動で出ている。
//   ところが **prerender とデプロイは手で走らせたときしか動いていなかった**。
//   画面はR2から読むので人には新しく見えるが、**JavaScriptを動かさないクローラーが
//   見るHTMLは、最後に手で公開した時点のまま**。SEOのために書いた記事が
//   検索エンジンには届かない、という穴になっていた。
//
// ★順番（この通りでないと古いものを公開する）
//   1. sync-public --local … site/_local を作り直す（prerender の材料）
//      ⚠ --local は鍵を取らず state にも触らないので、常駐（--live）と競合しない
//   2. prerender          … 2,000ページぶんのHTMLを書き出す
//   3. deploy             … Cloudflare Pages へ送る
//
// ★レース中は走らせない
//   この機械は物理メモリ 7.8GB しかない。重い処理を重ねると常駐がメモリから
//   追い出され、サイトの更新が止まる（2026-10-07に実際に30分止まった）。
//   締切前オッズはその瞬間にしか取れないので、止めたぶんは永久に欠ける。
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { heavyGuard } from './heavy-guard.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const jst = () => new Date(Date.now() + 9 * 3600e3)
const log = (...a) => console.log(jst().toISOString().slice(11, 16), ...a)

heavyGuard('静的HTMLの書き出しと公開')

const steps = [
  ['データの書き出し', ['scripts/sync-public.mjs', '--local']],
  ['HTMLの書き出し', ['scripts/prerender.mjs']],
]
if (!argv.includes('--no-deploy')) steps.push(['公開', ['scripts/deploy.mjs']])

const t0 = Date.now()
for (const [name, args] of steps) {
  log(`--- ${name} ---`)
  try {
    // ⚠ 1工程30分では足りない（2026-10-30に判明）。
    //   10/29は 23:41 開始の「データの書き出し」が 00:11 に ETIMEDOUT。ちょうど30分。
    //   空きメモリ0.7GBだと2,258枚ぶんの書き出しに30分以上かかる。
    //   メモリが増えるまでは時間で殴るしかないので80分まで許す。
    //   タスク側の上限も PT1H → PT3H に広げてある（2工程＋公開で足りるように）。
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout: 80 * 60_000 })
  } catch (e) {
    log(`✗ ${name} で失敗しました: ${e.message}`)
    // ★途中で落ちたら先へ進まない。
    //   古い site/_local のまま prerender すると、**検索エンジンに古い出走表を出し続ける**。
    process.exit(1)
  }
}
log(`完了（${Math.round((Date.now() - t0) / 1000)}秒）`)
