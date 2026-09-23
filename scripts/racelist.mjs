// 公式サイトのHTML出走表から、番組表ファイル（Bファイル）に入っていない値を取る。
//
//   node scripts/racelist.mjs                     今日ぶん
//   node scripts/racelist.mjs --date 2026-09-23
//   node scripts/racelist.mjs --since 2026-09-01  その日から今日まで埋める
//   node scripts/racelist.mjs --check             1レースだけ取って、Bファイルと突き合わせて確かめる
//
// ★なぜ要るのか（2026-09-23）
//   公式の番組表ファイル（Bファイル）には **2連対率までしか入っていない**。
//   3連対率・公式の平均ST・F/L回数は、公式サイトのHTML出走表にしか無い。
//   日和や公式と同じ数字を出すには、こちらを取る必要がある。
//
// ★並び順は推測しない
//   1選手ぶんの塊の中に is-lineH2 のセルが5つ並ぶ。
//     [0] F回数 / L回数 / 平均ST
//     [1] 全国 勝率 / 2連対率 / 3連対率
//     [2] 当地 勝率 / 2連対率 / 3連対率
//     [3] モーター No / 2連対率 / 3連対率
//     [4] ボート  No / 2連対率 / 3連対率
//   取った「勝率・2連対率・モーターNo・ボートNo」が **Bファイルの値と一致するか毎回確かめて**、
//   合わないレースは保存しない。合わないまま入れると、誰も気づかないまま誤った数字が出る。
import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DBP = join(ROOT, 'data', 'boatrace.db')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jst = () => new Date(Date.now() + 9 * 3600e3)
const today = () => jst().toISOString().slice(0, 10)
const log = (...a) => console.log(jst().toISOString().slice(11, 16), ...a)

const db = new DatabaseSync(DBP)
// 直前情報の常駐（before.mjs --live）と書き込みがぶつかるので、空くまで待つ。
// 入れないと「database is locked」で途中で止まる（2026-09-23に実際に止まった）。
db.exec('PRAGMA busy_timeout = 60000')
// 後から足す列。すでにあれば何もしない
for (const c of ['top3_nat REAL', 'top3_loc REAL', 'motor_top3 REAL', 'boat_top3 REAL',
  'f_official INTEGER', 'l_official INTEGER', 'avg_st_official REAL'])
  try { db.exec(`ALTER TABLE programs ADD COLUMN ${c}`) } catch { /* もうある */ }

const num = (s) => { const v = Number(String(s).trim()); return Number.isFinite(v) ? v : null }

/** 1レースぶんのHTMLから、6人ぶんを取り出す。取れなければ null。 */
export function parseRacelist(html) {
  // 1選手ぶんの塊は「艇番のセル（is-boatColor1〜6 かつ rowspan）」から次の艇番まで
  const blocks = html.split(/<td class="is-boatColor[1-6] is-fs14" rowspan="4">/).slice(1)
  if (blocks.length !== 6) return null
  const out = []
  for (let i = 0; i < 6; i++) {
    const b = blocks[i]
    const toban = b.match(/toban=(\d+)/)?.[1]
    const cells = [...b.matchAll(/<td class="[^"]*is-lineH2[^"]*"[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].split(/<br\s*\/?>/).map((x) => x.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()))
    if (cells.length < 5 || !toban) return null
    const [fl, nat, loc, mot, boat] = cells
    out.push({
      lane: i + 1, racer_id: Number(toban),
      f_official: num((fl[0] ?? '').replace('F', '')), l_official: num((fl[1] ?? '').replace('L', '')),
      avg_st_official: num(fl[2]),
      win_rate_nat: num(nat[0]), top2_nat: num(nat[1]), top3_nat: num(nat[2]),
      win_rate_loc: num(loc[0]), top2_loc: num(loc[1]), top3_loc: num(loc[2]),
      motor_no: num(mot[0]), motor_top2: num(mot[1]), motor_top3: num(mot[2]),
      boat_no: num(boat[0]), boat_top2: num(boat[1]), boat_top3: num(boat[2]),
    })
  }
  return out
}

/** Bファイルの値と合っているか。
 *  選手と勝率・2連対率がずれたら読み方の誤り＝保存しない。
 *  モーターNo・ボートNoは **朝のあとで交換されることがある**ので、違っても誤りではない。
 *  （2026-09-23 びわこ11R：1号艇のボートが38→45。公式HTMLのほうが新しい）
 *  その場合は公式の値で上書きし、何が変わったかを表に出す。
 */
function agrees(rows, have) {
  const near = (a, b) => a == null || b == null || Math.abs(a - b) < 0.02
  const swaps = []
  for (const r of rows) {
    const h = have.find((x) => x.lane === r.lane)
    if (!h) return { bad: '番組表に無い艇番がある' }
    if (h.racer_id != null && r.racer_id !== h.racer_id) return { bad: `選手が違う（${r.lane}号艇）` }
    if (!near(r.win_rate_nat, h.win_rate_nat)) return { bad: `全国勝率が違う（${r.lane}号艇 ${r.win_rate_nat} と ${h.win_rate_nat}）` }
    if (!near(r.top2_nat, h.top2_nat)) return { bad: `全国2連率が違う（${r.lane}号艇）` }
    if (h.motor_no != null && r.motor_no != null && r.motor_no !== h.motor_no)
      swaps.push(`${r.lane}号艇のモーター ${h.motor_no}→${r.motor_no}`)
    if (h.boat_no != null && r.boat_no != null && r.boat_no !== h.boat_no)
      swaps.push(`${r.lane}号艇のボート ${h.boat_no}→${r.boat_no}`)
  }
  return { bad: null, swaps }
}

// モーター・ボートは交換されることがあるので、公式の新しい値で上書きする
const upd = db.prepare(`UPDATE programs SET top3_nat=?, top3_loc=?, motor_top3=?, boat_top3=?,
  f_official=?, l_official=?, avg_st_official=?, motor_no=?, motor_top2=?, boat_no=?, boat_top2=?
  WHERE race_id=? AND lane=?`)

async function fetchRace(raceId) {
  const ymd = raceId.slice(0, 8), jcd = raceId.slice(9, 11), rno = Number(raceId.slice(12, 14))
  const url = `https://www.boatrace.jp/owpc/pc/race/racelist?rno=${rno}&jcd=${jcd}&hd=${ymd}`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) return { err: `HTTP ${res.status}` }
  const rows = parseRacelist(await res.text())
  if (!rows) return { err: '読み取れない（公式の作りが変わった可能性）' }
  return { rows }
}

