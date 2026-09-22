// 的中率だけを測る。券種ごと・買い点数ごと。回収率は見ない。
//
//   node --max-old-space-size=8192 scripts/hitrate.mjs --t3 wk3
//   node --max-old-space-size=8192 scripts/hitrate.mjs --t3 wn3 --compare wk3
//
// ★方針（本人の指示）
//   「回収率はいい。まずは的中率だけでいい」
//   モデルを直すたびにこのコマンドで比べる。改善したかどうかだけを見る。
//
// ★測るもの
//   単勝・2連単・2連複・3連単・3連複について、
//   確率が高い順に N 点買ったときの的中率。
//   目標は2連単90%。何点でそこに届くかを追う。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T3 = flag('t3', 'wk3')
const CMP = flag('compare', null)

// 実際の1〜3着
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}

/** 券種ごとに「当たった組が何番目の予想だったか」を返す */
function ranks(table) {
  const out = { tansho: [], nirentan: [], nirenpuku: [], sanrentan: [], sanrenpuku: [] }
  const cur = new Map()
  let curId = null
  const flush = (rid, rows) => {
    const o = ORD.get(rid); if (!o || !o[1] || !o[2] || !o[3]) return
    const agg = (keyFn) => {
      const m = new Map()
      for (const r of rows) m.set(keyFn(r.combo), (m.get(keyFn(r.combo)) ?? 0) + r.p)
      return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    }
    const first = (c) => c.slice(0, c.indexOf('-'))
    const two = (c) => c.slice(0, c.lastIndexOf('-'))
    const twoU = (c) => two(c).split('-').map(Number).sort((a, b) => a - b).join('-')
    const threeU = (c) => c.split('-').map(Number).sort((a, b) => a - b).join('-')
    const put = (k, list, want) => { const i = list.indexOf(want); if (i >= 0) out[k].push(i + 1) }
    put('tansho', agg(first), String(o[1]))
    put('nirentan', agg(two), `${o[1]}-${o[2]}`)
    put('nirenpuku', agg(twoU), [o[1], o[2]].sort((a, b) => a - b).join('-'))
    put('sanrentan', agg((c) => c), `${o[1]}-${o[2]}-${o[3]}`)
    put('sanrenpuku', agg(threeU), [o[1], o[2], o[3]].sort((a, b) => a - b).join('-'))
  }
  let buf = []
  for (const r of db.prepare(`SELECT race_id,combo,p FROM ${table} ORDER BY race_id`).iterate()) {
    if (curId !== null && r.race_id !== curId) { flush(curId, buf); buf = [] }
    curId = r.race_id; buf.push(r)
  }
  if (curId !== null) flush(curId, buf)
  return out
}

const LABEL = { tansho: '単勝', nirentan: '2連単', nirenpuku: '2連複', sanrentan: '3連単', sanrenpuku: '3連複' }
const MAXN = { tansho: 6, nirentan: 30, nirenpuku: 15, sanrentan: 120, sanrenpuku: 20 }

console.log(`予想テーブル ${T3}${CMP ? `　比較対象 ${CMP}` : ''}\n`)
const A = ranks(T3)
const B = CMP ? ranks(CMP) : null

const curve = (arr, n) => arr.filter((x) => x <= n).length / arr.length * 100

for (const k of ['tansho', 'nirentan', 'nirenpuku', 'sanrentan', 'sanrenpuku']) {
  const a = A[k]; if (!a.length) continue
  console.log(`════ ${LABEL[k]}　${a.length.toLocaleString()}レース ════`)
  const pts = k === 'tansho' ? [1, 2, 3, 4, 5, 6]
    : k === 'nirenpuku' ? [1, 2, 3, 4, 5, 6, 8, 10, 12, 15]
    : k === 'sanrenpuku' ? [1, 2, 3, 4, 6, 8, 10, 14, 20]
    : k === 'nirentan' ? [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 24, 30]
    : [1, 3, 6, 10, 18, 24, 36, 60, 90, 120]
  console.log('  点数  的中率' + (B ? '    比較対象     差' : ''))
  for (const n of pts) {
    if (n > MAXN[k]) continue
    const va = curve(a, n)
    let line = `${String(n).padStart(6)} ${va.toFixed(2).padStart(7)}%`
    if (B && B[k].length) {
      const vb = curve(B[k], n)
      const d = va - vb
      line += ` ${vb.toFixed(2).padStart(9)}% ${d >= 0 ? '+' : ''}${d.toFixed(2).padStart(6)}pt${Math.abs(d) >= 0.5 ? (d > 0 ? '  改善' : '  悪化') : ''}`
    }
    console.log(line)
  }
  // 90%に届く点数
  for (let n = 1; n <= MAXN[k]; n++) {
    if (curve(a, n) >= 90) { console.log(`  → 的中率90%には ${n}点`); break }
    if (n === MAXN[k]) console.log(`  → 全${MAXN[k]}点でも ${curve(a, n).toFixed(2)}%`)
  }
  console.log('')
}
db.close()
