// 展示のアラート4種が、本当に効いているかを測る。
//
//   node --max-old-space-size=4096 scripts/alert-test.mjs
//
// ★作り方（守らないと必ず良く見える）
//   ① 前半のデータだけを見る
//   ② 後半で、同じ条件をそのまま当てて確かめる
//   風向き（kaze-roi.mjs）でも期待値順（ev-test.mjs）でも、
//   後から探して当てはめた数字は3分割で全部消えた。
//
// ★⚠ 比べる相手を間違えると、全部まやかしになる（2026-10-05に実際にやった）
//   最初の版は「前づけした艇（多くは外枠）」を「2号艇」と比べ、
//   「チルトを上げた艇（多くは外枠）」を「1号艇」と比べていた。
//   外枠は元から3着内率が低いので、**アラートのせいに見えるが枠のせい**。
//   → **枠（または進入コース）を揃えて比べる**。枠ごとに「出た艇」と
//      「出なかった艇」の割合を出し、出た艇の枠の構成で重みづけて1つにまとめる。
//
// ★条件は api.mjs の実物と同じにする（画面に出ているものを測るため）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

console.log('材料を読み込んでいます…')

const race = new Map()
for (const r of db.prepare(`SELECT race_id, substr(race_id,1,8) ymd, kimarite FROM races
  WHERE kimarite IS NOT NULL AND race_id >= '20220818'`).all())
  race.set(r.race_id, { ymd: r.ymd, kimarite: r.kimarite })

