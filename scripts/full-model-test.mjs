// フルモデル（直前情報あり・226項目）が、朝モデル（194項目）より本当に良いかを測る。
//
//   node scripts/full-model-test.mjs --full <フルモデルのJSONを置いたフォルダ>
//
// ★なぜ要るか（2026-10-02）
//   predict.mjs は「そのレースに直前情報があればフルモデルを使う」作りだが、
//   predict.mjs が走るのは 02:00（--nobefore）と 06:00 の2回だけ。
//   どちらの時刻にも展示は終わっていないので、**フルモデルは毎晩学習されながら
//   一度も予想に使われていない**。使う価値があるのかを、まず数字で確かめる。
//
// ★作り方
//   朝モデルぶん   … data/predict-<日付>.json（本番がその日の朝に作ったもの）
//   フルモデルぶん … 同じ日付を、直前情報を入れて predict.mjs で作り直したもの
//   どちらも「1着確率（first[].p）」を結果と突き合わせる。
//
// ★両モデルとも学習は 2026-09-03 まで。それ以降の日付だけを使うこと（学習外）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const FULLDIR = argv[argv.indexOf('--full') + 1]
if (!FULLDIR || !existsSync(FULLDIR)) { console.error('--full <フォルダ> が要ります'); process.exit(1) }

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

// 結果・展示タイム・風を引く
const fact = new Map()   // race_id|lane → {y, course, ex, sp}
for (const r of db.prepare(`
  SELECT e.race_id, e.lane, e.course, e.rank_num, b.ex_time, rr.wind_speed
  FROM entries e
  LEFT JOIN before_info b ON b.race_id=e.race_id AND b.lane=e.lane
  LEFT JOIN races rr ON rr.race_id=e.race_id
  WHERE e.race_id >= '20260904'`).all())
  fact.set(r.race_id + '|' + r.lane,
    { y: r.rank_num === 1 ? 1 : 0, done: r.rank_num != null, course: r.course, ex: r.ex_time, sp: r.wind_speed })

const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const dates = readdirSync(FULLDIR).filter((f) => /^full-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(5, 15)).sort()

const rows = []   // {rid, lane, pFull, pMorn, y, course, ex, sp}
for (const d of dates) {
  const F = read(join(FULLDIR, `full-${d}.json`))
  const M = read(join(ROOT, 'data', `predict-${d}.json`))
  if (!F || !M) continue
  const mm = new Map((M.races ?? []).map((r) => [r.race_id, r]))
  for (const r of (F.races ?? [])) {
    const m = mm.get(r.race_id); if (!m) continue
    const mp = new Map((m.first ?? []).map((x) => [x.lane, x.p]))
    for (const x of (r.first ?? [])) {
      const f = fact.get(r.race_id + '|' + x.lane)
      if (!f || !f.done || mp.get(x.lane) == null) continue
      rows.push({ rid: r.race_id, lane: x.lane, pFull: x.p, pMorn: mp.get(x.lane), ...f })
    }
  }
}
console.log(`突き合わせ ${rows.length.toLocaleString()}艇 ／ ${dates.length}日（${dates[0]}〜${dates.at(-1)}）`)
console.log('')

// ---------- 全体の精度 ----------
const logloss = (key) => -rows.reduce((s, r) => {
  const p = Math.min(0.999999, Math.max(1e-6, r[key]))
  return s + (r.y ? Math.log(p) : Math.log(1 - p))
}, 0) / rows.length
// 1着を当てた率（レースごとに確率最大の艇）
const top1 = (key) => {
  const by = new Map()
  for (const r of rows) { let a = by.get(r.rid); if (!a) { a = []; by.set(r.rid, a) } a.push(r) }
  let hit = 0, n = 0
  for (const [, a] of by) { if (a.length < 2) continue; n++; if (a.slice().sort((x, y) => y[key] - x[key])[0].y) hit++ }
  return { rate: hit / n * 100, n }
}
const tm = top1('pMorn'), tf = top1('pFull')
console.log('■ 全体')
console.log(`  朝モデル    1着的中 ${tm.rate.toFixed(2)}%   logloss ${logloss('pMorn').toFixed(4)}`)
console.log(`  フルモデル  1着的中 ${tf.rate.toFixed(2)}%   logloss ${logloss('pFull').toFixed(4)}   （${tm.n.toLocaleString()}レース）`)
console.log('')

// ---------- 条件ごとのズレ ----------
function gaps(label, bucket) {
  const B = new Map()
  for (const r of rows) {
    const k = bucket(r); if (k == null) continue
    let v = B.get(k); if (!v) { v = { n: 0, m: 0, f: 0, y: 0 }; B.set(k, v) }
    v.n++; v.m += r.pMorn; v.f += r.pFull; v.y += r.y
  }
  console.log('■ ' + label + '（ズレ＝実際−予測。0に近いほど読めている）')
  console.log('  区分              艇数    実際     朝モデルのズレ   フルモデルのズレ')
  for (const [k, v] of [...B].sort()) {
    const y = v.y / v.n * 100, gm = y - v.m / v.n * 100, gf = y - v.f / v.n * 100
    const s = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + 'pt'
    console.log('  ' + String(k).padEnd(16), String(v.n).padStart(6), y.toFixed(2).padStart(7) + '%',
      s(gm).padStart(14), s(gf).padStart(17))
  }
  console.log('')
}

// 展示タイムのレース内順位
{
  const by = new Map()
  for (const r of rows) { let a = by.get(r.rid); if (!a) { a = []; by.set(r.rid, a) } a.push(r) }
  for (const [, a] of by) {
    const w = a.filter((x) => x.ex != null)
    if (w.length !== 6) continue
    w.slice().sort((x, y) => x.ex - y.ex).forEach((x, i) => { x.exRank = i + 1 })
  }
}
gaps('展示タイムの順位', (r) => r.exRank ? `展示${r.exRank}位` : null)
gaps('風速と進入コース', (r) => r.sp == null || r.course == null ? null
  : `風${r.sp >= 3 ? '3m以上' : '2m以下'} ${r.course <= 3 ? '内' : '外'}`)

db.close()
