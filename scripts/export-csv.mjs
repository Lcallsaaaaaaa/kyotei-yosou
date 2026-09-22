// 検証に使った全レースを1行ずつCSVに出す。人が自分で検算できるように。
//
//   node --max-old-space-size=8192 scripts/export-csv.mjs
//
// ★なぜ
//   私の文章での主張は当てにならない実績があるので、
//   元データを渡して自分で確かめられる形にする。
//   1行＝1レース。モデルの予想・確定オッズ・実払戻・実際の1着が全部入る。
//   条件を満たしたか（買い判定）も計算済みで入れる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { minOddsFor, MARGIN, FUKU } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const VN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }

// 単勝・複勝の候補（bt = 検証用に作った表）
const BT = { tansho: new Map(), fukusho: new Map() }
for (const r of db.prepare(`SELECT race_id,bet_type,lane,p,odds,pay,hit FROM bt`).all())
  BT[r.bet_type]?.set(r.race_id, r)

// レース情報
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,date,jcd,race_no,deadline,grade,wind_speed,wave FROM races`).all())
  RC.set(r.race_id, r)

// 実際の1着
const WIN = new Map()
for (const r of db.prepare(`SELECT race_id,lane FROM entries WHERE rank_num=1`).all())
  WIN.set(r.race_id, r.lane)

// 締切前オッズ（記録のある日だけ）
const PRE = { tansho: new Map(), fukusho: new Map() }
for (const [key, col, lo, hi] of [['tansho', 'tansho', 1.15, 1.60], ['fukusho', 'fukusho_lo', FUKU.sumLo, FUKU.sumHi]]) {
  const raw = new Map()
  for (const r of db.prepare(`SELECT race_id,lane,mins_before,${col} v FROM odds_live
      WHERE mins_before BETWEEN 0 AND 20 AND ${col} > 0`).all()) {
    let m = raw.get(r.race_id); if (!m) { m = new Map(); raw.set(r.race_id, m) }
    let o = m.get(r.mins_before); if (!o) { o = new Map(); m.set(r.mins_before, o) }
    o.set(r.lane, r.v)
  }
  for (const [rid, m] of raw)
    for (const mins of [...m.keys()].sort((a, b) => a - b)) {     // 締切に近い順
      const o = m.get(mins)
      if (o.size < 4) continue
      const s = [...o.values()].reduce((a, n) => a + 1 / n, 0)
      if (s < lo || s > hi) continue
      PRE[key].set(rid, { odds: o, mins }); break
    }
}

const H = ['日付', '場', 'R', '締切', 'グレード', '風速', '波高', '実際の1着',
  '単勝_本命艇', '単勝_確率', '単勝_必要倍率', '単勝_確定オッズ', '単勝_条件充足', '単勝_実払戻', '単勝_締切前オッズ', '単勝_何分前',
  '複勝_本命艇', '複勝_確率', '複勝_必要倍率', '複勝_確定下限', '複勝_条件充足', '複勝_実払戻', '複勝_締切前下限', '複勝_何分前']
const rows = [H.join(',')]
const ids = [...new Set([...BT.tansho.keys(), ...BT.fukusho.keys()])].sort()
for (const rid of ids) {
  const rc = RC.get(rid); if (!rc) continue
  const t = BT.tansho.get(rid), f = BT.fukusho.get(rid)
  const pt = t ? PRE.tansho.get(rid) : null, pf = f ? PRE.fukusho.get(rid) : null
  const cell = (v) => v == null ? '' : v
  const need = (x, mg) => x ? minOddsFor(x.p, mg).toFixed(2) : ''
  rows.push([
    rc.date, VN[rc.jcd] ?? rc.jcd, rc.race_no, rc.deadline ?? '', rc.grade ?? '',
    cell(rc.wind_speed), cell(rc.wave), cell(WIN.get(rid)),
    t ? t.lane : '', t ? (t.p * 100).toFixed(1) : '', need(t, MARGIN), t ? t.odds : '',
    t ? (t.odds >= minOddsFor(t.p, MARGIN) ? 1 : 0) : '', t ? Math.round(t.pay * 100) : '',
    cell(pt?.odds.get(t?.lane)), cell(pt?.mins),
    f ? f.lane : '', f ? (f.p * 100).toFixed(1) : '', need(f, FUKU.margin), f ? f.odds : '',
    f ? (f.odds >= minOddsFor(f.p, FUKU.margin) ? 1 : 0) : '', f ? Math.round(f.pay * 100) : '',
    cell(pf?.odds.get(f?.lane)), cell(pf?.mins),
  ].join(','))
}
const path = join(ROOT, 'data', 'races.csv')
writeFileSync(path, rows.join('\n'), 'utf8')
console.log(`${rows.length - 1}行 → ${path}`)
console.log(`サイズ ${(Buffer.byteLength(rows.join('\n')) / 1024 / 1024).toFixed(2)} MB`)
console.log(`期間 ${rows[1].split(',')[0]} 〜 ${rows[rows.length - 1].split(',')[0]}`)
db.close()
