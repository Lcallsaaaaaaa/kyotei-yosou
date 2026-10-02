// 「期待値順に買う」を測る。確率順と並べて出す。
//
//   node --max-old-space-size=4096 scripts/ev-test.mjs
//
// ★必ず2つ出す（claim.mjs と同じ考え方）
//   上限（参考） … 確定オッズで並べ替えた場合。**買う時点では分からない数字**。
//                  単勝で「期待値順なら186%」と出たのがこれで、締切2分前の実オッズで
//                  並べ直すと99.1%だった（2026-08-21）。上限であって根拠ではない。
//   実行できる側 … 締切前オッズ（odds_snap・大半が締切5分前）で並べ替えた場合。
//                  こちらだけが実際にできること。ただし921レースしかない。
//   片方だけを取り出して使わないこと。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

// 3連単の確定払戻（＝当たったときに戻る金額）
const pay = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrentan'`).all())
  pay.set(r.race_id + '|' + r.combo, r.amount)

const PTS = [2, 4, 6]
const mk = () => ({ n: 0, byP: PTS.map(() => ({ hit: 0, ret: 0 })), byE: PTS.map(() => ({ hit: 0, ret: 0 })) })

/** 1レース分を集計に足す。rows=[{combo,p,odds}] */
function feed(acc, raceId, rows) {
  const got = (list) => { let s = 0; for (const x of list) { const a = pay.get(raceId + '|' + x.combo); if (a != null) s += a } return s }
  const byP = rows.slice().sort((a, b) => b.p - a.p)
  const byE = rows.slice().sort((a, b) => b.p * b.odds - a.p * a.odds)
  acc.n++
  PTS.forEach((n, i) => {
    const gp = got(byP.slice(0, n)); if (gp) acc.byP[i].hit++; acc.byP[i].ret += gp
    const ge = got(byE.slice(0, n)); if (ge) acc.byE[i].hit++; acc.byE[i].ret += ge
  })
}

function report(title, acc, note) {
  console.log('■ ' + title + '（' + acc.n.toLocaleString() + 'レース）')
  if (note) console.log('  ' + note)
  console.log('  点数        確率順 的中/回収          期待値順 的中/回収')
  PTS.forEach((n, i) => {
    const p = acc.byP[i], e = acc.byE[i]
    const f = (x) => (x.hit / acc.n * 100).toFixed(1) + '% / ' + (x.ret / (acc.n * n * 100) * 100).toFixed(1) + '%'
    console.log('  ' + (n + '点').padEnd(10), f(p).padStart(20), f(e).padStart(24))
  })
  console.log('')
}

// ---------- ① 上限（参考）：確定オッズで並べ替え・wi3の確率 ----------
{
  const odds = db.prepare(`SELECT combo, odds FROM odds3t WHERE race_id=?`)
  const acc = mk()
  const it = db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()
  let cur = null, buf = []
  const flush = () => {
    if (!cur || !buf.length) return
    const o = new Map(odds.all(cur).map((r) => [r.combo, r.odds]))
    if (o.size >= 100 && buf.some((x) => pay.has(cur + '|' + x.combo))) {
      const rows = buf.map((x) => ({ ...x, odds: o.get(x.combo) ?? 0 })).filter((x) => x.odds > 0)
      if (rows.length >= 100) feed(acc, cur, rows)
    }
    buf = []
  }
  for (const r of it) { if (r.race_id !== cur) { flush(); cur = r.race_id } buf.push({ combo: r.combo, p: r.p }) }
  flush()
  report('上限（参考）：確定オッズで並べ替え', acc,
    '⚠ 確定オッズは買う時点では分からない。運用の根拠にはできない')
}

// ---------- ② 実行できる側：締切前オッズで並べ替え・pred3の確率 ----------
{
  const acc = mk()
  // ★phase 2＝締切5分前ごろ（実際に買える最後の時点）。2026-10-02に phase を足すまでは
  //   20分前のぶんが5分前に上書きされていたので、全部が「最後の1回」だった。
  const snapRaces = db.prepare(`SELECT DISTINCT race_id FROM odds_snap WHERE kind='sanrentan' AND phase=2`).all().map((r) => r.race_id)
  const probs = db.prepare(`SELECT combo, p FROM pred3 WHERE race_id=?`)
  const snap = db.prepare(`SELECT combo, odds FROM odds_snap WHERE race_id=? AND kind='sanrentan' AND phase=2`)
  const mins = new Map(db.prepare(`SELECT race_id, mins_before FROM odds_snap_meta WHERE phase=2`).all().map((r) => [r.race_id, r.mins_before]))
  let used = []
  for (const rid of snapRaces) {
    const P = probs.all(rid); if (P.length < 100) continue
    const o = new Map(snap.all(rid).map((r) => [r.combo, r.odds]))
    const rows = P.map((x) => ({ combo: x.combo, p: x.p, odds: o.get(x.combo) ?? 0 })).filter((x) => x.odds > 0)
    if (rows.length < 100) continue
    if (!rows.some((x) => pay.has(rid + '|' + x.combo))) continue
    feed(acc, rid, rows); used.push(mins.get(rid) ?? null)
  }
  const m = used.filter((x) => x != null)
  report('実行できる側：締切前オッズで並べ替え', acc,
    m.length ? `オッズを取った時点：締切 ${Math.min(...m)}〜${Math.max(...m)}分前（中央値 ${m.sort((a, b) => a - b)[Math.floor(m.length / 2)]}分前）` : '')
}

db.close()