async function doDate(date) {
  const ymd = date.replaceAll('-', '')
  const ids = db.prepare(`SELECT DISTINCT race_id FROM programs
    WHERE substr(race_id,1,8)=? AND top3_nat IS NULL ORDER BY race_id`).all(ymd).map((r) => r.race_id)
  if (!ids.length) { log(`${date}: 取るものはありません`); return { ok: 0, ng: 0 } }
  let ok = 0, ng = 0
  for (const id of ids) {
    const have = db.prepare(`SELECT lane, racer_id, win_rate_nat, top2_nat, motor_no, boat_no FROM programs WHERE race_id=?`).all(id)
    const { rows, err } = await fetchRace(id)
    if (err) { ng++; if (ng <= 3) log(`  ${id}: ${err}`); await sleep(1200); continue }
    const { bad, swaps } = agrees(rows, have)
    if (bad) { ng++; log(`  ${id}: ${bad} → 保存しません`); await sleep(1200); continue }
    if (swaps?.length) log(`  ${id}: 交換あり（${swaps.join('・')}）`)
    for (const r of rows)
      upd.run(r.top3_nat, r.top3_loc, r.motor_top3, r.boat_top3, r.f_official, r.l_official, r.avg_st_official,
        r.motor_no, r.motor_top2, r.boat_no, r.boat_top2, id, r.lane)
    ok++
    if (ok % 20 === 0) log(`  ${date}: ${ok}/${ids.length}`)
    await sleep(1200)   // 公式へは同時1本・1秒以上あける
  }
  log(`${date}: ${ok}レース取得・${ng}レース取れず`)
  return { ok, ng }
}

if (has('--check')) {
  const id = db.prepare(`SELECT race_id FROM programs WHERE substr(race_id,1,8)=? ORDER BY race_id LIMIT 1`)
    .get(today().replaceAll('-', ''))?.race_id
  if (!id) { console.log('今日の番組表がまだありません'); process.exit(1) }
  const have = db.prepare(`SELECT lane, racer_id, win_rate_nat, top2_nat, motor_no, boat_no FROM programs WHERE race_id=?`).all(id)
  const { rows, err } = await fetchRace(id)
  if (err) { console.log('✗', err); process.exit(1) }
  const { bad, swaps } = agrees(rows, have)
  console.log(`${id}　番組表ファイルとの突き合わせ：${bad ? '✗ ' + bad : '✓ 一致'}`)
  if (swaps?.length) console.log(`　交換あり：${swaps.join('・')}（公式のほうが新しいので上書きします）`)
  console.log('艇 登番   全国 勝率/2率/3率     当地 勝率/2率/3率     モーター       ボート        F/L/平均ST')
  for (const r of rows)
    console.log(` ${r.lane} ${r.racer_id}  ${String(r.win_rate_nat).padStart(5)}/${String(r.top2_nat).padStart(6)}/${String(r.top3_nat).padStart(6)}` +
      `   ${String(r.win_rate_loc).padStart(5)}/${String(r.top2_loc).padStart(6)}/${String(r.top3_loc).padStart(6)}` +
      `   ${String(r.motor_no).padStart(3)} ${String(r.motor_top2).padStart(6)}/${String(r.motor_top3).padStart(6)}` +
      `  ${String(r.boat_no).padStart(3)} ${String(r.boat_top2).padStart(6)}/${String(r.boat_top3).padStart(6)}` +
      `   F${r.f_official} L${r.l_official} ${r.avg_st_official}`)
  db.close(); process.exit(bad ? 1 : 0)
}

const dates = []
if (val('--since')) {
  for (let d = val('--since'); d <= today(); ) {
    dates.push(d)
    const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); d = t.toISOString().slice(0, 10)
  }
} else dates.push(val('--date') ?? today())

let ok = 0, ng = 0
for (const d of dates) { const r = await doDate(d); ok += r.ok; ng += r.ng }
log(`合計 ${ok}レース取得・${ng}レース取れず`)
db.close()
