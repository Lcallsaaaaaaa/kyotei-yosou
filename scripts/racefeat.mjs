// レース単位の特徴量を作る（feat は艇単位しか持っていない）。
//
//   node --max-old-space-size=8192 scripts/racefeat.mjs
//
// ★なぜ要るか（rankdiag.mjs の診断）
//   モデルが崩れるのは全部「レースの性質」であって、艇の性質ではなかった。
//     ・進入が5艇動くと1着的中 59.1% → 39.8%
//     ・まくり決着は 17.1%、まくり差しは 9.3% しか当たらない（逃げは91.0%）
//     ・戸田・江戸川・平和島で48%、福岡・徳山で62〜63%（15pt差）
//     ・A1が6人だと順位相関 0.463（最悪）
//   ところが feat は艇1つずつの成績しか持っておらず、
//   「このレースは荒れるか」「この艇はこのメンバーの中で相対的に強いか」を
//   モデルに渡していない。そこを作る。
//
// ★時点を守る
//   場ごとの傾向（1コース勝率・まくり決着率）は**そのレースより前**の
//   実績だけで計算する。全期間を集計して割り当てると未来が混ざる。
//
// ★出す特徴量
//   相対（レース内での位置）… rel_*, rank_*
//   レース全体の性質      … rc_*
//   場の性質（時点つき）  … vn_*
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')

const COLS = [
  // レース内での相対位置（このメンバーの中で強いか）
  'rel_all_p1', 'rank_all_p1', 'rel_wr', 'rank_wr', 'rel_motor', 'rank_motor',
  'rel_course_p1', 'rank_course_p1', 'rel_r10', 'gap_top1',
  // レース全体の性質（6艇で同じ値）
  'rc_a1', 'rc_wr_std', 'rc_wr_range', 'rc_lane1_edge',
  'rc_entry_risk', 'rc_wakunari_min', 'rc_out_strong', 'rc_jiko_max',
  // 場の性質（そのレースより前の実績だけ）
  'vn_lane1_p1', 'vn_nige', 'vn_makuri', 'vn_moved',
  // ★場×時間帯（1時間区切り）。本人から繰り返し指摘されていたのに入れていなかった。
  //   実測（kimarite.mjs・22万レース）で逃げ率が
  //     8時台70.2% → 11時台41.3% → 20時台68.6% と29pt動く。
  //   同じ場でも時間帯で水面の性質が変わる（風・潮・照り返し）。
  //   vn_* は場だけの平均なので、この差を吸収できていなかった。
  'vh_lane1_p1', 'vh_nige', 'vh_makuri', 'vh_n',
  // ★直前情報（締切前に確実に見られる）
  //   展示タイムは entries.exhibition に全222,671レースぶんある。
  //   ところがモデルに渡していたのは「その選手の過去の展示タイム平均(all_ex)」だけで、
  //   **今回のレースの展示タイムを一度も渡していなかった**。
  //   当節の機力はここに出るので、過去平均では代わりにならない。
  //   チルトは2025年8月以降のみ（それ以前は取得していない → 0埋め）。
  'ex_now', 'ex_rel', 'ex_rank', 'ex_gap_best', 'ex_vs_own', 'tilt_now',
  // ★スタート展示（進入コースと展示ST）。締切前に公式ページで見られる。
  //   実測67,986レース: 展示の進入は本番の進入と6艇すべて一致が87.97%（枠なり前提は81.18%）。
  //   前づけがあったレース12,795本のうち49.21%は展示どおりに動いた（枠なり前提だと0%）。
  //   進入を別モデルで当てにいくより、展示を見るほうが確実。
  'exc_now', 'exc_moved', 'exc_in', 'exc_race_moved',
  'exst_now', 'exst_rel', 'exst_rank',
  // ★気温・水温・調整重量・部品交換（すべて締切前）
  //   気温と水温の差は水面の重さに効く（水温が低いと出足が鈍る）。
  //   調整重量は体重が軽い選手が積む重り。積むほど不利になりやすい。
  //   部品交換は当節にどこをいじったかで、番組表のモーター2連率では見えない情報。
  'air_temp', 'water_temp', 'temp_diff',
  'adj_now', 'adj_rel', 'parts_self', 'parts_race',
  // ★選手の身長（racer_period にあるのに一度も使っていなかった）
  //   競艇は体重制限があるが身長の制限はない。背が高いほど風の抵抗を受け、
  //   低いほど姿勢を低く保てるとされる。効くかどうかは測って決める。
  'height_now', 'height_rel',
]
db.exec(`DROP TABLE IF EXISTS rfeat`)
db.exec(`CREATE TABLE rfeat (race_id TEXT NOT NULL, lane INTEGER NOT NULL,
  ${COLS.map((c) => `"${c}" REAL`).join(',')}, PRIMARY KEY (race_id, lane))`)

