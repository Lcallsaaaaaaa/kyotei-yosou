// 買い方を5つの型に分けて、学習外で的中率と回収率を測る。
//
//   node --max-old-space-size=6144 scripts/patterns-test.mjs
//
// ★なぜ型に分けるか（2026-10-06）
//   teikore などの予想サイトは「本命型・中穴型・大穴型」のように
//   **狙いの違いで買い目を出し分けている**。こちらはいま1通りしか出していない。
//   同じモデルから出し分けられるなら、見せ方を増やせる。
//
// ★⚠ 回収率が100%を超える型は（たぶん）無い。
//   控除率25%があるので、当たり前に負ける（[[boatrace-hitrate-vs-roi]]）。
//   だから測るのは「どれが使えるか」ではなく **どれがどういう負け方をするか**。
//   出すときに「的中はこれくらい・回収はこれくらい」と正直に書くための材料。
//   **利益が出ると読める書き方をしてはいけない**（strategy.mjs の無料配信と同じ）。
//
// ★⚠ 既存の配信と並べるときは「自信度の上位10%」で見ること（2026-10-06）
//   既存の公表値は **3連複82.6% / 3連単45.7%**。これは自信度0.7645以上＝
//   **上位10%のレースだけ**の数字（[[boatrace-haishin]]）。
//   全レースで測ると 63.2% / 30.4% になるが、これは精度が落ちたのではなく
//   **絞っていないだけ**。並べて出すと「下がった」と誤読される。
//   → このスクリプトは全レースと上位10%の両方を出す。
//
//   自信度 = 3連複の上位4組の確率の合計。
//   ⚠ 足切りの 0.7645 は pred3（本番）側の値で、wi3 では使えない。
//     **同じ分位点（上位10%）を wi3 側で取り直す**（[[boatrace-model-vs-walk]]）。
//
// ★材料は wi3（歩進検証の3連単確率・45,340レース）。学習に使っていない期間の予測。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf("--" + n); return i > -1 ? argv[i + 1] : d }
// 本番の手札。2026-10-06から predict.mjs は3連単を120点（全部）保存している。
// --pool 24 を渡すと、保存点数を上げる前の本番と同じ条件で測れる。
const POOL = Number(flag('pool', '120'))
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 30000')
console.log('材料を読み込んでいます…（3連単120通り×45,340レース）')

// 3連単の確率（学習外）
const P = new Map()
for (const r of db.prepare('SELECT race_id, combo, p FROM wi3').all()) {
  if (!P.has(r.race_id)) P.set(r.race_id, [])
  P.get(r.race_id).push({ combo: r.combo, p: r.p })
}
// 確定払戻
const payT = new Map(), payF = new Map()
for (const r of db.prepare(`SELECT race_id, bet_type, combo, amount FROM payouts
  WHERE bet_type IN ('sanrentan','sanrenpuku')`).all())
  (r.bet_type === 'sanrentan' ? payT : payF).set(`${r.race_id}|${r.combo}`, r.amount)
db.close()

const ids = [...P.keys()].filter((id) => [...payT.keys()].length && P.get(id).length >= 60).sort()
console.log('')
console.log(`■ 学習外 ${ids.length.toLocaleString()}レース（${ids[0].slice(0, 8)}〜${ids.at(-1).slice(0, 8)}）`)
const CUT = ids[Math.floor(ids.length / 2)].slice(0, 8)
const half = (id) => (id.slice(0, 8) < CUT ? 0 : 1)
console.log(`  前半 〜${CUT} ／ 後半 ${CUT}〜`)
console.log('')

/** 3連単の組から、1着・2着・3着の艇を取り出す */
const parts = (c) => c.split('-').map(Number)
/** 3連複の組（昇順で並べ直す） */
const toFuku = (c) => parts(c).slice().sort((a, b) => a - b).join('-')

// ---------- 型の定義 ----------
// どれも「同じ確率表」から選ぶ。違うのは**どこを狙うか**だけ。
const PATTERNS = [
  ['本命　3連単4点', 'tan', (cs) => cs.slice(0, 4).map((x) => x.combo)],
  ['本命　3連複4点', 'fuku', (cs) => {
    const seen = new Set(), out = []
    for (const x of cs) { const f = toFuku(x.combo); if (!seen.has(f)) { seen.add(f); out.push(f) } if (out.length === 4) break }
    return out
  }],
  ['中穴　本命を2・3着に置く（3連単4点）', 'tan', (cs) => {
    // いちばん確率の高い艇を1着から外し、2着か3着に置いた組だけから4点
    const top = parts(cs[0].combo)[0]
    return cs.filter((x) => { const [a, b, c] = parts(x.combo); return a !== top && (b === top || c === top) })
      .slice(0, 4).map((x) => x.combo)
  }],
  ['大穴　本命を外す（3連単4点）', 'tan', (cs) => {
    const top = parts(cs[0].combo)[0]
    return cs.filter((x) => !parts(x.combo).includes(top)).slice(0, 4).map((x) => x.combo)
  }],
  ['堅実　3連複2点', 'fuku', (cs) => {
    const seen = new Set(), out = []
    for (const x of cs) { const f = toFuku(x.combo); if (!seen.has(f)) { seen.add(f); out.push(f) } if (out.length === 2) break }
    return out
  }],
]

const yen = (v) => Math.round(v).toLocaleString().padStart(7) + '円'

