// 締切前オッズで同じ帯を選んだとき、確定オッズでの回収がどうなるか。
//   node scripts/live-check.mjs
//
// ★これが本番の形
//   選ぶ：モデルの確率 ＋ **締切前オッズ**（買う時点で見える）
//   払戻：確定オッズ（実際に受け取る額）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

// 締切前オッズ（分ごと）
const LV = new Map()
for (const r of db.prepare(`SELECT race_id, lane, mins_before, tansho FROM odds_live
    WHERE tansho IS NOT NULL ORDER BY race_id, lane, mins_before`).iterate()) {
  const k = r.race_id + '|' + r.lane
  let a = LV.get(k); if (!a) { a = []; LV.set(k, a) }
  a.push({ m: r.mins_before, o: r.tansho })
}
const FIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tansho FROM odds_tan WHERE tansho IS NOT NULL`).iterate())
  FIN.set(r.race_id + '|' + r.lane, r.tansho)
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id, lane FROM entries WHERE rank_num=1`).iterate())
  WIN.set(r.race_id, r.lane)

// 予想（本番の predict の出力を使う）
import { readdirSync, readFileSync } from 'node:fs'
const dir = join(ROOT, 'data')
const preds = new Map()
for (const f of readdirSync(dir).filter((x) => /^predict-\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  try {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    for (const r of (j.races ?? [])) {
      const bs = (r.first ?? []).filter((b) => b.p != null)
      if (bs.length !== 6) continue
      bs.sort((a, b) => b.p - a.p)
      preds.set(r.race_id, { p: bs[0].p, lane: bs[0].lane })
    }
  } catch {}
}
console.log(`本番の予想ファイル ${preds.size.toLocaleString()}レース分`)
console.log(`締切前オッズ ${new Set([...LV.keys()].map((k) => k.split('|')[0])).size.toLocaleString()}レース分\n`)

// 締切前オッズと確定オッズのずれ
const rows = []
for (const [rid, pr] of preds) {
  const lv = LV.get(rid + '|' + pr.lane)
  const fin = FIN.get(rid + '|' + pr.lane)
  const w = WIN.get(rid)
  if (!lv || !lv.length || !(fin > 0) || w == null) continue
  const pick = (mins) => { const c = lv.filter((x) => x.m >= mins); return c.length ? c[c.length - 1].o : null }
  rows.push({ rid, p: pr.p, lane: pr.lane, fin, hit: w === pr.lane,
    o0: pick(0), o2: pick(2), o5: pick(5), o10: pick(10) })
}
console.log(`突き合わせ ${rows.length.toLocaleString()}レース`)
if (!rows.length) { console.log('データが足りない'); db.close(); process.exit(0) }
for (const [nm, k] of [['締切0分前', 'o0'], ['2分前', 'o2'], ['5分前', 'o5'], ['10分前', 'o10']]) {
  const s = rows.filter((r) => r[k] > 0)
  if (s.length < 30) { console.log(`  ${nm} データ不足(${s.length})`); continue }
  const err = s.map((r) => Math.abs(r[k] - r.fin) / r.fin)
  err.sort((a, b) => a - b)
  console.log(`  ${nm.padEnd(10)} ${String(s.length).padStart(5)}本　確定とのずれ 中央${(err[Math.floor(err.length / 2)] * 100).toFixed(1)}%　平均${(err.reduce((a, b) => a + b, 0) / err.length * 100).toFixed(1)}%`)
}
console.log('\n締切前オッズで帯を選び、確定オッズで払い戻す')
console.log('  選ぶ基準            本数  的中率  回収率(確定)  参考:確定オッズで選んだ場合')
for (const [nm, k] of [['締切0分前', 'o0'], ['2分前', 'o2']]) {
  for (const [a, b] of [[1.6, 2.0], [2.0, 2.5], [2.5, 3.5], [3.5, 6]]) {
    const s = rows.filter((r) => r[k] > a && r[k] <= b)
    const t = rows.filter((r) => r.fin > a && r.fin <= b)
    if (s.length < 20) continue
    const ret = s.filter((r) => r.hit).reduce((x, r) => x + r.fin * 100, 0)
    const retT = t.filter((r) => r.hit).reduce((x, r) => x + r.fin * 100, 0)
    console.log(`  ${nm} ${a}〜${b}倍 ${String(s.length).padStart(6)}本 ${(s.filter((r) => r.hit).length / s.length * 100).toFixed(1).padStart(6)}% ${(ret / (s.length * 100) * 100).toFixed(1).padStart(11)}% ${t.length ? (retT / (t.length * 100) * 100).toFixed(1) + '% (' + t.length + '本)' : '-'}`)
  }
}
db.close()
