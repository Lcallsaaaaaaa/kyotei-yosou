// 展示の進入コース（exc_*）を足したモデルが、本当に良くなったかを測る。
//
//   node scripts/exc-test.mjs --base <対照の出力フォルダ> --new <新しいほうのフォルダ>
//
// ★比べ方
//   学習期限をそろえ、**新項目の有無だけ**が違う2本を作って比べる。
//   期限の違うモデル同士を比べると、何が効いたのか分からない。
//     対照 226項目（model5.mjs --drop '^(exc_|bf_ex_course|bf_ex_move)'）
//     新   235項目
//   どちらも学習〜2026-09-05。測るのは学習外の 9/06〜10/03。
//
// ★なぜ足したか（2026-10-02の実測）
//   進入は締切後にしか確定しないので、学習も予想も枠番で代用していた。
//   展示の進入は枠番より実際に近い（94.85% 対 90.13%／前づけレースでは51.7% 対 0.0%）。
//   そして歩進検証271,592艇で、モデルのズレは「進入を動かした艇」に集中していた。
//     内へ4つ +8.92pt ／ 内へ3つ +2.80pt ／ 枠なり −0.09pt ／ 外へ2つ +1.90pt
//   ここが埋まれば成功。変わらなければ、特徴量として渡しても学習が拾えていない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : null }
const BASE = flag('base'), NEW = flag('new')
if (!BASE || !NEW || !existsSync(BASE) || !existsSync(NEW)) { console.error('--base と --new にフォルダを指定してください'); process.exit(1) }

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
const fact = new Map()
for (const r of db.prepare(`
  SELECT e.race_id, e.lane, e.rank_num, e.course, b.ex_course
  FROM entries e LEFT JOIN before_info b ON b.race_id=e.race_id AND b.lane=e.lane
  WHERE e.race_id >= '20260906'`).all()) fact.set(r.race_id + '|' + r.lane, r)

const read = (d, f) => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')) } catch { return null } }
const dates = readdirSync(NEW).filter((f) => /^full-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(5, 15)).sort()

const rows = []
for (const d of dates) {
  const A = read(BASE, `full-${d}.json`), B = read(NEW, `full-${d}.json`)
  if (!A || !B) continue
  const am = new Map((A.races ?? []).map((r) => [r.race_id, r]))
  for (const r of (B.races ?? [])) {
    const a = am.get(r.race_id); if (!a) continue
    const ap = new Map((a.first ?? []).map((x) => [x.lane, x.p]))
    for (const x of (r.first ?? [])) {
      const f = fact.get(r.race_id + '|' + x.lane)
      if (!f || f.rank_num == null || ap.get(x.lane) == null) continue
      rows.push({ rid: r.race_id, lane: x.lane, pB: ap.get(x.lane), pN: x.p,
        y: f.rank_num === 1 ? 1 : 0, ex: f.ex_course })
    }
  }
}
console.log(`突き合わせ ${rows.length.toLocaleString()}艇 ／ ${dates.length}日（${dates[0]}〜${dates.at(-1)}）`)
console.log('')

// ---------- ① 全体 ----------
const ll = (p, y) => { const q = Math.min(0.999999, Math.max(1e-6, p)); return -(y ? Math.log(q) : Math.log(1 - q)) }
const byRace = new Map()
for (const r of rows) { let a = byRace.get(r.rid); if (!a) { a = []; byRace.set(r.rid, a) } a.push(r) }
const diffs = []
let hitB = 0, hitN = 0, nR = 0, b = 0, c = 0
for (const [, a] of byRace) {
  if (a.length !== 6) continue
  nR++
  const sb = a.slice().sort((x, y) => y.pB - x.pB)[0], sn = a.slice().sort((x, y) => y.pN - x.pN)[0]
  if (sb.y) hitB++; if (sn.y) hitN++
  if (sb.y && !sn.y) b++; else if (!sb.y && sn.y) c++
  diffs.push((a.reduce((s, x) => s + ll(x.pB, x.y), 0) - a.reduce((s, x) => s + ll(x.pN, x.y), 0)) / 6)
}
const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length
const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (diffs.length - 1))
const se = sd / Math.sqrt(diffs.length), t = mean / se
const erf = (x) => { const q = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * q - 1.453152027) * q) + 1.421413741) * q - 0.284496736) * q + 0.254829592) * q * Math.exp(-x * x); return x >= 0 ? y : -y }
const pv = 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)))
console.log('■ 全体（' + nR.toLocaleString() + 'レース）')
console.log(`  1着的中   対照 ${(hitB / nR * 100).toFixed(2)}%  →  新 ${(hitN / nR * 100).toFixed(2)}%`)
console.log(`  logloss の差（対照−新）平均 ${mean.toFixed(5)} ±${se.toFixed(5)}  t=${t.toFixed(2)}  p値=${pv < 1e-6 ? '<0.000001' : pv.toFixed(6)}`)
console.log('  ' + (pv < 0.05 ? (mean > 0 ? '→ 新しいほうが良い' : '→ 新しいほうが悪い') : '→ 差は偶然の範囲'))
console.log(`  新だけ当てた ${c}レース ／ 対照だけ当てた ${b}レース`)
console.log('')

// ---------- ② 動いた艇のズレ ----------
const B2 = new Map()
for (const r of rows) {
  if (r.ex == null || r.ex < 1 || r.ex > 6) continue
  const mv = r.ex - r.lane
  const k = mv === 0 ? '枠なり' : mv < 0 ? `内へ ${-mv}つ` : `外へ ${mv}つ`
  let v = B2.get(k); if (!v) { v = { n: 0, b: 0, nn: 0, y: 0 }; B2.set(k, v) }
  v.n++; v.b += r.pB; v.nn += r.pN; v.y += r.y
}
console.log('■ 進入を動かした艇のズレ（実際−予測。0に近いほど読めている）')
console.log('  区分          艇数      実際     対照のズレ    新のズレ')
for (const k of ['内へ 5つ', '内へ 4つ', '内へ 3つ', '内へ 2つ', '内へ 1つ', '枠なり', '外へ 1つ', '外へ 2つ', '外へ 3つ']) {
  const v = B2.get(k); if (!v || v.n < 50) continue
  const y = v.y / v.n * 100, gb = y - v.b / v.n * 100, gn = y - v.nn / v.n * 100
  const s = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + 'pt'
  console.log('  ' + k.padEnd(12), String(v.n).padStart(6), y.toFixed(2).padStart(8) + '%', s(gb).padStart(11), s(gn).padStart(12))
}
db.close()
