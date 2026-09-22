// 案D：全項目を演算に使う。コース別の重み＋掛け合わせの拡張。
// あわせて「着順パターン全体を評価する方式」も同時に測る。
//
//   node --max-old-space-size=6144 scripts/walkD.mjs --from 2025-09-01 --l2 0.0003
//   node --max-old-space-size=6144 scripts/walkD.mjs --l2 0.003    罰則を強める
//
// ★案Dの中身
//   ① コース別の重み … 各艇の点数を「その艇の枠番専用の係数」で計算する
//      いまはモーター2連率の係数が1号艇でも6号艇でも同じ値だった。
//      1号艇は枠の利で勝てるのでモーターの影響は小さく、外枠は握って回るので
//      出足が直接効く。同じ項目でも枠ごとに効き方が違う。
//   ② 掛け合わせの拡張 … コース×場／コース×時間帯／コース×風速帯／コース×波高帯
//      いまは9項目しかない。これを大幅に増やす。
//
// ★2つの並べ方を同時に測る
//   方式1（順に選ぶ）  1着を選ぶ → 除いて2着を選ぶ → 除いて3着を選ぶ
//   方式2（着順パターン全体） 6艇の並び全部（720通り）に点数をつけて比べる
//      「1着を先に決める」のではなく「1〜6着がこうなる可能性」を直接評価する。
//      本人の提案。720通りは多いので、上位候補だけを評価する形にする。
//
// ★過学習は許す（本人の指示）
//   まず罰則を弱くして上限を見る。学習した月と翌月の差が過学習の量。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const FROM = flag('from', '2025-09-01')
const FIRST = Number(flag('first', 4))
const L2 = Number(flag('l2', 0.0003))
const EPOCHS = Number(flag('epochs', 60))
const T1 = flag('t1', 'wd1'), T3 = flag('t3', 'wd3')
// seq   = 1着を先に決める順で学習（Plackett-Luce）
// whole = 着順パターン全体（120通り）を一度に比べて学習
const MODE = flag('mode', 'seq')

// ---------- 項目 ----------
const featCols = db.prepare(`PRAGMA table_info(feat)`).all().map((c) => c.name)
  .filter((c) => !['race_id', 'lane', 'racer_id', 'course'].includes(c))
  .filter((c) => !/^(waveb_|windb_|nami5_|wl_|wake_)/.test(c))
const rfeatCols = db.prepare(`PRAGMA table_info(rfeat)`).all().map((c) => c.name)
  .filter((c) => c !== 'race_id' && c !== 'lane')
const progCols = ['age', 'weight', 'win_rate_nat', 'top2_nat', 'win_rate_loc', 'top2_loc',
  'motor_top2', 'boat_top2', 'hayami']
const BASE = [...featCols, ...rfeatCols, ...progCols]
const DB_ = BASE.length
console.log(`艇単位${featCols.length} + レース単位${rfeatCols.length} + 番組表${progCols.length} = ${DB_}項目`)

// ★掛け合わせ（コース別に持つので、ここは「レースの条件」だけ）
//   場24 / 時間帯16 / 風速帯5 / 波高帯5 / グレード6 = 56 のダミー
const VEN = [...Array(24)].map((_, i) => i + 1)
const HRS = [...Array(16)].map((_, i) => i + 8)          // 8時〜23時
const WINDB = ['a', 'b', 'c', 'd', 'e']
const WAVEB = ['a', 'b', 'c', 'd', 'e']
const GRADES = ['SG', 'G1', 'G2', 'G3', '一般', 'その他']
const CROSS = [...VEN.map((v) => `場${v}`), ...HRS.map((h) => `時${h}`),
  ...WINDB.map((w) => `風${w}`), ...WAVEB.map((w) => `波${w}`), ...GRADES.map((g) => `級${g}`)]
const DC = CROSS.length
const D = DB_ + DC
console.log(`  ＋ 条件ダミー${DC}（場24・時間帯16・風速5・波高5・グレード6）= ${D}項目`)
console.log(`  × コース6 = 係数 ${(D * 6).toLocaleString()}個／段階  合計 ${(D * 6 * 3).toLocaleString()}個\n`)

