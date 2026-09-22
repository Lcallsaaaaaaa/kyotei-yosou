// 場を指定して、その日の全12レースの予想をまとめて見る。
//
//   node scripts/venue.mjs 児島
//   node scripts/venue.mjs 児島 --date 2026-08-22
//
// ★有料候補には印を付ける
//   同じ画面で「これは条件を満たす／満たさない」が分かるようにする。
//   印が無いレースを雰囲気で買うと、検証していない買い方になる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runPredict, deadlines, candidates, winRates, MIN_P, MAX_P, MAX_WR, MARGIN, minOddsFor } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const p2 = (n) => String(n).padStart(2, '0')
const DATE = flag('date', (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` })())
const YMD = DATE.replace(/-/g, '')

const VENUE = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国',
  'びわこ', '住之江', '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']
const NAME = argv.find((a) => VENUE.includes(a))
if (!NAME) { console.error(`場名を指定してください。例: node scripts/venue.mjs 児島\n  ${VENUE.slice(1).join(' ')}`); process.exit(1) }
const JCD = VENUE.indexOf(NAME)

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const pred = await runPredict(ROOT, DATE)
const DL = await deadlines(YMD, [JCD])
const WR = winRates(db, YMD)
const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes()

const rs = pred.races.filter((x) => x.jcd === JCD).map((x) => {
  const dl = DL.get(JCD)?.[x.race_no - 1] ?? null
  const mins = dl ? Number(dl.slice(0, 2)) * 60 + Number(dl.slice(3)) : null
  return { ...x, dl, mins, until: mins == null ? null : mins - nowMin }
}).sort((a, b) => a.race_no - b.race_no)
if (!rs.length) { console.error(`${DATE} に ${NAME} の開催がありません`); process.exit(1) }

// 有料候補（strategy.mjs の条件をそのまま使う）
const cand = new Set(candidates(pred.races, WR).filter((c) => c.x.jcd === JCD).map((c) => c.x.race_id + '|' + c.lane))

const head = rs[0]
console.log(`\n${'='.repeat(66)}`)
console.log(`【${NAME}】${DATE}${head.series ? '　' + head.series : ''}${head.grade && head.grade !== '一般' ? '　' + head.grade : ''}`)
console.log(`${'='.repeat(66)}`)
console.log(`現在 ${now.toTimeString().slice(0, 5)}　　済=締切済 / ▶=まもなく締切 / ★=有料候補\n`)

for (const x of rs) {
  const past = x.until != null && x.until < 0
  const soon = x.until != null && x.until >= 0 && x.until <= 30
  const f = x.first
  const isCand = cand.has(x.race_id + '|' + f[0].lane)
  const wr = WR.get(x.race_id + '|' + f[0].lane)
  console.log(`${past ? '済' : soon ? '▶' : ' '} ${String(x.race_no).padStart(2)}R ${x.dl}` +
    `${x.until != null && x.until >= 0 ? `（あと${x.until}分）` : ''}${isCand ? '　★有料候補' : ''}`)
  console.log(`     1着 ${f.slice(0, 3).map((y) => `${y.lane}号艇 ${y.name}(${(y.p * 100).toFixed(0)}%)`).join(' / ')}`)
  console.log(`     3連複3点 ${x.trio.map((t) => t.combo).join(' / ')}　合計${(x.conf * 100).toFixed(1)}%` +
    `${wr != null ? `　本命の全国勝率${wr.toFixed(2)}` : ''}`)
}

const n = rs.filter((x) => cand.has(x.race_id + '|' + x.first[0].lane)).length
console.log(`\n${'─'.repeat(66)}`)
console.log(`★有料候補 ${n}本　条件：単勝オッズ ≥ (1÷1着確率)×${MARGIN}`)
console.log(`　→ 締切2〜3分前に必要倍率以上なら買い。下回れば見送り。`)
console.log(`\n※ 3連複3点は 的中54.1% / 回収78.8%（8ヶ月35,668レース）。当たっても平均では負けます。`)
db.close()
