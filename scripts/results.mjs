// 判定した買い目を払戻と突き合わせて、配信用の結果を出す。
//
//   node scripts/results.mjs                前日ぶん
//   node scripts/results.mjs --date 2026-08-22
//   node scripts/results.mjs --all          累計だけ
//
// ★見送りも出す
//   買った分だけ載せると「当たった日だけ配信している」ように見える。
//   条件を満たさず見送った回数まで出して初めて、読者は運用を再現できる。
//
// ★払戻は翌日の昼に公開される
//   競走成績(Kファイル)が出るまで結果は確定しない。catchup が15:00に取り込むので、
//   前日ぶんの結果配信は15時以降に流す。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MARGIN, FUKU, minOddsFor } from './strategy.mjs'   // 閾値は strategy.mjs に一本化

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const p2 = (n) => String(n).padStart(2, '0')
const ALL = argv.includes('--all')
const DATE = flag('date', (() => {
  const d = new Date(); d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
})())

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bets'`).get()
if (!has) { console.log('まだ判定記録（bets）がありません。auto-bet.mjs を動かしてください。'); process.exit(0) }

// 買い目と払戻・着順を結合する
const rows = (where, ...p) => db.prepare(`
  SELECT b.*, py.amount, e.rank_num
  FROM bets b
  -- ★払戻は券種ごとに引く。高的中モード(fuku90)は買う舟券としては複勝なので読み替える。
  LEFT JOIN payouts py ON py.race_id=b.race_id AND py.bet_type=(CASE b.bet_type WHEN 'fuku90' THEN 'fukusho' ELSE b.bet_type END) AND py.combo=CAST(b.lane AS TEXT)
  LEFT JOIN entries e ON e.race_id=b.race_id AND e.lane=b.lane
  ${where} ORDER BY b.bet_type, b.deadline`).all(...p)

function report(label, list) {
  const buys = list.filter((r) => r.decision === 'buy')
  // ★複勝は「2着以内」なので rank_num===1 では判定できない。
  //   払戻データがあるか（＝その艇に複勝の払戻が出たか）で見る。
  const won = (r) => r.bet_type === 'tansho' ? r.rank_num === 1 : r.amount != null
  const settled = buys.filter((r) => r.rank_num != null)
  const bet = settled.length * 100
  const ret = settled.reduce((a, r) => a + (won(r) ? (r.amount ?? 0) : 0), 0)
  const hit = settled.filter(won).length
  console.log(`\n${'='.repeat(58)}\n${label}\n${'='.repeat(58)}`)
  if (!buys.length) {
    // ★判定前(pending)と、判定した上での見送りを混同しない。
    //   混ぜると「全部見送った日」に見えるが、実際はまだ判定の最中のことがある。
    const pend = list.filter((r) => r.decision === 'pending').length
    const skip = list.filter((r) => r.decision === 'skip').length
    const noo = list.filter((r) => r.decision === 'no_odds').length
    if (!list.length) { console.log('\n候補なし'); return { bet: 0, ret: 0, hit: 0, n: 0 } }
    if (pend === list.length) {
      console.log(`\n候補${list.length}本は判定待ちです（各レースの締切2分前に判定します）`)
      return { bet: 0, ret: 0, hit: 0, n: 0 }
    }
    console.log(`\n買い目なし（候補${list.length}本）`)
    if (skip) console.log(`  必要倍率(1÷確率×余裕)に届かず見送り: ${skip}本`)
    if (noo) console.log(`  オッズ未形成で見送り: ${noo}本`)
    if (pend) console.log(`  判定待ち: ${pend}本`)
    return { bet: 0, ret: 0, hit: 0, n: 0 }
  }
  console.log('')
  for (const r of buys) {
    const res = r.rank_num == null ? '結果待ち'
      : won(r) ? `的中  払戻 ${r.amount}円` : `不的中（${r.rank_num}着）`
    console.log(`  ${r.deadline}  [${({tansho:'単勝',fukusho:'複勝',fuku90:'複勝・高的中'})[r.bet_type]}] ${r.venue}${r.race_no}R  ${r.lane}号艇 ${r.racer}`)
    console.log(`          確率${(r.p * 100).toFixed(0)}%  購入時オッズ${r.odds_seen?.toFixed(1)}倍  → ${res}`)
  }
  const pending = list.filter((r) => r.decision === 'pending').length
  const skipped = list.filter((r) => r.decision === 'skip').length
  const noodds = list.filter((r) => r.decision === 'no_odds').length
  const capped = list.filter((r) => r.decision === 'capped').length
  console.log(`\n  候補${list.length}本 → 購入${buys.length}本`)
  console.log(`  見送り: 必要倍率未満${skipped}本${noodds ? ` / オッズ未形成${noodds}本` : ''}${capped ? ` / 上限到達${capped}本` : ''}${pending ? ` / 判定待ち${pending}本` : ''}`)
  if (settled.length) {
    console.log(`\n  ${settled.length}点  的中${hit}本（${(hit / settled.length * 100).toFixed(1)}%）`)
    console.log(`  投資 ${bet.toLocaleString()}円  払戻 ${ret.toLocaleString()}円  収支 ${ret - bet >= 0 ? '+' : ''}${(ret - bet).toLocaleString()}円  回収率 ${(ret / bet * 100).toFixed(1)}%`)
  }
  if (settled.length < buys.length) console.log(`  ※ ${buys.length - settled.length}本は結果待ち（払戻は翌日昼公開）`)
  return { bet, ret, hit, n: settled.length }
}

if (!ALL) report(`【結果】${DATE}`, rows(`WHERE b.date=?`, DATE))

// ---------- 累計 ----------
const all = rows(`WHERE 1=1`)
const t = report(`【累計】${all.length ? all[0].date + ' 〜' : ''}`, all)
if (t.n) {
  const days = new Set(all.filter((r) => r.decision === 'buy').map((r) => r.date)).size
  console.log(`\n  ${days}日間で${t.n}点  1日平均${(t.n / days).toFixed(2)}本`)
  console.log(`\n  ※ 想定は的中28.6% / 回収151%（歩進検証8ヶ月）。`)
  console.log(`     100点に届くまでは、実績と想定がずれていても判断材料になりません。`)
  if (t.n < 100) console.log(`     現在${t.n}点。あと${100 - t.n}点。`)
}
db.close()