const windB = (w) => w == null ? 'a' : w <= 1 ? 'a' : w <= 3 ? 'b' : w <= 5 ? 'c' : w <= 7 ? 'd' : 'e'
const waveB = (w) => w == null ? 'a' : w === 0 ? 'a' : w <= 2 ? 'b' : w <= 4 ? 'c' : w <= 7 ? 'd' : 'e'
const gradeB = (g) => { const s = String(g ?? ''); for (const k of ['SG', 'G1', 'G2', 'G3']) if (s.startsWith(k)) return k; return s === '一般' ? '一般' : 'その他' }
const hourOf = (dl) => { const m = String(dl ?? '').match(/^([0-9]{1,2}):/); return m ? Number(m[1]) : -1 }

const q = (k) => '"' + k.replace(/"/g, '""') + '"'
const SQL = `
  SELECT f.race_id, f.lane, r.date, r.jcd, r.grade, r.deadline, r.wind_speed, r.wave, e.rank_num,
    ${progCols.map((c) => `p.${q(c)}`).join(', ')},
    ${featCols.map((c) => `f.${q(c)}`).join(', ')},
    ${rfeatCols.map((c) => `rf.${q(c)}`).join(', ')}
  FROM feat f
  JOIN races r ON r.race_id = f.race_id
  JOIN entries e ON e.race_id = f.race_id AND e.lane = f.lane
  LEFT JOIN programs p ON p.race_id = f.race_id AND p.lane = f.lane
  LEFT JOIN rfeat rf ON rf.race_id = f.race_id AND rf.lane = f.lane
  WHERE r.date >= '${FROM}'
  ORDER BY r.date, f.race_id, f.lane`

const CIDX = new Map(CROSS.map((c, i) => [c, i]))
const vec = (r) => {
  const v = new Float32Array(D)
  let k = 0
  for (const c of featCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  for (const c of rfeatCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  for (const c of progCols) { const x = r[c]; v[k++] = x == null ? 0 : x }
  const put = (name) => { const i = CIDX.get(name); if (i != null) v[DB_ + i] = 1 }
  put('場' + r.jcd); put('時' + hourOf(r.deadline))
  put('風' + windB(r.wind_speed)); put('波' + waveB(r.wave)); put('級' + gradeB(r.grade))
  return v
}

// ---------- 読み込み ----------
const races = []
{
  let cur = null, n = 0
  for (const r of db.prepare(SQL).iterate()) {
    if (!cur || cur.race_id !== r.race_id) { cur = { race_id: r.race_id, date: r.date, boats: [] }; races.push(cur) }
    cur.boats.push({ x: vec(r), lane: r.lane })
    if (++n % 200000 === 0) console.log(`  ${n.toLocaleString()} 行`)
  }
  console.log(`${n.toLocaleString()} 行 / ${races.length.toLocaleString()} レース`)
}
const ORD = new Map()
for (const r of db.prepare(`SELECT race_id,lane,rank_num FROM entries WHERE rank_num BETWEEN 1 AND 3`).all()) {
  let m = ORD.get(r.race_id); if (!m) { m = {}; ORD.set(r.race_id, m) }
  m[r.rank_num] = r.lane
}
for (const g of races) { const m = ORD.get(g.race_id); g.ord = m && m[1] && m[2] && m[3] ? [m[1], m[2], m[3]] : null }
const usable = races.filter((g) => g.boats.length === 6 && g.ord)
console.log(`使えるレース ${usable.length.toLocaleString()}`)

// ---------- 標準化（条件ダミーはそのまま） ----------
{
  const mean = new Float64Array(D), sd = new Float64Array(D)
  let n = 0
  for (const g of usable) for (const b of g.boats) { for (let d = 0; d < DB_; d++) mean[d] += b.x[d]; n++ }
  for (let d = 0; d < DB_; d++) mean[d] /= n
  for (const g of usable) for (const b of g.boats) for (let d = 0; d < DB_; d++) sd[d] += (b.x[d] - mean[d]) ** 2
  for (let d = 0; d < DB_; d++) { sd[d] = Math.sqrt(sd[d] / n); if (!(sd[d] > 1e-9)) sd[d] = 1 }
  for (const g of usable) for (const b of g.boats)
    for (let d = 0; d < DB_; d++) b.x[d] = (b.x[d] - mean[d]) / sd[d]
  console.log('標準化 完了')
}

// ---------- 学習：コース別の重み ----------
// W[st][lane-1] が長さ D の係数。艇はその枠の係数だけを使う。
function fit(rs) {
  const W = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const M = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const V = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  for (let ep = 1; ep <= EPOCHS; ep++) {
    const G = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
    for (const g of rs) {
      const bs = g.boats, idx = new Map(bs.map((b, i) => [b.lane, i]))
      const gone = new Set()
      for (let st = 0; st < 3; st++) {
        const cand = []; for (let i = 0; i < 6; i++) if (!gone.has(i)) cand.push(i)
        const s = cand.map((i) => {
          const w = W[st][bs[i].lane - 1], x = bs[i].x
          let z = 0; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z
        })
        const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
        const sum = ex.reduce((a, b) => a + b, 0)
        const pick = idx.get(g.ord[st]); if (pick === undefined) break
        for (let k = 0; k < cand.length; k++) {
          const i = cand[k], p = ex[k] / sum, x = bs[i].x
          const c = i === pick ? p - 1 : p
          const gr = G[st][bs[i].lane - 1]
          for (let d = 0; d < D; d++) gr[d] += c * x[d]
        }
        gone.add(pick)
      }
    }
    const n = rs.length
    for (let st = 0; st < 3; st++) for (let L = 0; L < 6; L++) {
      const w = W[st][L], m = M[st][L], v = V[st][L], gr = G[st][L]
      for (let d = 0; d < D; d++) {
        const gi = gr[d] / n + L2 * w[d]
        m[d] = 0.9 * m[d] + 0.1 * gi
        v[d] = 0.999 * v[d] + 0.001 * gi * gi
        w[d] -= 0.25 * (m[d] / (1 - 0.9 ** ep)) / (Math.sqrt(v[d] / (1 - 0.999 ** ep)) + 1e-8)
      }
    }
  }
  return W
}

// ★共通＋差分（--shared）
//   枠ごとに丸ごと別の係数を持たせると、1号艇の精度が落ちた（実測 91.47%→86.49%）。
//   1号艇が1着のレースは24,903本あるのに対し6号艇は1,352本しかなく、
//   枠別に切ると外枠は本数が足りず、内枠は本数を分け合って損をする。
//   そこで「全枠に共通の係数」＋「枠ごとの小さなずらし」に分け、
//   ずらしのほうだけ強い罰則をかける。外枠の改善は残しつつ内枠を守る狙い。
//
//     その艇の点数 = (共通の係数 + その枠の差分) × 項目
const L2D = Number(flag('l2d', 0.01))   // 差分にかける罰則（共通より強く）
const LRD = Number(flag('lrd', 0.05))   // 差分の歩幅（共通の1/5）
function fitShared(rs) {
  const B = [0, 1, 2].map(() => new Float64Array(D))                       // 共通
  const Dd = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))  // 枠ごとの差分
  const MB = [0, 1, 2].map(() => new Float64Array(D))
  const VB = [0, 1, 2].map(() => new Float64Array(D))
  const MD = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const VD = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  for (let ep = 1; ep <= EPOCHS; ep++) {
    const GB = [0, 1, 2].map(() => new Float64Array(D))
    const GD = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
    for (const g of rs) {
      const bs = g.boats, idx = new Map(bs.map((b, i) => [b.lane, i]))
      const gone = new Set()
      for (let st = 0; st < 3; st++) {
        const cand = []; for (let i = 0; i < 6; i++) if (!gone.has(i)) cand.push(i)
        const s = cand.map((i) => {
          const b = B[st], d = Dd[st][bs[i].lane - 1], x = bs[i].x
          let z = 0; for (let k = 0; k < D; k++) z += (b[k] + d[k]) * x[k]; return z
        })
        const mx = Math.max(...s), ex = s.map((v) => Math.exp(v - mx))
        const sum = ex.reduce((a, b2) => a + b2, 0)
        const pick = idx.get(g.ord[st]); if (pick === undefined) break
        for (let k = 0; k < cand.length; k++) {
          const i = cand[k], p = ex[k] / sum, x = bs[i].x
          const c = i === pick ? p - 1 : p
          const gb = GB[st], gd = GD[st][bs[i].lane - 1]
          for (let e = 0; e < D; e++) { const v = c * x[e]; gb[e] += v; gd[e] += v }
        }
        gone.add(pick)
      }
    }
    const n = rs.length
    // ★歩幅は共通と差分で分ける。
    //   Adam は勾配の大きさに関係なく「歩幅ぶん」動かすので、
    //   共通と差分に同じ勾配を同じ歩幅で入れると合計が2倍動いて壊れる（実測33%まで落ちた）。
    //   差分はあくまで小さなずらしなので、歩幅を1/5にする。
    const step = (w, m, v, gr, l2, lr) => {
      for (let e = 0; e < D; e++) {
        const gi = gr[e] / n + l2 * w[e]
        m[e] = 0.9 * m[e] + 0.1 * gi
        v[e] = 0.999 * v[e] + 0.001 * gi * gi
        w[e] -= lr * (m[e] / (1 - 0.9 ** ep)) / (Math.sqrt(v[e] / (1 - 0.999 ** ep)) + 1e-8)
      }
    }
    for (let st = 0; st < 3; st++) {
      step(B[st], MB[st], VB[st], GB[st], L2, 0.25)
      for (let L = 0; L < 6; L++) step(Dd[st][L], MD[st][L], VD[st][L], GD[st][L], L2D, LRD)
    }
  }
  // 呼び出し側は W[st][lane] を期待しているので、足してから返す
  const W = [0, 1, 2].map((st) => [...Array(6)].map((_, L) => {
    const w = new Float64Array(D)
    for (let e = 0; e < D; e++) w[e] = B[st][e] + Dd[st][L][e]
    return w
  }))
  return W
}

// ★方式2専用の学習：着順パターン全体を一度に比べる
//   1着を先に決めない。6艇の並び120通り（1〜3着ぶん）それぞれに点数をつけ、
//   「実際に起きた並び」の確率が上がるように係数を動かす。
//   ずれの計算は「その艇が1着になる確率 − 実際に1着だったか」で、順に選ぶ方式と同じ形になる。
function fitWhole(rs) {
  const W = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const M = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  const V = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
  for (let ep = 1; ep <= EPOCHS; ep++) {
    const G = [0, 1, 2].map(() => [...Array(6)].map(() => new Float64Array(D)))
    for (const g of rs) {
      const bs = g.boats, idx = new Map(bs.map((b, i) => [b.lane, i]))
      const s = [0, 1, 2].map((st) => bs.map((b) => {
        const w = W[st][b.lane - 1], x = b.x
        let z = 0; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z
      }))
      // 120通りを全部数え上げて、各着順ごとの「その艇が来る確率」を作る
      let mx = -Infinity
      for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) { if (b === a) continue
        for (let c = 0; c < 6; c++) { if (c === a || c === b) continue
          const z = s[0][a] + s[1][b] + s[2][c]; if (z > mx) mx = z } }
      const P = [new Float64Array(6), new Float64Array(6), new Float64Array(6)]
      let tot = 0
      for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) { if (b === a) continue
        for (let c = 0; c < 6; c++) { if (c === a || c === b) continue
          const e = Math.exp(s[0][a] + s[1][b] + s[2][c] - mx)
          tot += e; P[0][a] += e; P[1][b] += e; P[2][c] += e } }
      for (let st = 0; st < 3; st++) for (let i = 0; i < 6; i++) P[st][i] /= tot
      const hit = [idx.get(g.ord[0]), idx.get(g.ord[1]), idx.get(g.ord[2])]
      if (hit.some((h) => h === undefined)) continue
      for (let st = 0; st < 3; st++) for (let i = 0; i < 6; i++) {
        const c = P[st][i] - (i === hit[st] ? 1 : 0)
        if (c === 0) continue
        const gr = G[st][bs[i].lane - 1], x = bs[i].x
        for (let d = 0; d < D; d++) gr[d] += c * x[d]
      }
    }
    const n = rs.length
    for (let st = 0; st < 3; st++) for (let L = 0; L < 6; L++) {
      const w = W[st][L], m = M[st][L], v = V[st][L], gr = G[st][L]
      for (let d = 0; d < D; d++) {
        const gi = gr[d] / n + L2 * w[d]
        m[d] = 0.9 * m[d] + 0.1 * gi
        v[d] = 0.999 * v[d] + 0.001 * gi * gi
        w[d] -= 0.25 * (m[d] / (1 - 0.9 ** ep)) / (Math.sqrt(v[d] / (1 - 0.999 ** ep)) + 1e-8)
      }
    }
  }
  return W
}