const rank = new Map()
for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
  WHERE rank_num IS NOT NULL AND race_id >= '20220818'`).all()) {
  if (!rank.has(r.race_id)) rank.set(r.race_id, new Map())
  rank.get(r.race_id).set(r.lane, r.rank_num)
}

const bi = new Map()
for (const r of db.prepare(`SELECT race_id, lane, tilt, ex_time, ex_course, ex_st, ex_st_flag
  FROM before_info WHERE race_id >= '20220818'`).all()) {
  if (!bi.has(r.race_id)) bi.set(r.race_id, [])
  bi.get(r.race_id).push(r)
}
db.close()

const ids = [...bi.keys()].filter((id) => race.has(id) && rank.has(id)).sort()
console.log(`${ids.length.toLocaleString()}レース（${race.get(ids[0]).ymd}〜${race.get(ids.at(-1)).ymd}）`)
const CUT = race.get(ids[Math.floor(ids.length / 2)]).ymd
const half = (id) => (race.get(id).ymd < CUT ? 0 : 1)
console.log(`前半 〜${CUT} ／ 後半 ${CUT}〜`)
console.log('')

const stOf = (x) => (x.ex_st_flag === 'F' ? -x.ex_st : x.ex_st)
const full = (rows) => rows.filter((x) => x.ex_time > 0).length === 6
const MAKURI = new Set(['まくり', 'まくり差し'])
const f = (v) => (v == null ? '  ―  ' : (v.toFixed(1) + '%').padStart(6))

// ---------- レース単位で測る（アラートの有無でレースを分ける） ----------
function byRace(title, note, cond, outcome) {
  const box = [[0, 0], [0, 0]], hit = [[0, 0], [0, 0]]
  for (const id of ids) {
    const c = cond(id, bi.get(id)); if (c === null) continue
    const h = half(id), i = c ? 1 : 0
    box[h][i]++; if (outcome(id)) hit[h][i]++
  }
  const p = (h, i) => (box[h][i] ? hit[h][i] / box[h][i] * 100 : null)
  console.log('■ ' + title); console.log('  ' + note)
  console.log('        アラート有              アラート無            差')
  const r = []
  for (const h of [0, 1]) {
    r.push(p(h, 0) ? p(h, 1) / p(h, 0) : null)
    console.log(`  ${h ? '後半' : '前半'}  ${f(p(h, 1))}（${String(box[h][1].toLocaleString()).padStart(7)}件）  ` +
      `${f(p(h, 0))}（${String(box[h][0].toLocaleString()).padStart(7)}件）  ${r[h] ? r[h].toFixed(2) + '倍' : '―'}`)
  }
  verdict(r)
}

// ---------- 艇単位で測る（★枠／コースを揃えて比べる） ----------
//   key(x) … 揃える単位（枠番 や 進入コース）。これが同じ艇どうしでだけ比べる。
function byBoat(title, note, keyName, key, flag, skip, outcome) {
  const stat = [new Map(), new Map()]   // 前後半 → key → {on:[n,hit], off:[n,hit]}
  for (const id of ids) {
    const rows = bi.get(id), h = half(id), rk = rank.get(id)
    for (const x of rows) {
      if (skip(x, rows)) continue
      const k = key(x, rows); if (k == null) continue
      const on = flag(x, rows)
      if (!stat[h].has(k)) stat[h].set(k, { on: [0, 0], off: [0, 0] })
      const s = stat[h].get(k)[on ? 'on' : 'off']
      s[0]++; if (outcome(id, x, rk)) s[1]++
    }
  }
  console.log('■ ' + title); console.log('  ' + note)
  console.log(`  ${keyName}ごとに比べ、出た艇の構成で重みづけてまとめています`)
  console.log('        アラート有              アラート無(同じ' + keyName + ')     差')
  const r = []
  for (const h of [0, 1]) {
    let onN = 0, onH = 0, adj = 0
    for (const [, s] of stat[h]) {
      if (!s.on[0] || !s.off[0]) continue
      onN += s.on[0]; onH += s.on[1]
      adj += s.off[1] / s.off[0] * s.on[0]      // 同じ枠の「出なかった艇」の割合で置き換える
    }
    const a = onN ? onH / onN * 100 : null, b = onN ? adj / onN * 100 : null
    r.push(b ? a / b : null)
    console.log(`  ${h ? '後半' : '前半'}  ${f(a)}（${String(onN.toLocaleString()).padStart(7)}件）  ` +
      `${f(b)}（${keyName}を揃えた基準）  ${r[h] ? r[h].toFixed(2) + '倍' : '―'}`)
  }
  verdict(r)
}

function verdict([r0, r1]) {
  console.log('  → ' + (r0 == null || r1 == null ? '測れません'
    : r0 > 1.15 && r1 > 1.15 ? '★前半も後半も効いている'
    : r0 < 0.87 && r1 < 0.87 ? '★前半も後半も「逆」に効いている（避ける材料になる）'
    : (r0 > 1.15) !== (r1 > 1.15) ? '前半と後半で食い違う＝偶然の山'
    : 'ほとんど差がない＝飾り'))
  console.log('')
}

// ================= ① まくりアラート =================
const makuriOn = (rows) => {
  if (!full(rows)) return null
  const ex = rows.filter((x) => x.ex_time > 0)
  const best = [...ex].sort((a, b) => a.ex_time - b.ex_time)[0]
  const one = ex.find((x) => x.lane === 1)
  return !!(best.lane >= 3 && one && one.ex_time - best.ex_time >= 0.05)
}
byRace('まくりアラート → 本当にまくりで決まるか',
  '条件：3〜6号艇の展示が1位で、1号艇より0.05秒以上速い',
  (id, rows) => makuriOn(rows),
  (id) => MAKURI.has(race.get(id).kimarite))

// その艇が1着になるか。比べる相手は「展示1位が3〜6号艇だが0.05秒に届かない」同じ枠の艇
byBoat('まくりアラート → その艇が1着になるか',
  '比較は「展示1位が3〜6号艇だが0.05秒差に届かない」レースの、同じ枠の艇', '枠',
  (x) => x.lane,
  (x, rows) => {
    const ex = rows.filter((y) => y.ex_time > 0)
    const one = ex.find((y) => y.lane === 1)
    return one && one.ex_time - x.ex_time >= 0.05
  },
  (x, rows) => {
    if (!full(rows)) return true
    const ex = rows.filter((y) => y.ex_time > 0)
    const best = [...ex].sort((a, b) => a.ex_time - b.ex_time)[0]
    return !(best.lane === x.lane && x.lane >= 3)   // 展示1位の3〜6号艇だけを土俵に乗せる
  },
  (id, x, rk) => rk.get(x.lane) === 1)

// ================= ② 前づけアラート =================
byBoat('前づけアラート → その艇が3着以内に入るか',
  '条件：展示の進入で、枠より内のコースに入った艇', '枠',
  (x) => x.lane,
  (x) => x.ex_course < x.lane,
  (x) => x.ex_course == null || x.lane === 1,       // 1号艇は前づけしようがない
  (id, x, rk) => (rk.get(x.lane) ?? 9) <= 3)

// 前づけした艇は、入ったコースの艇として見ても強いか（コースを揃える）
byBoat('前づけアラート → 入ったコースの艇として見て強いか',
  '比較は「同じ進入コースに、枠なりで入った艇」', '進入コース',
  (x) => x.ex_course,
  (x) => x.ex_course < x.lane,
  (x) => x.ex_course == null,
  (id, x, rk) => (rk.get(x.lane) ?? 9) <= 3)

// ================= ③ チルト跳アラート =================
byBoat('チルト+1.0度以上 → その艇が3着以内に入るか',
  '条件：チルト+1.0度以上', '枠',
  (x) => x.lane,
  (x) => x.tilt >= 1.0,
  (x) => x.tilt == null,
  (id, x, rk) => (rk.get(x.lane) ?? 9) <= 3)

byBoat('チルト+1.0度以上 → その艇が1着になるか',
  '「跳ねる」なら1着が増えるはず。3着以内とは別に見る', '枠',
  (x) => x.lane,
  (x) => x.tilt >= 1.0,
  (x) => x.tilt == null,
  (id, x, rk) => rk.get(x.lane) === 1)

// ================= ④ スタートアラート =================
// 「凹んだ内の艇」を、同じ進入コースの艇と比べる
const dented = (rows) => {
  const st = rows.filter((x) => x.ex_st != null && x.ex_course != null).sort((a, b) => a.ex_course - b.ex_course)
  const set = new Set()
  for (let i = 1; i < st.length; i++)
    if (stOf(st[i - 1]) - stOf(st[i]) >= 0.05) set.add(st[i - 1].lane)
  return set
}
byBoat('スタートアラート → 凹んだ内の艇が負けるか（4着以下）',
  '条件：展示STで、外の艇が内の艇より0.05秒以上速い', '進入コース',
  (x) => x.ex_course,
  (x, rows) => dented(rows).has(x.lane),
  (x) => x.ex_st == null || x.ex_course == null,
  (id, x, rk) => (rk.get(x.lane) ?? 9) >= 4)

// ---------- 閾値を振る（後半だけ・進入コースを揃えて） ----------
// ⚠ ここで良い閾値が見つかっても、それは「探した」数字。採るなら別期間で確かめ直すこと。
console.log('【スタートアラートの閾値を振る（後半だけ・進入コースを揃えて）】')
console.log('  しきい値      件数   内が4着以下   同じコースの基準   差')
for (const th of [0.05, 0.10, 0.15, 0.20, 0.30]) {
  const stat = new Map()
  for (const id of ids) {
    if (half(id) !== 1) continue
    const rows = bi.get(id), rk = rank.get(id)
    const st = rows.filter((x) => x.ex_st != null && x.ex_course != null).sort((a, b) => a.ex_course - b.ex_course)
    const set = new Set()
    for (let i = 1; i < st.length; i++)
      if (stOf(st[i - 1]) - stOf(st[i]) >= th) set.add(st[i - 1].lane)
    for (const x of st) {
      const k = x.ex_course
      if (!stat.has(k)) stat.set(k, { on: [0, 0], off: [0, 0] })
      const s = stat.get(k)[set.has(x.lane) ? 'on' : 'off']
      s[0]++; if ((rk.get(x.lane) ?? 9) >= 4) s[1]++
    }
  }
  let onN = 0, onH = 0, adj = 0
  for (const [, s] of stat) {
    if (!s.on[0] || !s.off[0]) continue
    onN += s.on[0]; onH += s.on[1]; adj += s.off[1] / s.off[0] * s.on[0]
  }
  if (!onN) { console.log(`  ${th.toFixed(2)}秒  該当なし`); continue }
  const a = onH / onN * 100, b = adj / onN * 100
  console.log(`  ${th.toFixed(2)}秒  ${String(onN.toLocaleString()).padStart(8)}件  ${a.toFixed(1).padStart(6)}%  ` +
    `${b.toFixed(1).padStart(10)}%  ${(a / b).toFixed(2)}倍`)
}
