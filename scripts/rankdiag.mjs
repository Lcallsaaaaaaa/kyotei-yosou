// 全レースの「予想した着順」と「実際の着順」のズレを、取れる軸すべてで分析する。
//
//   node --max-old-space-size=8192 scripts/rankdiag.mjs
//   node --max-old-space-size=8192 scripts/rankdiag.mjs --csv    CSVも書く
//
// ★これまでとの違い
//   今までは「買った1点が当たったか」だけを見ていた。それだと1日数本しか
//   評価対象にならず、モデルのどこが弱いのかが分からない。
//   ここでは**全レース・全6艇の着順**を予想と突き合わせる。
//   評価対象が数万倍になるので、どの条件で崩れるかが見える。
//
// ★測るもの
//   ・順位一致率（1着だけ／上位2／上位3／完全一致）
//   ・平均順位誤差（予想順位と実着順の差の絶対値の平均）
//   ・順位相関（スピアマン）
//   これを 場／時間帯／レース番号／風／波／天候／グレード／級別構成／
//   モーター／進入の乱れ／決まり手 の軸で割る。
//
// ★予想順位の作り方
//   wk1 の1着確率で6艇を並べる。1位＝最も1着確率が高い艇。
//   （wk3から2着3着の確率も作れるが、まずは素直な並べ方で崩れる場所を探す）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')
const argv = process.argv.slice(2)
const VN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }

// ---------- 予想 ----------
const P = new Map()
for (const r of db.prepare(`SELECT race_id,lane,p FROM wk1`).all()) {
  let a = P.get(r.race_id); if (!a) { a = []; P.set(r.race_id, a) }
  a.push({ lane: r.lane, p: r.p })
}
// ---------- 実際の着順・ST・進入 ----------
const A = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num,course,st,exhibition FROM entries`).all()) {
  let a = A.get(r.race_id); if (!a) { a = []; A.set(r.race_id, a) }
  a.push(r)
}
// ---------- レース条件 ----------
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,date,jcd,race_no,deadline,grade,weather,wind_speed,wave,kimarite FROM races`).all())
  RC.set(r.race_id, r)
// ---------- 番組表（級別・モーター） ----------
const PG = new Map()
for (const r of db.prepare(`SELECT race_id,lane,grade,win_rate_nat,motor_top2 FROM programs`).all())
  PG.set(r.race_id + '|' + r.lane, r)

// ---------- レースごとに評価 ----------
const rows = []
for (const [rid, pred] of P) {
  const act = A.get(rid), rc = RC.get(rid)
  if (!act || act.length !== 6 || !rc) continue
  const rank = new Map()          // lane -> 実着順
  let ok = true
  for (const e of act) {
    if (e.rank_num == null || e.rank_num < 1 || e.rank_num > 6) { ok = false; break }
    rank.set(e.lane, e.rank_num)
  }
  if (!ok || rank.size !== 6) continue
  const order = [...pred].sort((a, b) => b.p - a.p)      // 予想順（1位から）
  const err = order.map((x, i) => Math.abs((i + 1) - rank.get(x.lane)))
  const mae = err.reduce((a, b) => a + b, 0) / 6
  // スピアマン（6艇固定なので簡易式）
  const d2 = order.reduce((a, x, i) => a + ((i + 1) - rank.get(x.lane)) ** 2, 0)
  const rho = 1 - (6 * d2) / (6 * (36 - 1))
  const hit1 = rank.get(order[0].lane) === 1
  const hit2 = hit1 && rank.get(order[1].lane) === 2
  const hit3 = hit2 && rank.get(order[2].lane) === 3
  const full = err.every((e) => e === 0)
  // 進入の乱れ
  const moved = act.filter((e) => e.course != null && e.course !== e.lane).length
  // 級別構成
  const gr = act.map((e) => PG.get(rid + '|' + e.lane)?.grade).filter(Boolean)
  const nA1 = gr.filter((g) => g === 'A1').length
  const [h] = (rc.deadline ?? '').split(':').map(Number)
  rows.push({ rid, date: rc.date, jcd: rc.jcd, rno: rc.race_no, hour: Number.isFinite(h) ? h : null,
    grade: rc.grade ?? '一般', weather: rc.weather ?? '', wind: rc.wind_speed ?? 0, wave: rc.wave ?? 0,
    kimarite: rc.kimarite ?? '', moved, nA1,
    fav: order[0].lane, favP: order[0].p, win: [...rank].find(([, v]) => v === 1)[0],
    mae, rho, hit1, hit2, hit3, full })
}
console.log(`評価できたレース ${rows.length.toLocaleString()}（${rows[0]?.date} 〜 ${rows[rows.length - 1]?.date}）\n`)

