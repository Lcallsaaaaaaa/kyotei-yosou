// 「自信のあるレースだけ配信する」やり方が成立するかを、券種ごとに測る。
//
//   node scripts/select.mjs
//   node scripts/select.mjs --t3 wb3    直前情報を入れたモデルで測る
//
// ★何を確かめるのか
//   回収率100%超は達成できなかった。ならば商品を「勝てる予想」ではなく
//   「よく当たる予想」に変える案が出ている。それが成立するかを数字で見る。
//
//   ただし当たりやすい買い目はオッズが低い。当てても回収率は上がらない可能性が高い。
//   **的中率と回収率を必ず並べて出す。**片方だけ見せるのは客を欺くことになる。
//
// ★券種ごとの確率の出し方
//   3連単120通りの確率から、他の券種はすべて足し算で出せる。
//     単勝a      = 1着がaの20通りの合計
//     複勝a      = aが2着以内に入る組の合計
//     2連単a-b   = 1着a・2着bの4通りの合計
//     2連複a=b   = P(a-b) + P(b-a)
//     3連複a=b=c = 6通りの並べ替えの合計
//     拡連複a=b  = aとbが両方3着以内に入る組の合計
//
// ★回収率はオッズではなく払戻から出す
//   買った組が的中したときだけ払戻額が分かる（payouts）。外れた組は0円なので、
//   それで足りる。オッズ収集を待たずに全券種を測れる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T3 = flag('t3', 'walk3')
console.log(`使うモデル: ${T3}`)

// ---------- 払戻を読む ----------
const pay = new Map()   // race_id -> { bet_type -> Map(combo -> amount) }
for (const r of all(`SELECT race_id, bet_type, combo, amount FROM payouts`)) {
  let g = pay.get(r.race_id); if (!g) { g = {}; pay.set(r.race_id, g) }
  if (!g[r.bet_type]) g[r.bet_type] = new Map()
  g[r.bet_type].set(r.combo, r.amount)
}

// ---------- 3連単の確率を読み、他券種に展開する ----------
const races = []
{
  const m = new Map()
  for (const r of all(`SELECT race_id, combo, p FROM ${T3}`)) {
    let g = m.get(r.race_id); if (!g) { g = []; m.set(r.race_id, g) }
    g.push(r)
  }
  for (const [rid, rows] of m) {
    if (rows.length < 100 || !pay.has(rid)) continue
    const tot = rows.reduce((a, x) => a + x.p, 0)
    const trio = rows.map((x) => ({ c: x.combo.split('-').map(Number), p: x.p / tot }))
    // 各券種の確率
    const tansho = new Map(), fukusho = new Map(), nirentan = new Map(),
      nirenpuku = new Map(), sanrenpuku = new Map(), kakuren = new Map(), sanrentan = new Map()
    const add = (m2, k, v) => m2.set(k, (m2.get(k) ?? 0) + v)
    for (const { c: [a, b, d], p } of trio) {
      add(sanrentan, `${a}-${b}-${d}`, p)
      add(tansho, String(a), p)
      add(fukusho, String(a), p); add(fukusho, String(b), p)        // 複勝は2着以内
      add(nirentan, `${a}-${b}`, p)
      add(nirenpuku, [a, b].sort((x, y) => x - y).join('-'), p)
      add(sanrenpuku, [a, b, d].sort((x, y) => x - y).join('-'), p)
      // 拡連複＝3着以内の2艇の組。3艇から2組ずつ、計3通り
      const t3 = [a, b, d].sort((x, y) => x - y)
      add(kakuren, `${t3[0]}-${t3[1]}`, p)
      add(kakuren, `${t3[0]}-${t3[2]}`, p)
      add(kakuren, `${t3[1]}-${t3[2]}`, p)
    }
    races.push({ rid, probs: { tansho, fukusho, nirentan, nirenpuku, sanrenpuku, kakuren, sanrentan } })
  }
}
console.log(`${races.length.toLocaleString()} レース\n`)

const LABEL = { tansho: '単勝', fukusho: '複勝', nirentan: '2連単', nirenpuku: '2連複',
  sanrenpuku: '3連複', kakuren: '拡連複', sanrentan: '3連単' }

// ---------- 券種ごと：自信の高い順にレースを絞る ----------
// 「上位N点を買う」を券種ごとに評価し、自信（買い目の合計確率）でレースを並べ替える
for (const bt of ['sanrentan', 'sanrenpuku', 'nirentan', 'nirenpuku', 'kakuren', 'tansho']) {
  const PTS = bt === 'sanrentan' ? [1, 3, 6] : bt === 'sanrenpuku' ? [1, 2, 3] : bt === 'tansho' ? [1] : [1, 2]
  for (const nPick of PTS) {
    const rows = []
    for (const r of races) {
      const g = pay.get(r.rid)?.[bt]; if (!g) continue
      const cand = [...r.probs[bt]].sort((a, b) => b[1] - a[1]).slice(0, nPick)
      const conf = cand.reduce((a, x) => a + x[1], 0)     // 買い目全体の的中確率＝自信
      let back = 0, hit = 0
      for (const [c] of cand) { const amt = g.get(c); if (amt) { back += amt; hit = 1 } }
      rows.push({ conf, cost: nPick * 100, back, hit })
    }
    if (!rows.length) continue
    rows.sort((a, b) => b.conf - a.conf)
    const line = []
    for (const frac of [0.02, 0.05, 0.1, 0.25, 0.5, 1.0]) {
      const s = rows.slice(0, Math.max(30, Math.floor(rows.length * frac)))
      const hr = s.reduce((a, x) => a + x.hit, 0) / s.length
      const roi = s.reduce((a, x) => a + x.back, 0) / s.reduce((a, x) => a + x.cost, 0)
      line.push(`${(frac * 100).toFixed(0).padStart(3)}%: 的中${(hr * 100).toFixed(1).padStart(5)}% 回収${(roi * 100).toFixed(0).padStart(4)}%`)
    }
    console.log(`${LABEL[bt]} ${nPick}点買い（${rows.length.toLocaleString()}レース）`)
    console.log(`  上位 ${line.join('  |  ')}`)
  }
  console.log('')
}
console.log('※ 「上位X%」＝モデルが自信を持っている順にレースを絞った割合')
console.log('※ 的中＝そのレースで買い目のどれかが当たった割合。回収＝払戻÷購入額')
db.close()
