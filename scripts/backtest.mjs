// 条件を1つ渡すと5検定を全部かけて返す。bt 表を使うので数秒で終わる。
//
//   node scripts/backtest.mjs --type tansho --margin 2.0 --cap 3
//   node scripts/backtest.mjs --type fukusho --minp 0.94 --minodds 1.1 --cap 2 --ng 17,16,13,7
//   node scripts/backtest.mjs --type tansho --sweep margin=1.0,1.5,1.8,2.0,2.5
//   node scripts/backtest.mjs --type fukusho --minp 0.94 --minodds 1.1 --split
//
// ★なぜ道具にしたか
//   条件を1つ試すたびに使い捨てのスクリプトを書いていた。1回5〜8分かかるうえ、
//   毎回書き直すのでパースミスが増えた（2026-08-23に着順・払戻・race_idの桁で3件）。
//   検証の手順そのものを1本に固定して、条件だけを渡す形にする。
//
// ★5検定（1つでも落ちたら採用しない）
//   【1】月別        100%超えが8/8か。偶然なら月がバラつく
//   【2】前半後半    半分に割っても両方100%超えか
//   【3】高配当依存  上位3本・10本を除いても100%超えか
//   【4】ブート      20,000回の再抽出で100%割れ確率が十分小さいか
//   【5】単調性      閾値を上げるほど回収率が上がるか（--sweep）。飛び跳ねたら偶然
//
// ★--split は過学習チェック
//   前半で条件を決めて後半で試す形にしないと、後から見て良かったものを
//   選んだだけになる。場フィルタで実際に問題になった。
//
// ★注意：足切りに使う odds は確定オッズ
//   買う時点では分からない。実運用は締切2〜3分前のオッズで判断するので、
//   ここで出る回収率は「必要倍率を正しく満たせた場合」の値。
//   締切前オッズとのズレは odds_live 側で別に測る。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { minOddsFor } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bt'`).get()) {
  console.error('bt 表がありません。先に  node --max-old-space-size=8192 scripts/bt-build.mjs')
  process.exit(1)
}
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const numOrNull = (n) => { const v = flag(n); return v == null ? null : Number(v) }

const TYPE = flag('type', 'tansho')
const CAP = Number(flag('cap', TYPE === 'tansho' ? 3 : 4))
const NG = new Set((flag('ng', '') || '').split(',').filter(Boolean).map(Number))
const CALM = argv.includes('--calm')
const LABEL = { tansho: '単勝', fukusho: '複勝' }[TYPE] ?? TYPE

const rows = db.prepare(`SELECT * FROM bt WHERE bet_type=? ORDER BY date, dl, race_id`).all(TYPE)

/** 条件を満たすか。margin があれば損益分岐方式、minodds なら固定の下限 */
function keep(x, o) {
  if (o.minp != null && x.p < o.minp) return false
  if (o.maxp != null && x.p >= o.maxp) return false
  if (o.margin != null && x.odds < minOddsFor(x.p, o.margin)) return false
  if (o.minodds != null && x.odds < o.minodds) return false
  if (NG.size && NG.has(x.jcd)) return false
  if (CALM && !((x.wind ?? 0) < 5 && (x.wave ?? 0) < 5)) return false
  return true
}

/** 締切が早い順に上限まで買う＝実運用と同じ手順。
 *  確率順に選ぶと後のレースのオッズを知っている前提になる（＝先読み）。 */
function pick(o, cap = CAP, src = rows) {
  const byDay = new Map()
  for (const x of src) {
    if (!keep(x, o)) continue
    let a = byDay.get(x.date); if (!a) { a = []; byDay.set(x.date, a) }
    a.push(x)
  }
  const out = []
  for (const [, v] of byDay) out.push(...v.sort((a, b) => a.dl - b.dl).slice(0, cap))
  return out.sort((a, b) => a.race_id.localeCompare(b.race_id))
}

const agg = (S) => ({
  n: S.length, days: new Set(S.map((x) => x.date)).size,
  hit: S.filter((x) => x.hit).length / S.length,
  roi: S.reduce((a, x) => a + x.pay, 0) / S.length,
  odds: S.reduce((a, x) => a + x.odds, 0) / S.length,
})

// ★mulberry32。素朴なLCGは2^53を超えて区間が3割狭くなる
const rng = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const opt = { minp: numOrNull('minp'), maxp: numOrNull('maxp'),
  margin: numOrNull('margin'), minodds: numOrNull('minodds') }
const cond = [
  opt.minp != null && `確率${(opt.minp * 100).toFixed(0)}%以上`,
  opt.maxp != null && `確率${(opt.maxp * 100).toFixed(0)}%未満`,
  opt.margin != null && `必要倍率=(1÷確率)×${opt.margin}`,
  opt.minodds != null && `${opt.minodds}倍以上`,
  NG.size > 0 && `場除外[${[...NG].join(',')}]`,
  CALM && `風5m未満・波5cm未満`,
  `1日${CAP}本`,
].filter(Boolean).join(' / ')