const score = (W, st, b) => {
  const w = W[st][b.lane - 1], x = b.x
  let z = 0; for (let d = 0; d < D; d++) z += w[d] * x[d]; return z
}

/** 方式1：順に選ぶ（1着→2着→3着） */
function trioSeq(W, race) {
  const bs = race.boats
  const sc = [0, 1, 2].map((st) => bs.map((b) => score(W, st, b)))
  const soft = (idx, s) => { const m = Math.max(...idx.map((i) => s[i]))
    const e = idx.map((i) => Math.exp(s[i] - m)); const t = e.reduce((a, b) => a + b, 0); return e.map((x) => x / t) }
  const N = 6, all = [...Array(N).keys()]
  const p1 = soft(all, sc[0])
  const out = []
  for (let a = 0; a < N; a++) {
    const i2 = all.filter((i) => i !== a), q2 = soft(i2, sc[1])
    for (let bi = 0; bi < i2.length; bi++) {
      const b = i2[bi]
      const i3 = all.filter((i) => i !== a && i !== b), q3 = soft(i3, sc[2])
      for (let ci = 0; ci < i3.length; ci++)
        out.push({ combo: `${bs[a].lane}-${bs[b].lane}-${bs[i3[ci]].lane}`, p: p1[a] * q2[bi] * q3[ci] })
    }
  }
  const t = out.reduce((a, x) => a + x.p, 0)
  for (const x of out) x.p /= t
  return { trios: out, p1: bs.map((b, i) => ({ lane: b.lane, p: p1[i] })) }
}