// ---------- 素材 ----------
const F = new Map()
for (const r of db.prepare(`SELECT race_id,lane,all_p1,course1_p1,motor_p2,r10_p1,
    wakunari_rate,entry_ave,jiko_ritsu,all_ex,racer_id FROM feat`).all()) {
  let a = F.get(r.race_id); if (!a) { a = []; F.set(r.race_id, a) }
  a.push(r)
}
// 今回の展示タイムとチルト（どちらも締切前に出る）
const EX = new Map()
for (const r of db.prepare(`SELECT race_id,lane,exhibition FROM entries WHERE exhibition IS NOT NULL`).all())
  EX.set(r.race_id + '|' + r.lane, r.exhibition)
const EXC = new Map()   // 展示の進入コース
const EXS = new Map()   // 展示のST
for (const r of db.prepare('SELECT race_id,lane,ex_course,ex_st FROM before_info').all()) {
  if (r.ex_course != null) EXC.set(r.race_id + '|' + r.lane, r.ex_course)
  if (r.ex_st != null) EXS.set(r.race_id + '|' + r.lane, r.ex_st)
}
const TILT = new Map()
for (const r of db.prepare(`SELECT race_id,lane,tilt FROM before_info WHERE tilt IS NOT NULL`).all())
  TILT.set(r.race_id + '|' + r.lane, r.tilt)
console.log(`展示タイム ${EX.size.toLocaleString()}行 / チルト ${TILT.size.toLocaleString()}行`)

const ADJ = new Map()   // 調整重量
const PRT = new Map()   // 部品交換（交換があった艇だけ値が入る）
for (const r of db.prepare('SELECT race_id,lane,adj_weight,parts FROM before_info').all()) {
  if (r.adj_weight != null) ADJ.set(r.race_id + '|' + r.lane, r.adj_weight)
  if (r.parts != null && String(r.parts).trim()) PRT.set(r.race_id + '|' + r.lane, 1)
}
// 選手の身長（その日より前で一番新しい期の値を使う）
const HT = new Map()
{
  const rows = db.prepare('SELECT period, racer_id, height FROM racer_period WHERE height > 0 ORDER BY racer_id, period').all()
  for (const r of rows) {
    let a = HT.get(r.racer_id); if (!a) { a = []; HT.set(r.racer_id, a) }
    a.push({ p: r.period, h: r.height })
  }
  console.log('身長 ' + HT.size.toLocaleString() + '選手')
}
const heightOf = (rid, ym) => {
  const a = HT.get(rid); if (!a) return null
  let best = null
  for (const x of a) { if (x.p <= ym) best = x.h; else break }
  return best ?? a[0].h
}

const TMP = new Map()   // 気温・水温
for (const r of db.prepare('SELECT race_id,air_temp,water_temp FROM before_race').all())
  TMP.set(r.race_id, r)
console.log('調整重量 ' + ADJ.size.toLocaleString() + '行 / 部品交換 ' + PRT.size.toLocaleString() + '行 / 気温水温 ' + TMP.size.toLocaleString() + 'レース')

const PG = new Map()
for (const r of db.prepare(`SELECT race_id,lane,grade,win_rate_nat FROM programs`).all())
  PG.set(r.race_id + '|' + r.lane, r)
const RC = []
for (const r of db.prepare(`SELECT race_id,date,jcd,deadline,kimarite FROM races ORDER BY date, deadline, race_id`).all())
  RC.push(r)
