// レース結果を全部CSVに出す。
//
//   node --max-old-space-size=8192 scripts/export-results.mjs
//
// ★2種類出す
//   results.csv … 1行1レース。着順6艇・決まり手・主要券種の払戻
//   entries.csv … 1行1艇。選手・級別・勝率・モーター・展示・ST・進入・着順
//                 （予想のあるレースだけ。全期間だと巨大になるため）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
const VN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }

// 予想のあるレースに限定（それ以外は照合できない）
const TARGET = new Set(db.prepare(`SELECT DISTINCT race_id FROM bt`).all().map((r) => r.race_id))
console.log(`対象 ${TARGET.size.toLocaleString()}レース`)

const RC = new Map()
for (const r of db.prepare(`SELECT race_id,date,jcd,race_no,deadline,grade,series,title,
    weather,wind_dir,wind_speed,wave,kimarite,day_no,distance FROM races`).all())
  if (TARGET.has(r.race_id)) RC.set(r.race_id, r)

// 着順（rank_num 1..6 の艇番）
const ORD = new Map()
const ENT = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank,rank_num,racer_id,racer_name,
    motor_no,boat_no,exhibition,course,st,st_flag,race_time FROM entries`).all()) {
  if (!TARGET.has(r.race_id)) continue
  let a = ENT.get(r.race_id); if (!a) { a = []; ENT.set(r.race_id, a) }
  a.push(r)
  if (r.rank_num >= 1 && r.rank_num <= 6) {
    let o = ORD.get(r.race_id); if (!o) { o = {}; ORD.set(r.race_id, o) }
    o[r.rank_num] = r.lane
  }
}
// 払戻（券種ごと）
const PAY = new Map()
for (const r of db.prepare(`SELECT race_id,bet_type,combo,amount FROM payouts WHERE amount>0`).all()) {
  if (!TARGET.has(r.race_id)) continue
  let m = PAY.get(r.race_id); if (!m) { m = {}; PAY.set(r.race_id, m) }
  ;(m[r.bet_type] ||= []).push(`${r.combo}:${r.amount}`)
}
// 番組表
const PG = new Map()
for (const r of db.prepare(`SELECT race_id,lane,grade,win_rate_nat,top2_nat,win_rate_loc,top2_loc,
    motor_top2,boat_top2,age,branch,weight FROM programs`).all())
  if (TARGET.has(r.race_id)) PG.set(r.race_id + '|' + r.lane, r)

const esc = (s) => { const v = String(s ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }

// ---------- results.csv ----------
{
  const H = ['日付', '場', 'R', '締切', 'グレード', '節', '天候', '風向', '風速', '波高', '決まり手',
    '1着', '2着', '3着', '4着', '5着', '6着',
    '単勝', '複勝', '2連単', '2連複', '拡連複', '3連単', '3連複']
  const rows = [H.join(',')]
  for (const rid of [...TARGET].sort()) {
    const rc = RC.get(rid); if (!rc) continue
    const o = ORD.get(rid) ?? {}
    const p = PAY.get(rid) ?? {}
    rows.push([rc.date, VN[rc.jcd] ?? rc.jcd, rc.race_no, rc.deadline ?? '', rc.grade ?? '',
      esc(rc.series ?? ''), rc.weather ?? '', rc.wind_dir ?? '', rc.wind_speed ?? '', rc.wave ?? '',
      rc.kimarite ?? '', o[1] ?? '', o[2] ?? '', o[3] ?? '', o[4] ?? '', o[5] ?? '', o[6] ?? '',
      esc((p.tansho ?? []).join(' ')), esc((p.fukusho ?? []).join(' ')),
      esc((p.nirentan ?? []).join(' ')), esc((p.nirenpuku ?? []).join(' ')),
      esc((p.kakuren ?? []).join(' ')), esc((p.sanrentan ?? []).join(' ')),
      esc((p.sanrenpuku ?? []).join(' '))].join(','))
  }
  const path = join(ROOT, 'data', 'results.csv')
  writeFileSync(path, rows.join('\n'), 'utf8')
  console.log(`results.csv  ${rows.length - 1}行  ${(Buffer.byteLength(rows.join('\n')) / 1024 / 1024).toFixed(2)} MB`)
}

// ---------- entries.csv ----------
{
  const H = ['日付', '場', 'R', '艇番', '選手名', '登録番号', '級別', '年齢', '支部', '体重',
    '全国勝率', '全国2連率', '当地勝率', '当地2連率', 'モーター番号', 'モーター2連率', 'ボート番号', 'ボート2連率',
    '展示タイム', '進入コース', 'ST', 'ST区分', '着', '着順(数値)', 'レースタイム']
  const rows = [H.join(',')]
  for (const rid of [...TARGET].sort()) {
    const rc = RC.get(rid); if (!rc) continue
    const a = (ENT.get(rid) ?? []).sort((x, y) => x.lane - y.lane)
    for (const e of a) {
      const g = PG.get(rid + '|' + e.lane) ?? {}
      rows.push([rc.date, VN[rc.jcd] ?? rc.jcd, rc.race_no, e.lane, esc(e.racer_name), e.racer_id,
        g.grade ?? '', g.age ?? '', esc(g.branch ?? ''), g.weight ?? '',
        g.win_rate_nat ?? '', g.top2_nat ?? '', g.win_rate_loc ?? '', g.top2_loc ?? '',
        e.motor_no ?? '', g.motor_top2 ?? '', e.boat_no ?? '', g.boat_top2 ?? '',
        e.exhibition ?? '', e.course ?? '', e.st ?? '', e.st_flag ?? '',
        esc(e.rank ?? ''), e.rank_num ?? '', esc(e.race_time ?? '')].join(','))
    }
  }
  const path = join(ROOT, 'data', 'entries.csv')
  writeFileSync(path, rows.join('\n'), 'utf8')
  console.log(`entries.csv  ${rows.length - 1}行  ${(Buffer.byteLength(rows.join('\n')) / 1024 / 1024).toFixed(2)} MB`)
}
db.close()