/** 方式2：着順パターン全体を評価する（本人の提案）
 *  6艇の並び120通り（上位3着ぶん）それぞれに「その並びらしさ」を1つの点数として与え、
 *  まとめて確率にする。1着を先に決めない。 */
function trioWhole(W, race) {
  const bs = race.boats
  const s0 = bs.map((b) => score(W, 0, b))
  const s1 = bs.map((b) => score(W, 1, b))
  const s2 = bs.map((b) => score(W, 2, b))
  const out = []
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) { if (b === a) continue
    for (let c = 0; c < 6; c++) { if (c === a || c === b) continue
      // 並び全体の点数＝1着らしさ＋2着らしさ＋3着らしさ を一度に足す
      out.push({ combo: `${bs[a].lane}-${bs[b].lane}-${bs[c].lane}`, z: s0[a] + s1[b] + s2[c] })
    } }
  const mx = Math.max(...out.map((x) => x.z))
  let t = 0
  for (const x of out) { x.p = Math.exp(x.z - mx); t += x.p }
  for (const x of out) x.p /= t
  // 1着確率は畳んで作る
  const m1 = new Map()
  for (const x of out) { const l = x.combo.slice(0, x.combo.indexOf('-')); m1.set(l, (m1.get(l) ?? 0) + x.p) }
  return { trios: out, p1: bs.map((b) => ({ lane: b.lane, p: m1.get(String(b.lane)) ?? 0 })) }
}