const WIN = new Map()
const MOVED = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num,course FROM entries`).all()) {
  if (r.rank_num === 1) WIN.set(r.race_id, r.lane)
  if (r.course != null && r.course !== r.lane) MOVED.set(r.race_id, (MOVED.get(r.race_id) ?? 0) + 1)
}
console.log(`feat ${F.size.toLocaleString()}レース / races ${RC.length.toLocaleString()}`)

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }
const rankOf = (v, arr) => arr.filter((x) => x > v).length + 1   // 大きいほど1位

// ---------- 場ごとの累積（時点を守る） ----------
const V = new Map()   // jcd -> {n, lane1, nige, makuri, moved}
const VH = new Map()  // jcd:hour -> 同じ（場×時間帯）
const hourOf = (dl) => { const m = String(dl ?? '').match(/^([0-9]{1,2}):/); return m ? Number(m[1]) : -1 }
const vnow = (j) => {
  const a = V.get(j)
  if (!a || a.n < 200) return { p1: 0.55, nige: 0.5, makuri: 0.15, moved: 0.2 }
  return { p1: a.lane1 / a.n, nige: a.nige / a.n, makuri: a.makuri / a.n, moved: a.moved / a.n }
}
// ★場×時間帯。件数が少ないうちは場だけの値に寄せる（いきなり細かく割ると荒れる）
const vhnow = (j, h) => {
  const base = vnow(j)
  const a = VH.get(j + ':' + h)
  if (!a || a.n < 100) return { p1: base.p1, nige: base.nige, makuri: base.makuri, n: a ? a.n : 0 }
  // 100件で半分、400件でほぼ場×時間帯の値になるように混ぜる
  const w = a.n / (a.n + 100)
  return {
    p1: w * (a.lane1 / a.n) + (1 - w) * base.p1,
    nige: w * (a.nige / a.n) + (1 - w) * base.nige,
    makuri: w * (a.makuri / a.n) + (1 - w) * base.makuri,
    n: a.n,
  }
}

const ins = db.prepare(`INSERT OR REPLACE INTO rfeat VALUES (?,?,${COLS.map(() => '?').join(',')})`)
let n = 0
db.exec('BEGIN')
for (const rc of RC) {
  const f = F.get(rc.race_id)
  const v = vnow(rc.jcd)
  const vh = vhnow(rc.jcd, hourOf(rc.deadline))
  if (f && f.length === 6) {
    const wr = f.map((x) => PG.get(rc.race_id + '|' + x.lane)?.win_rate_nat ?? 0)
    const gr = f.map((x) => PG.get(rc.race_id + '|' + x.lane)?.grade ?? '')
    const ap = f.map((x) => x.all_p1 ?? 0)
    const mo = f.map((x) => x.motor_p2 ?? 0)
    const cp = f.map((x) => x.course1_p1 ?? 0)
    const r10 = f.map((x) => x.r10_p1 ?? 0)
    const wk = f.map((x) => x.wakunari_rate ?? 1)
    const ea = f.map((x, i) => Math.abs((x.entry_ave ?? f[i].lane) - f[i].lane))
    const jk = f.map((x) => x.jiko_ritsu ?? 0)
    const mAp = mean(ap), mWr = mean(wr), mMo = mean(mo), mCp = mean(cp), mR10 = mean(r10)
    const top = Math.max(...ap)
    // レース全体
    const rc_a1 = gr.filter((g) => g === 'A1').length
    const rc_wr_std = std(wr)
    const rc_wr_range = Math.max(...wr) - Math.min(...wr)
    const l1 = f.findIndex((x) => x.lane === 1)
    const rc_lane1_edge = l1 >= 0 ? wr[l1] - mean(wr.filter((_, i) => i !== l1)) : 0
    // 前づけの危険度＝外枠(3〜6)で枠なり率が低い艇の度合い
    let risk = 0, wkmin = 1
    for (let i = 0; i < 6; i++) {
      if (f[i].lane >= 3) { risk += (1 - wk[i]) * (f[i].lane - 2); if (wk[i] < wkmin) wkmin = wk[i] }
    }
    // 外枠が相対的に強いか（4〜6号艇の平均勝率 − 1〜3号艇の平均勝率）
    const outI = f.map((x, i) => [x.lane, i]).filter(([l]) => l >= 4).map(([, i]) => i)
    const inI = f.map((x, i) => [x.lane, i]).filter(([l]) => l <= 3).map(([, i]) => i)
    const rc_out_strong = outI.length && inI.length
      ? mean(outI.map((i) => wr[i])) - mean(inI.map((i) => wr[i])) : 0
    // 今回の展示タイム。小さいほど速い＝強いので、順位も「小さいほど1位」で数える。
    const exv = f.map((x) => EX.get(rc.race_id + '|' + x.lane) ?? null)
    const exOk = exv.filter((v) => v != null && v > 0)
    const mEx = exOk.length ? mean(exOk) : 0
    const bEx = exOk.length ? Math.min(...exOk) : 0
    const exRank = (v) => v == null ? 0 : exv.filter((o) => o != null && o < v).length + 1
    const ownEx = f.map((x) => x.all_ex ?? null)
    // スタート展示
    const exc = f.map((x) => EXC.get(rc.race_id + '|' + x.lane) ?? null)
    const excMoved = exc.reduce((a, c, i) => a + (c != null && c !== f[i].lane ? 1 : 0), 0)
    const exs = f.map((x) => EXS.get(rc.race_id + '|' + x.lane) ?? null)
    const exsOk = exs.filter((v) => v != null)
    const mSt = exsOk.length ? mean(exsOk) : 0
    const stRank = (v) => v == null ? 0 : exs.filter((o) => o != null && o < v).length + 1
    // 気温・水温・調整重量・部品交換
    const tp = TMP.get(rc.race_id)
    const air = tp?.air_temp ?? 0, wat = tp?.water_temp ?? 0
    const adj = f.map((x) => ADJ.get(rc.race_id + '|' + x.lane) ?? null)
    const adjOk = adj.filter((v) => v != null)
    const mAdj = adjOk.length ? mean(adjOk) : 0
    const prt = f.map((x) => PRT.get(rc.race_id + '|' + x.lane) ?? 0)
    const prtN = prt.reduce((a, b) => a + b, 0)
    // 身長（その日より前で一番新しい期の値）
    const ym = rc.date.slice(0, 7)
    const ht = f.map((x) => heightOf(x.racer_id, ym))
    const htOk = ht.filter((v) => v != null && v > 0)
    const mHt = htOk.length ? mean(htOk) : 0
    for (let i = 0; i < 6; i++) {
      ins.run(rc.race_id, f[i].lane,
        ap[i] - mAp, rankOf(ap[i], ap), wr[i] - mWr, rankOf(wr[i], wr),
        mo[i] - mMo, rankOf(mo[i], mo), cp[i] - mCp, rankOf(cp[i], cp),
        r10[i] - mR10, top - ap[i],
        rc_a1, rc_wr_std, rc_wr_range, rc_lane1_edge,
        risk, wkmin, rc_out_strong, Math.max(...jk),
        v.p1, v.nige, v.makuri, v.moved,
        vh.p1, vh.nige, vh.makuri, vh.n,
        exv[i] ?? 0,
        exv[i] != null && mEx ? exv[i] - mEx : 0,
        exRank(exv[i]),
        exv[i] != null && bEx ? exv[i] - bEx : 0,
        exv[i] != null && ownEx[i] != null && ownEx[i] > 0 ? exv[i] - ownEx[i] : 0,
        TILT.get(rc.race_id + '|' + f[i].lane) ?? 0,
        exc[i] ?? f[i].lane,
        exc[i] != null ? exc[i] - f[i].lane : 0,
        exc[i] != null && exc[i] < f[i].lane ? 1 : 0,
        excMoved,
        exs[i] ?? 0,
        exs[i] != null && mSt ? exs[i] - mSt : 0,
        stRank(exs[i]),
        air, wat, (tp && tp.air_temp != null && tp.water_temp != null) ? wat - air : 0,
        adj[i] ?? 0, adj[i] != null ? adj[i] - mAdj : 0, prt[i], prtN,
        ht[i] ?? 0, ht[i] != null && mHt ? ht[i] - mHt : 0)
    }
    n++
    if (n % 20000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); console.log(`  ${n.toLocaleString()} レース`) }
  }
  // ★このレースの結果を数えるのは特徴量を書いた後（時点を守る）
  const won1 = WIN.get(rc.race_id) === 1
  const isNige = rc.kimarite === '逃げ'
  const isMak = rc.kimarite === 'まくり' || rc.kimarite === 'まくり差し'
  const a = V.get(rc.jcd) ?? { n: 0, lane1: 0, nige: 0, makuri: 0, moved: 0 }
  a.n++; if (won1) a.lane1++; if (isNige) a.nige++; if (isMak) a.makuri++
  if ((MOVED.get(rc.race_id) ?? 0) > 0) a.moved++
  V.set(rc.jcd, a)
  const hk = rc.jcd + ':' + hourOf(rc.deadline)
  const b = VH.get(hk) ?? { n: 0, lane1: 0, nige: 0, makuri: 0 }
  b.n++; if (won1) b.lane1++; if (isNige) b.nige++; if (isMak) b.makuri++
  VH.set(hk, b)
}
db.exec('COMMIT')
console.log(`\nrfeat ${n.toLocaleString()}レース × ${COLS.length}項目`)

// 自己点検
console.log('\n=== 自己点検（値が動いているか）===')
for (const c of ['rc_entry_risk', 'vn_lane1_p1', 'vh_lane1_p1', 'vh_nige', 'vh_n', 'ex_now', 'ex_rel', 'ex_rank', 'ex_gap_best', 'ex_vs_own', 'tilt_now', 'exc_now', 'exc_moved', 'exc_race_moved', 'exst_now', 'exst_rank', 'air_temp', 'water_temp', 'temp_diff', 'adj_now', 'parts_race', 'height_now', 'height_rel']) {
  const r = db.prepare(`SELECT MIN("${c}") a, AVG("${c}") b, MAX("${c}") c FROM rfeat`).get()
  console.log(`  ${c.padEnd(16)} 最小${Number(r.a).toFixed(3).padStart(8)} 平均${Number(r.b).toFixed(3).padStart(8)} 最大${Number(r.c).toFixed(3).padStart(8)}`)
}
db.close()