// ---------- 自信度（3連複の上位4組の合計）を各レースに付ける ----------
const confOf = new Map()
for (const id of ids) {
  const cs = P.get(id).slice().sort((a, b) => b.p - a.p)
  const seen = new Set(), groups = []
  for (const x of cs) { const f = toFuku(x.combo); if (!seen.has(f)) { seen.add(f); groups.push(f) } if (groups.length === 4) break }
  let c = 0
  for (const x of cs) if (seen.has(toFuku(x.combo))) c += x.p
  confOf.set(id, c)
}
// 上位10%の境目を wi3 側で取り直す（本番の 0.7645 は流用しない）
const TH = ids.map((id) => confOf.get(id)).sort((a, b) => b - a)[Math.floor(ids.length * 0.10)]
console.log(`  手札＝上位${POOL}点（本番の predict.mjs と同じ）`)
console.log(`  自信度の上位10%の境目（wi3側）= ${TH.toFixed(4)}　※本番側の 0.7645 とは別物`)
console.log('')

function table(label, set) {
  console.log(`【${label}】${set.length.toLocaleString()}レース`)
  console.log('  型                                点数  的中(前/後)      回収(前/後)    平均配当   最高配当   万舟の出方')
  const out = []
  for (const [name, kind, pick] of PATTERNS) {
    const pay = kind === 'tan' ? payT : payF
    const s = [0, 1].map(() => ({ races: 0, bets: 0, hit: 0, ret: 0 }))
    let pts = 0, ptsN = 0, best = 0, bestId = null, man = 0
    for (const id of set) {
      // ★本番と同じ手札にする（2026-10-06）
      //   predict.mjs は3連単を**上位24点しか保存しない**。120通り全部で測ると、
      //   大穴（本命を外す組）が本番では4点そろわないのに、測定では4点になる。
      //   実際に本番で試したら大穴が1〜2点しか出ず、測った物と出る物が違っていた。
      const cs = P.get(id).slice().sort((a, b) => b.p - a.p).slice(0, POOL)
      const buy = pick(cs)
      if (!buy?.length) continue
      const h = s[half(id)]
      h.races++; h.bets += buy.length
      pts += buy.length; ptsN++
      for (const c of buy) {
        const a = pay.get(`${id}|${c}`)
        if (a) {
          h.hit++; h.ret += a
          if (a > best) { best = a; bestId = id }
          if (a >= 10000) man++            // 万舟＝1万円以上
          break
        }
      }
    }
    if (!s[0].races || !s[1].races) { console.log(`  ${name}　対象レースがありません`); continue }
    const races = s[0].races + s[1].races
    const hit = s.map((h) => h.hit / h.races * 100)
    const roi = s.map((h) => h.ret / (h.bets * 100) * 100)
    const avg = s.reduce((t, h) => t + h.ret, 0) / Math.max(1, s.reduce((t, h) => t + h.hit, 0))
    // 万舟は「何レースに1回」で言う。率(%)だと小さすぎて伝わらない
    const per = man ? Math.round(races / man) : null
    console.log(`  ${name.padEnd(34)}${(pts / ptsN).toFixed(1).padStart(4)}  `
      + `${hit[0].toFixed(1).padStart(5)}%/${hit[1].toFixed(1).padStart(5)}%  `
      + `${roi[0].toFixed(1).padStart(6)}%/${roi[1].toFixed(1).padStart(6)}%  ${yen(avg)}  ${yen(best)}  `
      + (per ? `${String(per).padStart(4)}レースに1回（${man}本）` : '出ていません'))
    out.push({ name, races, hit, roi, avg, best, bestId, man, per, pts: pts / ptsN })
  }
  return out
}

// 荒れそうなレース＝自信度の低いほう。中穴・大穴はこちらに回す設計
const TL = ids.map((id) => confOf.get(id)).sort((a, b) => a - b)[Math.floor(ids.length * 0.50)]
const TL10 = ids.map((id) => confOf.get(id)).sort((a, b) => a - b)[Math.floor(ids.length * 0.10)]
console.log(`  自信度の下位50%の境目 = ${TL.toFixed(4)} ／ 下位10% = ${TL10.toFixed(4)}`)
console.log('')

table('① 全レース', ids)
console.log('')
table('② 自信度の上位10%（既存の配信と同じ絞り込み・本命型を出す枠）', ids.filter((id) => confOf.get(id) >= TH))
console.log('')
table('③ 自信度の上位50%（固い型をここまで広げる案）', ids.filter((id) => confOf.get(id) > TL))
console.log('')
table('④ 自信度の下位50%（荒れそうなレース・中穴と大穴を出す枠）', ids.filter((id) => confOf.get(id) <= TL))
console.log('')
table('⑤ 自信度の下位10%（いちばん荒れそうなレース）', ids.filter((id) => confOf.get(id) <= TL10))
console.log('')
console.log('■ 読み方')
console.log('  ・**既存の公表値と並べるのは②のほう**（3連複82.6% / 3連単45.7%）。')
console.log('    ①を並べると「下がった」と誤読される。絞っていないだけ')
console.log('  ・回収率はどの型も100%未満。控除率25%があるので当たり前に負ける')
console.log('  ・意味があるのは「当たる型（本命）」と「当たらないが配当が大きい型（大穴）」の')
console.log('    **負け方の違い**。好みに合わせて選べるようにするための材料')
console.log('  ・画面に出すときは的中率と回収率を必ず並べて書く。回収率だけ隠すのは不誠実')
console.log('※ 回収率は確定払戻。締切前に同じ値で買えるとは限らない（[[boatrace-tansho-not-executable]]）')