// ---------- 歩進検証 ----------
for (const T of [T1, T3, T1 + 'w', T3 + 'w']) db.exec(`DROP TABLE IF EXISTS ${T}`)
db.exec(`CREATE TABLE ${T1} (race_id TEXT, lane INTEGER, month TEXT, p REAL, y INTEGER, PRIMARY KEY(race_id,lane))`)
db.exec(`CREATE TABLE ${T3} (race_id TEXT, combo TEXT, month TEXT, p REAL, PRIMARY KEY(race_id,combo))`)
db.exec(`CREATE TABLE ${T1}w (race_id TEXT, lane INTEGER, month TEXT, p REAL, y INTEGER, PRIMARY KEY(race_id,lane))`)
db.exec(`CREATE TABLE ${T3}w (race_id TEXT, combo TEXT, month TEXT, p REAL, PRIMARY KEY(race_id,combo))`)
const ins1 = db.prepare(`INSERT OR REPLACE INTO ${T1} VALUES (?,?,?,?,?)`)
const ins3 = db.prepare(`INSERT OR REPLACE INTO ${T3} VALUES (?,?,?,?)`)
const ins1w = db.prepare(`INSERT OR REPLACE INTO ${T1}w VALUES (?,?,?,?,?)`)
const ins3w = db.prepare(`INSERT OR REPLACE INTO ${T3}w VALUES (?,?,?,?)`)