const pc = (n, d) => d ? (n / d * 100).toFixed(2) : '-'
function block(title, keyFn, order = null, min = 200) {
  const m = new Map()
  for (const r of rows) {
    const k = keyFn(r); if (k == null) continue
    let a = m.get(k); if (!a) { a = []; m.set(k, a) }
    a.push(r)
  }
  let ks = [...m.keys()].filter((k) => m.get(k).length >= min)
  ks = order ? ks.sort(order) : ks.sort((a, b) => {
    const A2 = m.get(a), B = m.get(b)
    return (A2.reduce((x, r) => x + r.mae, 0) / A2.length) - (B.reduce((x, r) => x + r.mae, 0) / B.length)
  })
  if (!ks.length) return
  console.log(`\n════ ${title} ════`)
  console.log('区分              本数    1着的中  上位2  上位3   完全   順位誤差  順位相関')
  for (const k of ks) {
    const s = m.get(k)
    const mae = s.reduce((a, r) => a + r.mae, 0) / s.length
    const rho = s.reduce((a, r) => a + r.rho, 0) / s.length
    console.log(`${String(k).padEnd(16)} ${String(s.length).padStart(6)} ${pc(s.filter((r) => r.hit1).length, s.length).padStart(8)}% ${pc(s.filter((r) => r.hit2).length, s.length).padStart(6)}% ${pc(s.filter((r) => r.hit3).length, s.length).padStart(6)}% ${pc(s.filter((r) => r.full).length, s.length).padStart(6)}% ${mae.toFixed(3).padStart(9)} ${rho.toFixed(3).padStart(9)}`)
  }
}

// 全体
const all = rows
console.log('════ 全体 ════')
console.log(`  1着的中 ${pc(all.filter((r) => r.hit1).length, all.length)}%`)
console.log(`  上位2着まで一致 ${pc(all.filter((r) => r.hit2).length, all.length)}%`)
console.log(`  上位3着まで一致（＝3連単） ${pc(all.filter((r) => r.hit3).length, all.length)}%`)
console.log(`  6艇すべて一致 ${pc(all.filter((r) => r.full).length, all.length)}%`)
console.log(`  平均順位誤差 ${(all.reduce((a, r) => a + r.mae, 0) / all.length).toFixed(3)}（0なら完璧・1.94がでたらめ）`)
console.log(`  平均順位相関 ${(all.reduce((a, r) => a + r.rho, 0) / all.length).toFixed(3)}（1なら完璧・0がでたらめ）`)

block('場ごと（誤差の小さい順）', (r) => VN[r.jcd] ?? r.jcd)
block('レース番号', (r) => r.rno <= 3 ? '1〜3R' : r.rno <= 6 ? '4〜6R' : r.rno <= 9 ? '7〜9R' : '10〜12R', (a, b) => String(a).localeCompare(String(b)))
block('締切の時間帯', (r) => r.hour == null ? null : r.hour < 12 ? '午前' : r.hour < 15 ? '12〜14時' : r.hour < 18 ? '15〜17時' : r.hour < 21 ? '18〜20時' : '21時以降', (a, b) => String(a).localeCompare(String(b)))
block('風速', (r) => r.wind >= 8 ? '8m以上' : r.wind >= 6 ? '6〜7m' : r.wind >= 4 ? '4〜5m' : r.wind >= 2 ? '2〜3m' : '0〜1m', (a, b) => String(a).localeCompare(String(b)))
block('波高', (r) => r.wave >= 8 ? '8cm以上' : r.wave >= 5 ? '5〜7cm' : r.wave >= 3 ? '3〜4cm' : r.wave >= 1 ? '1〜2cm' : '0cm', (a, b) => String(a).localeCompare(String(b)))
block('天候', (r) => r.weather || null)
block('グレード', (r) => r.grade)
block('A1の人数', (r) => r.nA1 + '人', (a, b) => String(a).localeCompare(String(b)))
block('進入の乱れ（枠と違うコースの艇数）', (r) => r.moved + '艇', (a, b) => String(a).localeCompare(String(b)))
block('決まり手', (r) => r.kimarite || null)
block('モデルの本命艇', (r) => r.fav + '号艇', (a, b) => String(a).localeCompare(String(b)))
block('本命の確率帯', (r) => r.favP >= .8 ? '80%以上' : r.favP >= .65 ? '65〜80%' : r.favP >= .5 ? '50〜65%' : r.favP >= .35 ? '35〜50%' : '35%未満', (a, b) => String(a).localeCompare(String(b)))

if (argv.includes('--csv')) {
  const H = ['race_id', 'date', '場', 'R', '時', 'グレード', '天候', '風速', '波高', '決まり手',
    '進入が動いた艇数', 'A1の人数', '予想1位', '予想1位の確率', '実際の1着',
    '1着的中', '上位2一致', '上位3一致', '完全一致', '順位誤差', '順位相関']
  const out = [H.join(',')]
  for (const r of rows)
    out.push([r.rid, r.date, VN[r.jcd] ?? r.jcd, r.rno, r.hour ?? '', r.grade, r.weather, r.wind, r.wave,
      r.kimarite, r.moved, r.nA1, r.fav, (r.favP * 100).toFixed(1), r.win,
      r.hit1 ? 1 : 0, r.hit2 ? 1 : 0, r.hit3 ? 1 : 0, r.full ? 1 : 0, r.mae.toFixed(3), r.rho.toFixed(3)].join(','))
  const p = join(ROOT, 'data', 'rankdiag.csv')
  writeFileSync(p, out.join('\n'), 'utf8')
  console.log(`\n→ ${p}（${rows.length.toLocaleString()}行）`)
}
db.close()
