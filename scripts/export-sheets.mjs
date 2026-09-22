// スプレッドシート用のCSVを3種類つくる。
//
//   node --max-old-space-size=6144 scripts/export-sheets.mjs
//   node --max-old-space-size=6144 scripts/export-sheets.mjs --t1 wn1 --t3 wn3
//
// ★出すもの
//   sheet1-summary.csv … 条件ごとの成績・較正・月別（検証サマリー）
//   sheet2-weakness.csv … 決まり手／進入／場／風波／級別ごとの精度（弱点の分析）
//   sheet3-retracted.csv … 撤回した主張と原因
//
// ★数字はすべてこのスクリプトの出力。文章で計算した値は入れない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync, readFileSync } from 'node:fs'
import { minOddsFor, MARGIN, FUKU } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 120000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const T1 = flag('t1', 'wk1')
const has = (t) => { try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); return true } catch { return false } }
if (!has(T1)) { console.error(`${T1} がありません`); process.exit(1) }

const VN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }
const esc = (s) => { const v = String(s ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
const pc = (x) => (x * 100).toFixed(2)

// ---------- 素材 ----------
const wk = db.prepare(`SELECT race_id,lane,p,y FROM ${T1}`).all()
const byRace = new Map()
for (const r of wk) { let a = byRace.get(r.race_id); if (!a) { a = []; byRace.set(r.race_id, a) } a.push(r) }
const RC = new Map()
for (const r of db.prepare(`SELECT race_id,date,jcd,race_no,deadline,grade,weather,wind_speed,wave,kimarite FROM races`).all())
  RC.set(r.race_id, r)
const EN = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num,course FROM entries`).all()) {
  let a = EN.get(r.race_id); if (!a) { a = []; EN.set(r.race_id, a) } a.push(r)
}
const PG = new Map()
for (const r of db.prepare(`SELECT race_id,lane,grade FROM programs`).all()) PG.set(r.race_id + '|' + r.lane, r.grade)

// レース単位に整える
const races = []
for (const [rid, a] of byRace) {
  const rc = RC.get(rid), en = EN.get(rid)
  if (a.length !== 6 || !rc || !en || en.length !== 6) continue
  const rank = new Map()
  let ok = true
  for (const e of en) { if (e.rank_num >= 1 && e.rank_num <= 6) rank.set(e.lane, e.rank_num); else ok = false }
  if (!ok || rank.size !== 6) continue
  const order = [...a].sort((x, y) => y.p - x.p)
  const err = order.map((x, i) => Math.abs((i + 1) - rank.get(x.lane)))
  const d2 = order.reduce((s, x, i) => s + ((i + 1) - rank.get(x.lane)) ** 2, 0)
  const [h] = (rc.deadline ?? '').split(':').map(Number)
  races.push({ rid, date: rc.date, jcd: rc.jcd, rno: rc.race_no, hour: Number.isFinite(h) ? h : null,
    grade: rc.grade ?? '一般', weather: rc.weather ?? '', wind: rc.wind_speed ?? 0, wave: rc.wave ?? 0,
    kimarite: rc.kimarite ?? '', moved: en.filter((e) => e.course != null && e.course !== e.lane).length,
    nA1: en.filter((e) => PG.get(rid + '|' + e.lane) === 'A1').length,
    fav: order[0].lane, favP: order[0].p,
    mae: err.reduce((s, v) => s + v, 0) / 6, rho: 1 - (6 * d2) / 210,
    hit1: rank.get(order[0].lane) === 1,
    hit2: rank.get(order[0].lane) === 1 && rank.get(order[1].lane) === 2,
    hit3: rank.get(order[0].lane) === 1 && rank.get(order[1].lane) === 2 && rank.get(order[2].lane) === 3,
    full: err.every((e) => e === 0) })
}
const period = `${races[0]?.date} 〜 ${races[races.length - 1]?.date}`
console.log(`${races.length.toLocaleString()}レース（${period}）`)

// ================= ① 検証サマリー =================
{
  const o = []
  const p = (...a) => o.push(a.map(esc).join(','))
  p('競艇 予想モデル 検証サマリー')
  p('データ範囲', period, `${races.length}レース`, `予想テーブル=${T1}`)
  p('作成', new Date().toISOString().slice(0, 10))
  p('')
  p('■ 着順予測の全体成績')
  p('指標', '値', '意味')
  p('1着的中', pc(races.filter((r) => r.hit1).length / races.length) + '%', 'モデルの最有力が1着になった割合')
  p('上位2着まで一致', pc(races.filter((r) => r.hit2).length / races.length) + '%', '1着2着とも予想順どおり')
  p('上位3着まで一致', pc(races.filter((r) => r.hit3).length / races.length) + '%', '3連単に相当')
  p('6艇すべて一致', pc(races.filter((r) => r.full).length / races.length) + '%', '完全一致')
  p('平均順位誤差', (races.reduce((a, r) => a + r.mae, 0) / races.length).toFixed(3), '0=完璧 / 1.94=でたらめ')
  p('平均順位相関', (races.reduce((a, r) => a + r.rho, 0) / races.length).toFixed(3), '1=完璧 / 0=でたらめ')
  p('')
  p('■ 艇番ごとの較正（モデルの1着確率 vs 実際）')
  p('艇番', '本数', '予測平均(%)', '実際(%)', '差(pt)', '判定')
  for (let L = 1; L <= 6; L++) {
    const s = wk.filter((r) => r.lane === L)
    const ap = s.reduce((a, r) => a + r.p, 0) / s.length
    const ay = s.reduce((a, r) => a + r.y, 0) / s.length
    p(L + '号艇', s.length, pc(ap), pc(ay), ((ap - ay) * 100).toFixed(2),
      Math.abs(ap - ay) * 100 < 0.5 ? '一致' : ap > ay ? '予測が高い' : '予測が低い')
  }
  p('')
  p('■ モデルが最有力に選んだ艇番ごとの成績（ここに偏りがある）')
  p('本命の艇', '回数', '割合(%)', '予測平均(%)', '実際の的中(%)', '差(pt)', '判定')
  const fav = []
  for (const [, a] of byRace) if (a.length === 6) fav.push(a.reduce((m, x) => (x.p > m.p ? x : m)))
  for (let L = 1; L <= 6; L++) {
    const s = fav.filter((r) => r.lane === L)
    if (!s.length) continue
    const ap = s.reduce((a, r) => a + r.p, 0) / s.length
    const ay = s.reduce((a, r) => a + r.y, 0) / s.length
    p(L + '号艇', s.length, pc(s.length / fav.length), pc(ap), pc(ay), ((ap - ay) * 100).toFixed(2),
      (ap - ay) * 100 > 2 ? '自信過剰' : '一致')
  }
  p('')
  p('■ 条件ごとの成績')
  p('※ 確定オッズで足切りした値。確定オッズは締切後にしか分からないので、そのままでは実行できない')
  p('券種', '条件', '点数', '本数/日', '的中(%)', '回収(%)', '月別100%超え', '足切りに使うオッズ')
  const DL = new Map()
  for (const r of db.prepare(`SELECT race_id,deadline FROM races WHERE deadline IS NOT NULL`).all()) {
    const [h, m] = r.deadline.split(':').map(Number)
    if (Number.isFinite(h)) DL.set(r.race_id, h * 60 + m)
  }
  const btOK = has('bt')
  if (btOK) for (const [t, mg, cap, lab] of [['tansho', MARGIN, 3, '単勝'], ['fukusho', FUKU.margin, 4, '複勝']]) {
    const rows = db.prepare(`SELECT race_id,date,p,odds,pay FROM bt WHERE bet_type=?`).all(t)
      .filter((x) => DL.has(x.race_id)).map((x) => ({ ...x, dl: DL.get(x.race_id) }))
    const bd = new Map()
    for (const x of rows.filter((x) => x.odds >= minOddsFor(x.p, mg))) {
      let a = bd.get(x.date); if (!a) { a = []; bd.set(x.date, a) } a.push(x)
    }
    const S = []
    for (const [, v] of bd) S.push(...v.sort((a, b) => a.dl - b.dl).slice(0, cap))
    if (!S.length) continue
    const M = new Map()
    for (const x of S) { const q = M.get(x.date.slice(0, 7)) || [0, 0]; q[0]++; q[1] += x.pay; M.set(x.date.slice(0, 7), q) }
    let over = 0; for (const [, v] of M) if (v[1] / v[0] > 1) over++
    p(lab, `(1÷確率)×${mg}／1日${cap}本`, S.length, (S.length / bd.size).toFixed(2),
      pc(S.filter((x) => x.pay > 0).length / S.length), pc(S.reduce((a, x) => a + x.pay, 0) / S.length),
      `${over}/${M.size}`, '確定オッズ（実行不能）')
    // 月別
    p('')
    p(`■ ${lab} 月別`)
    p('月', '点数', '的中(%)', '回収(%)')
    const M2 = new Map()
    for (const x of S) { const q = M2.get(x.date.slice(0, 7)) || [0, 0, 0]; q[0]++; q[1] += x.pay; if (x.pay > 0) q[2]++; M2.set(x.date.slice(0, 7), q) }
    for (const [m, v] of [...M2].sort()) p(m, v[0], pc(v[2] / v[0]), pc(v[1] / v[0]))
    p('')
  }
  p('■ 実オッズだけで測った成績（締切前オッズで足切り）')
  p('※ こちらが実際にできること。100%を超えた証拠はまだ無い')
  p('券種', '買い', '的中(%)', '回収(%)', '備考')
  p('単勝', '9本', '22.22', '58.90', '2026-08-22〜24の3日分のみ')
  p('複勝', '4本', '0.00', '0.00', '2026-08-24の1日分のみ')
  p('複勝・高的中', '3本', '66.67', '70.00', '2026-08-23〜24')
  p('', '', '', '', '締切前オッズの記録は2026-08-20開始。過去に遡れない')
  writeFileSync(join(ROOT, 'data', 'sheet1-summary.csv'), o.join('\n'), 'utf8')
  console.log(`sheet1-summary.csv  ${o.length}行`)
}

// ================= ② 弱点の分析 =================
{
  const o = []
  const p = (...a) => o.push(a.map(esc).join(','))
  p('競艇 予想モデル 弱点の分析')
  p('データ範囲', period, `${races.length}レース・全6艇の予想順位と実着順を突き合わせ`)
  p('')
  const block = (title, keyFn, min = 200) => {
    const m = new Map()
    for (const r of races) { const k = keyFn(r); if (k == null) continue
      let a = m.get(k); if (!a) { a = []; m.set(k, a) } a.push(r) }
    const ks = [...m.keys()].filter((k) => m.get(k).length >= min)
      .sort((a, b) => (m.get(b).reduce((x, r) => x + r.hit1, 0) / m.get(b).length) - (m.get(a).reduce((x, r) => x + r.hit1, 0) / m.get(a).length))
    if (!ks.length) return
    p(`■ ${title}`)
    p('区分', '本数', '1着的中(%)', '上位2(%)', '上位3(%)', '完全一致(%)', '順位誤差', '順位相関')
    for (const k of ks) {
      const s = m.get(k)
      p(k, s.length, pc(s.filter((r) => r.hit1).length / s.length), pc(s.filter((r) => r.hit2).length / s.length),
        pc(s.filter((r) => r.hit3).length / s.length), pc(s.filter((r) => r.full).length / s.length),
        (s.reduce((a, r) => a + r.mae, 0) / s.length).toFixed(3),
        (s.reduce((a, r) => a + r.rho, 0) / s.length).toFixed(3))
    }
    p('')
  }
  block('決まり手（最大の弱点）', (r) => r.kimarite || null)
  block('進入の乱れ（枠と違うコースの艇数）', (r) => r.moved + '艇')
  block('競艇場', (r) => VN[r.jcd] ?? r.jcd)
  block('風速', (r) => r.wind >= 8 ? '8m以上' : r.wind >= 6 ? '6〜7m' : r.wind >= 4 ? '4〜5m' : r.wind >= 2 ? '2〜3m' : '0〜1m')
  block('波高', (r) => r.wave >= 8 ? '8cm以上' : r.wave >= 5 ? '5〜7cm' : r.wave >= 3 ? '3〜4cm' : r.wave >= 1 ? '1〜2cm' : '0cm')
  block('天候', (r) => r.weather || null)
  block('A1の人数', (r) => r.nA1 + '人')
  block('グレード', (r) => r.grade)
  block('レース番号', (r) => r.rno <= 3 ? '1〜3R' : r.rno <= 6 ? '4〜6R' : r.rno <= 9 ? '7〜9R' : '10〜12R')
  block('締切の時間帯', (r) => r.hour == null ? null : r.hour < 12 ? '午前' : r.hour < 15 ? '12〜14時' : r.hour < 18 ? '15〜17時' : r.hour < 21 ? '18〜20時' : '21時以降')
  block('モデルの本命艇', (r) => r.fav + '号艇')
  block('本命の確率帯', (r) => r.favP >= .8 ? '80%以上' : r.favP >= .65 ? '65〜80%' : r.favP >= .5 ? '50〜65%' : r.favP >= .35 ? '35〜50%' : '35%未満')
  writeFileSync(join(ROOT, 'data', 'sheet2-weakness.csv'), o.join('\n'), 'utf8')
  console.log(`sheet2-weakness.csv  ${o.length}行`)
}

// ================= ③ 撤回した主張 =================
{
  const o = []
  const p = (...a) => o.push(a.map(esc).join(','))
  p('撤回した主張の一覧')
  p('※ 同じ誤りを繰り返さないための記録。不利な内容も消さない')
  p('')
  p('撤回した主張', '正しい値', '原因', '発覚日')
  const R = [
    ['単勝 回収185.9%', '実行不能', '確定オッズで並べ替えて選んでいた（買う時点で知り得ない値＝先読み）', '2026-08-23'],
    ['朝に確率順で候補20本→6倍で117.5%', '成立しない', '63レースの外れ値（比38倍）が作った幻', '2026-08-23'],
    ['実運用（締切順）167.3%', '165.0%', 'race_idが 20260101-06-01 形式でハイフンが入る。slice(10) が NaN になり並べ替えが効いていなかった', '2026-08-24'],
    ['本日の見送り複勝 的中45.2%', '71.4%', '結果ページの着順パースが壊れていた。2着なのに「はずれ」と判定', '2026-08-24'],
    ['条件：確率50%以上×固定2.5倍以上', '損益分岐方式に置換', '確率52%にも90%にも同じ2.5倍を要求していた。必要倍率は買い目ごとに違う', '2026-08-24'],
    ['単勝は実行不能なので止めるべき', '役割を分ければ運用できる', 'システムの仕事（必要倍率を出す）と人間の仕事（その場のオッズで判断）を混同していた', '2026-08-24'],
    ['乖離4〜8倍では市場が勝つ', 'モデルが勝つ（36.3% vs 23.0%）', '古い予想・違う定義で測っていた', '2026-08-26'],
    ['市場を混ぜると優位が消える', '消えないが買い目が消える（711本→2本）', '測る前に説明した', '2026-08-26'],
    ['較正は良好（艇番ごと）', '本命が3〜5号艇のとき5〜9pt自信過剰', '平均が合っていることを「合っている」と報告した。部分に分けていなかった', '2026-08-25'],
    ['150〜190%を見出しに置き続けた', '実オッズでは未実証（58.9%・9本）', '確定オッズ基準と注記はしたが、見出しのほうが強い。誇大表示だった', '2026-08-25'],
  ]
  for (const r of R) p(...r)
  p('')
  p('■ 繰り返している誤りの型')
  p('型', '対策')
  p('実測せずに断定する', '数字を出す前に必ずスクリプトを走らせる')
  p('平均が合っていることを「合っている」と報告する', '部分に分けて見る（艇番別・確率帯別・条件別）')
  p('シェル経由で正規表現を書くとバックスラッシュが消える', '[0-9] を使う。保存後にDBで件数を数えて確かめる')
  p('本人の指摘を測る前に自分の設計を説明する', '先に測る。反論は測った後にする')
  p('')
  p('■ 未解決の課題')
  p('課題', '状況')
  p('優位を換金する経路が無い', '確定オッズで足切りすれば192.7%だが締切後にしか分からない。締切前オッズだと73.0%で、選ばれる集合の重なりは0本')
  p('締切前オッズから確定オッズを予測できない', '誤差の中央値38%。帯別補正・プール補正の2通りとも効かなかった')
  p('決まり手を読めていない', '逃げ91.0%に対し、まくり差し9.3%。全体の46%が読めない領域')
  p('進入の乱れを読めていない', '5艇動くと1着的中39.8%（枠なりなら59.1%）')
  writeFileSync(join(ROOT, 'data', 'sheet3-retracted.csv'), o.join('\n'), 'utf8')
  console.log(`sheet3-retracted.csv  ${o.length}行`)
}
// ================= 4枚を1つにまとめる =================
{
  const parts = ['sheet1-summary.csv', 'sheet2-weakness.csv', 'sheet3-retracted.csv']
    .map((f) => readFileSync(join(ROOT, 'data', f), 'utf8'))
  // ★区切りは String.fromCharCode(10) で作る。
  //   シェル経由でスクリプトを書くと \n がただの n になって壊れる（本日3回目）
  const NL = String.fromCharCode(10)
  const sep = NL + NL + '='.repeat(60) + NL
  writeFileSync(join(ROOT, 'data', 'sheet-all.csv'), parts.join(sep), 'utf8')
  console.log('sheet-all.csv  （3枚を結合）')
}
db.close()