// ---------- 【5】単調性 ----------
const sweep = flag('sweep')
if (sweep) {
  const [key, list] = sweep.split('=')
  console.log(`【5】単調性　${LABEL}　${key} を動かす（上限${CAP}本・締切順）`)
  for (const v of list.split(',').map(Number)) {
    const S = pick({ ...opt, [key]: v })
    if (S.length < 40) { console.log(`  ${key}=${v}  該当${S.length}本（少なすぎ）`); continue }
    const a = agg(S)
    console.log(`  ${key}=${String(v).padEnd(5)} n=${String(a.n).padStart(4)} 1日${(a.n / a.days).toFixed(2)}本 的中${(a.hit * 100).toFixed(1).padStart(5)}% 回収${(a.roi * 100).toFixed(1).padStart(6)}%`)
  }
  if (opt.minp == null && opt.margin == null && opt.minodds == null) { db.close(); process.exit(0) }
  console.log('')
}

// ---------- 過学習チェック ----------
if (argv.includes('--split')) {
  const months = [...new Set(rows.map((x) => x.mon))].sort()
  const half = months[Math.floor(months.length / 2)]
  const tr = rows.filter((x) => x.mon < half), te = rows.filter((x) => x.mon >= half)
  console.log(`【過学習チェック】前半 ${months[0]}〜 ／ 後半 ${half}〜`)
  for (const [lab, src] of [['前半', tr], ['後半', te]]) {
    const S = pick(opt, CAP, src)
    if (S.length < 30) { console.log(`  ${lab}  該当${S.length}本`); continue }
    const a = agg(S)
    console.log(`  ${lab}  n=${String(a.n).padStart(4)} 的中${(a.hit * 100).toFixed(1)}% 回収${(a.roi * 100).toFixed(1)}%`)
  }
  console.log('  → 後半が前半より大きく落ちるなら、前半に合わせただけの疑い\n')
}

// ---------- 本体 ----------
const S = pick(opt)
console.log(`═══ ${LABEL}　${cond} ═══`)
if (S.length < 60) { console.log(`該当${S.length}本。少なすぎて検証できない`); db.close(); process.exit(0) }
const a = agg(S)
console.log(`${a.n}点（${a.days}日・1日${(a.n / a.days).toFixed(2)}本）  的中${(a.hit * 100).toFixed(1)}%  回収${(a.roi * 100).toFixed(1)}%  平均確定${a.odds.toFixed(2)}倍`)

const M = new Map()
for (const x of S) { const q = M.get(x.mon) || [0, 0]; q[0]++; q[1] += x.pay; M.set(x.mon, q) }
let over = 0; const ln = []
for (const [m, q] of [...M].sort()) { const r = q[1] / q[0] * 100; if (r > 100) over++; ln.push(`${m.slice(5)}:${r.toFixed(0)}%`) }
const p1 = over === M.size
console.log(`【1】月別 ${over}/${M.size} ${p1 ? 'OK' : 'NG'}  ${ln.join(' ')}`)

const h = S.slice(0, S.length >> 1), t = S.slice(S.length >> 1)
const rh = h.reduce((x, y) => x + y.pay, 0) / h.length
const rt = t.reduce((x, y) => x + y.pay, 0) / t.length
const p2 = rh > 1 && rt > 1
console.log(`【2】前半${(rh * 100).toFixed(1)}% / 後半${(rt * 100).toFixed(1)}% ${p2 ? 'OK' : 'NG'}`)

const ws = S.filter((x) => x.hit).sort((x, y) => y.pay - x.pay)
const ex = (k) => ws.slice(k).reduce((x, y) => x + y.pay, 0) / S.length
const p3 = ex(10) > 1
console.log(`【3】的中${ws.length}本 最高${ws[0].pay.toFixed(1)}倍  上位3除外→${(ex(3) * 100).toFixed(1)}%  上位10除外→${(ex(10) * 100).toFixed(1)}% ${p3 ? 'OK' : 'NG'}`)

const arr = S.map((x) => x.pay), R = rng(824), bs = []
for (let b = 0; b < 20000; b++) {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[(R() * arr.length) | 0]
  bs.push(s / arr.length)
}
bs.sort((x, y) => x - y)
const under = bs.filter((v) => v < 1).length / 200
const p4 = under < 5
console.log(`【4】ブート 中央${(bs[10000] * 100).toFixed(1)}% 90%[${(bs[1000] * 100).toFixed(1)}%, ${(bs[19000] * 100).toFixed(1)}%] 100%割れ${under.toFixed(2)}% ${p4 ? 'OK' : 'NG'}`)

const passed = [p1, p2, p3, p4].filter(Boolean).length
console.log(`\n判定：${passed}/4 通過${passed === 4 ? '　→ 採用の候補（--sweep で単調性も確認すること）' : '　→ 採用しない'}`)
db.close()