const months = [...new Set(usable.map((g) => g.date.slice(0, 7)))].sort()
const folds = months.slice(FIRST)
console.log(`\n${months[0]} 〜 ${months[months.length - 1]}　最初の${FIRST}ヶ月で学習し、残り${folds.length}ヶ月を検証`)
console.log(`罰則 l2=${L2}　学習回数 ${EPOCHS}\n`)
console.log('月        学習     検証   1着的中(順に)  1着的中(全体)  学習した月  所要')
for (const mo of folds) {
  const tr = usable.filter((g) => g.date.slice(0, 7) < mo)
  const te = usable.filter((g) => g.date.slice(0, 7) === mo)
  if (tr.length < 3000 || !te.length) continue
  const t0 = Date.now()
  const W = MODE === 'whole' ? fitWhole(tr) : MODE === 'shared' ? fitShared(tr) : fit(tr)
  let h1 = 0, h2 = 0
  db.exec('BEGIN')
  for (const g of te) {
    const A = trioSeq(W, g), B = trioWhole(W, g)
    const fa = A.p1.reduce((x, y) => (y.p > x.p ? y : x)), fb = B.p1.reduce((x, y) => (y.p > x.p ? y : x))
    if (fa.lane === g.ord[0]) h1++
    if (fb.lane === g.ord[0]) h2++
    for (const b of A.p1) ins1.run(g.race_id, b.lane, mo, b.p, b.lane === g.ord[0] ? 1 : 0)
    for (const x of A.trios) ins3.run(g.race_id, x.combo, mo, x.p)
    for (const b of B.p1) ins1w.run(g.race_id, b.lane, mo, b.p, b.lane === g.ord[0] ? 1 : 0)
    for (const x of B.trios) ins3w.run(g.race_id, x.combo, mo, x.p)
  }
  db.exec('COMMIT')
  // 学習した月そのものの的中率（過学習の量を見る）
  const smp = tr.slice(-Math.min(3000, tr.length))
  let hin = 0
  for (const g of smp) { const A = trioSeq(W, g); if (A.p1.reduce((x, y) => (y.p > x.p ? y : x)).lane === g.ord[0]) hin++ }
  console.log(`${mo}  ${String(tr.length).padStart(7)} ${String(te.length).padStart(7)} ${(h1 / te.length * 100).toFixed(2).padStart(12)}% ${(h2 / te.length * 100).toFixed(2).padStart(13)}% ${(hin / smp.length * 100).toFixed(2).padStart(10)}% ${((Date.now() - t0) / 60000).toFixed(1).padStart(6)}分`)
}
console.log(`\n完了: ${T1} / ${T3}（順に選ぶ）　${T1}w / ${T3}w（着順パターン全体）`)
db.close()
