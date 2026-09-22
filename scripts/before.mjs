// 公式の直前情報を取得して蓄積する。
//
//   node scripts/before.mjs --from 2025-08-18 --to 2026-08-18
//   node scripts/before.mjs --stats
//
// ★取れるもの（KファイルにもBファイルにも無い）
//   チルト角／部品交換／調整重量／体重／ST展示の進入とST／気温・水温
//   チルト角と部品交換は「その節で機力をどう調整したか」を示す。
//   番組表のモーター2連率は前使用者を含む累計なので、当節の調整意図は分からない。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 180000')
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DELAY = Number(flag('delay', 250))
const CONC = Number(flag('conc', 3))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

db.exec(`
  CREATE TABLE IF NOT EXISTS before_info (
    race_id     TEXT NOT NULL,
    lane        INTEGER NOT NULL,
    tilt        REAL,
    parts       TEXT,
    weight      REAL,
    adj_weight  REAL,
    ex_time     REAL,
    ex_course   INTEGER,
    ex_st       REAL,
    ex_st_flag  TEXT,
    PRIMARY KEY (race_id, lane)
  );
  CREATE TABLE IF NOT EXISTS before_race (
    race_id   TEXT PRIMARY KEY,
    air_temp  REAL,
    water_temp REAL,
    fetched   TEXT,
    status    TEXT
  );
`)
// ★後から足した列（2026-09-22）：水面気象
for (const c of ['weather TEXT', 'wind_speed REAL', 'wind_dir INTEGER', 'wave REAL'])
  try { db.exec('ALTER TABLE before_race ADD COLUMN ' + c) } catch { /* すでにある */ }

if (argv.includes('--stats')) {
  const t = one(`SELECT COUNT(*) c FROM before_race WHERE status='ok'`)
  const total = one(`SELECT COUNT(*) c FROM races`).c
  console.log('=== 直前情報の収集状況 ===')
  console.log(`  取得済み ${t.c} / ${total} レース (${((t.c / total) * 100).toFixed(1)}%)`)
  console.log(`  before_info 行数: ${one('SELECT COUNT(*) c FROM before_info').c.toLocaleString()}`)
  const r = one(`SELECT MIN(r.date) a, MAX(r.date) b FROM before_race f JOIN races r ON r.race_id=f.race_id WHERE f.status='ok'`)
  console.log(`  期間: ${r?.a ?? '-'} 〜 ${r?.b ?? '-'}`)
  db.close(); process.exit(0)
}

const LIVE = argv.includes('--live')
const from = flag('from'), to = flag('to')
if (!LIVE && (!from || !to)) { console.error('--from --to が必要（当日のレース前に集めるなら --live）'); process.exit(1) }

// --refetch … 取得済みでも「展示の進入コース」が入っていないレースを取り直す。
//   2026-08まで集めた分は ex_course / ex_st を拾っていなかったため、
//   status='ok' でも中身が足りない。空振り（status='empty'）だけは再取得しない。
const REFETCH = argv.includes('--refetch')
//   --need … 展示の進入か調整重量のどちらかが欠けているレースを取り直す（両方を一度に埋める）
const NEED = argv.includes('--need')
const targets = LIVE ? [] : all(NEED ? `
  SELECT r.race_id, r.jcd, r.race_no, r.date FROM races r
  WHERE r.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM before_race f WHERE f.race_id=r.race_id AND f.status='empty')
    AND NOT EXISTS (SELECT 1 FROM before_info b WHERE b.race_id=r.race_id
                    AND b.ex_course IS NOT NULL AND b.adj_weight IS NOT NULL)
  ORDER BY r.date DESC, r.jcd, r.race_no` : REFETCH ? `
  SELECT r.race_id, r.jcd, r.race_no, r.date FROM races r
  WHERE r.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM before_info b WHERE b.race_id=r.race_id AND b.ex_course IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM before_race f WHERE f.race_id=r.race_id AND f.status='empty')
  ORDER BY r.date DESC, r.jcd, r.race_no` : `
  SELECT r.race_id, r.jcd, r.race_no, r.date FROM races r
  WHERE r.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM before_race f WHERE f.race_id=r.race_id AND f.status IN ('ok','empty'))
  ORDER BY r.date DESC, r.jcd, r.race_no`, from, to)

if (!LIVE) console.log(`=== 直前情報の収集 ${from} 〜 ${to} ===`)
if (!LIVE) console.log(`対象 ${targets.length.toLocaleString()} レース  間隔${DELAY}ms  推定 ${(targets.length * DELAY / 3600000).toFixed(1)}時間\n`)

const strip = (h) => h.replace(/<[^>]*>/g, '\t').replace(/&nbsp;/g, ' ').replace(/\t+/g, '\t')

/**
 * 各艇の行は tbody 単位で、セルの並びが固定されている（実測）：
 *   [0]艇番 [1]写真 [2]選手名 [3]体重 [4]展示タイム [5]チルト [6]プロペラ [7]部品交換
 * ⚠️ 「38〜70の数値を体重とみなす」のような範囲推測で書くと、
 *    展示6.82を6.0と読むなどの誤りが出る。KファイルやBファイルと同じく**位置で取る**こと。
 */
function parseBefore(html) {
  const tb = html.match(/<tbody[\s\S]*?<\/tbody>/g) ?? []
  const boats = []
  for (const t of tb) {
    const cells = [...t.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]).replace(/\s+/g, ' ').trim())
    if (cells.length < 8) continue
    const lane = Number(cells[0])
    if (!(lane >= 1 && lane <= 6)) continue
    const num = (s) => { const m = String(s ?? '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null }
    boats.push({
      lane,
      weight: num(cells[3]),
      ex_time: num(cells[4]),
      tilt: num(cells[5]),
      parts: cells[7] && /[^\s]/.test(cells[7]) ? cells[7] : null,
      // 調整重量はセル12。1艇ぶんの tbody に4行入っていて、td を並べると
      //   [3]体重 [4]展示 [5]チルト [6]プロペラ [7]部品交換 [8]前走成績 [10]進入 [12]調整重量 [13]ST
      // となる。0〜8kg の範囲外は取り違えとみなして捨てる。
      adj_weight: (() => { const v = num(cells[12]); return v != null && v >= 0 && v <= 8 ? v : null })(),
    })
  }
  if (boats.length !== 6) return null
  if (new Set(boats.map((b) => b.lane)).size !== 6) return null
  const temps = [...html.matchAll(/([\d.]+)℃/g)].map((m) => Number(m[1]))
  // ★水面気象（2026-09-22に追加）。天候・風速・風向・波高。
  //   欄は class で見分ける（is-weather / is-wind / is-windDirection / is-wave）。並び順では取らない。
  //   風向は画像の番号（is-wind1〜16・17は無風）で、公式の図のままの番号を保存する。
  const wx = (() => {
    const i = html.indexOf('weather1_body')
    if (i < 0) return {}
    const seg = html.slice(i, i + 5000)
    const pick = (cls, part) => {
      const m = seg.match(new RegExp('weather1_bodyUnit ' + cls + '"[\\s\\S]*?weather1_bodyUnitLabel' + part + '">([^<]*)<'))
      return m ? m[1].trim() : null
    }
    const n = (s) => { const m = String(s ?? '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null }
    const dir = seg.match(/is-windDirection">\s*<p class="weather1_bodyUnitImage is-wind(\d+)"/)
    return { weather: pick('is-weather', 'Title'), wind_speed: n(pick('is-wind', 'Data')),
      wind_dir: dir ? Number(dir[1]) : null, wave: n(pick('is-wave', 'Data')) }
  })()
  // ★スタート展示（進入コースと展示ST）を足す
  const st = parseStart(html)
  if (st) for (const b of boats) {
    const s = st.get(b.lane)
    if (s) { b.ex_course = s.course; b.ex_st = s.st; b.ex_st_flag = s.flag }
  }
  return { boats, air: temps[0] ?? null, water: temps[1] ?? null, ...wx,
    // 展示が終わっているか（6艇とも展示タイムがある）。当日モードで取り直すかの判断に使う
    complete: boats.every((b) => b.ex_time != null) }
}

/**
 * スタート展示の枠。行の並びがそのまま進入コース（上から1コース、2コース…）で、
 * 各行に艇番と展示STが入っている。
 *   <span class="table1_boatImage1Number is-type4">4</span> … 4号艇
 *   <span class="table1_boatImage1Time">.02</span>          … 展示ST 0.02
 * F（フライング）は "F.01"、L（出遅れ）は "L" で出るので印を分けて持つ。
 *
 * ⚠️ 「艇番の順に並んでいる」と思って読むと前づけのあるレースで全部ずれる。
 *    上から順＝進入コース、中の数字＝艇番、である点を取り違えないこと。
 */
function parseStart(html) {
  const i = html.indexOf('スタート展示')
  if (i < 0) return null
  const seg = html.slice(i)
  const e = seg.indexOf('</tbody>')
  const body = e > 0 ? seg.slice(0, e) : seg.slice(0, 6000)
  const out = new Map()
  const blocks = body.split('table1_boatImage1"').slice(1)
  let course = 0
  for (const b of blocks) {
    const mL = b.match(/table1_boatImage1Number[^>]*>\s*([1-6])\s*</)
    if (!mL) continue
    course++
    const mT = b.match(/table1_boatImage1Time[^>]*>\s*([^<]*)</)
    let st = null, flag = null
    if (mT) {
      const raw = mT[1].trim()
      if (/^F/.test(raw)) flag = 'F'
      else if (/^L/.test(raw)) flag = 'L'
      const mn = raw.match(/\.\d+/)
      if (mn) st = Number('0' + mn[0])
    }
    out.set(Number(mL[1]), { course, st, flag })
  }
  return out.size ? out : null
}

const insB = db.prepare(`INSERT INTO before_info (race_id,lane,tilt,parts,weight,ex_time,ex_course,ex_st,ex_st_flag,adj_weight)
  VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(race_id,lane) DO UPDATE SET
  tilt=excluded.tilt, parts=excluded.parts, weight=excluded.weight, ex_time=excluded.ex_time,
  ex_course=excluded.ex_course, ex_st=excluded.ex_st, ex_st_flag=excluded.ex_st_flag, adj_weight=excluded.adj_weight`)
const insR0 = db.prepare(`INSERT INTO before_race (race_id,air_temp,water_temp,weather,wind_speed,wind_dir,wave,fetched,status)
  VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(race_id) DO UPDATE SET
  air_temp=excluded.air_temp, water_temp=excluded.water_temp, weather=excluded.weather, wind_speed=excluded.wind_speed,
  wind_dir=excluded.wind_dir, wave=excluded.wave, fetched=excluded.fetched, status=excluded.status`)
const insR = { run: (id, air, water, stamp, status, p = {}) =>
  insR0.run(id, air, water, p.weather ?? null, p.wind_speed ?? null, p.wind_dir ?? null, p.wave ?? null, stamp, status) }

// ★当日モード（2026-09-22に追加）
//   node scripts/before.mjs --live            今日のレースの直前情報を、締切前に集め続ける
//   node scripts/before.mjs --live --date 2026-09-22
// なぜ要るか：直前情報はこれまで翌日にまとめて取っていたので、サイトで「レース前に」見せられなかった。
// 動き：1分ごとに、締切まで20分を切ったレースの公式直前情報ページを取る。
//   展示が終わっていなければ（展示タイムが揃っていなければ）数分おきに取り直し、揃ったら終わり。
//   締切を過ぎたレースはもう取らない。公式サイトへの負担を抑えるため同時1本・1秒以上あける。
if (LIVE) {
  const jst = () => new Date(Date.now() + 9 * 3600e3)
  // --date を付けなければ日付は毎回その時点の今日。常駐させて日をまたいでも動き続ける（watchdog が見張る）
  const FIXED = flag('date')
  let DAY = FIXED ?? jst().toISOString().slice(0, 10)
  const hm = () => jst().toISOString().slice(11, 16)
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const last = new Map()   // race_id → 最後に取った時刻(ms)
  const done = new Set()
  for (const r of all(`SELECT race_id FROM before_race f WHERE status='ok' AND race_id LIKE ?
      AND EXISTS (SELECT 1 FROM before_info b WHERE b.race_id=f.race_id AND b.ex_time IS NOT NULL)`, DAY.replace(/-/g, '') + '%'))
    done.add(r.race_id)
  console.log(`=== 直前情報（当日モード）${DAY}　すでに揃っている ${done.size}レース ===`)
  let got = 0
  for (;;) {
    if (!FIXED && jst().toISOString().slice(0, 10) !== DAY) {
      DAY = jst().toISOString().slice(0, 10); last.clear(); done.clear()
      console.log(`=== 日付が変わった → ${DAY} ===`)
    }
    const races = all(`SELECT race_id, jcd, race_no, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL ORDER BY deadline`, DAY)
    if (!races.length) {
      if (FIXED) { console.log('race_meta にその日のレースがありません'); break }
      await sleep(15 * 60_000); continue   // 番組表が入るまで待つ（02:00の処理で入る）
    }
    const now = mins(hm())
    const open = races.filter((r) => mins(r.deadline) >= now)
    if (!open.length) {
      if (FIXED) { console.log(`${hm()} 全レース締切。終了（取得 ${got}件）`); break }
      if (got) console.log(`${hm()} 本日の全レース締切（取得 ${got}件）。翌日まで待つ`)
      got = 0
      await sleep(30 * 60_000); continue
    }
    const due = open.filter((r) => !done.has(r.race_id) && mins(r.deadline) - now <= 20
      && Date.now() - (last.get(r.race_id) ?? 0) >= (mins(r.deadline) - now <= 8 ? 90_000 : 240_000))
    for (const r of due) {
      last.set(r.race_id, Date.now())
      const g = await fetchOne({ race_id: r.race_id, jcd: r.jcd, race_no: r.race_no, date: DAY })
      if (g.status === 'ok') {
        for (let a = 1; ; a++) {
          try {
            db.exec('BEGIN IMMEDIATE')
            for (const b of g.parsed.boats)
              insB.run(r.race_id, b.lane, b.tilt, b.parts, b.weight, b.ex_time,
                b.ex_course ?? null, b.ex_st ?? null, b.ex_st_flag ?? null, b.adj_weight ?? null)
            insR.run(r.race_id, g.parsed.air, g.parsed.water, new Date().toISOString(), g.parsed.complete ? 'ok' : 'partial', g.parsed)
            db.exec('COMMIT'); break
          } catch (e) { try { db.exec('ROLLBACK') } catch {} ; await sleep(Math.min(20_000, 1_000 * a)) }
        }
        got++
        if (g.parsed.complete) done.add(r.race_id)
        console.log(`${hm()} ${r.race_id}（締切${r.deadline}）${g.parsed.complete ? '展示まで揃った' : '展示待ち'}` +
          `  風${g.parsed.wind_speed ?? '-'}m 波${g.parsed.wave ?? '-'}cm`)
      }
      await sleep(Math.max(1000, DELAY))
    }
    // 次のレースまで間があれば長めに待つ
    const next = open.find((r) => !done.has(r.race_id))
    const wait = next ? Math.max(0, mins(next.deadline) - now - 20) : 60
    await sleep(Math.min(Math.max(60, wait * 60), 900) * 1000)
  }
  db.close(); process.exit(0)
}

let ok = 0, empty = 0, err = 0
const buf = []
const stamp = new Date().toISOString()
const t0 = Date.now()
async function fetchOne(t) {
  const url = `https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${t.race_no}&jcd=${String(t.jcd).padStart(2, '0')}&hd=${t.date.replace(/-/g, '')}`
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })
      if (!res.ok) throw new Error(String(res.status))
      const parsed = parseBefore(await res.text())
      return { t, parsed, status: parsed ? 'ok' : 'empty' }
    } catch { if (a === 3) return { t, parsed: null, status: 'error' }; await sleep(DELAY * a * 3) }
  }
}
for (let i = 0; i < targets.length; i += CONC) {
  const got = await Promise.all(targets.slice(i, i + CONC).map((t) => fetchOne(t)))
  for (const g of got) { buf.push(g); g.status === 'ok' ? ok++ : g.status === 'empty' ? empty++ : err++ }
  const i2 = Math.min(i + CONC, targets.length) - 1

  // ★書き込みはまとめて行う。1レースずつ COMMIT すると
  //   別プロセス（オッズ収集）とのロック競合で1件10秒かかっていた。
  if (buf.length >= 60 || i2 === targets.length - 1) {
    // ★ロックで落ちないようにする。
    //   学習（walk.mjs）が長い書き込みを持っていると busy_timeout を超えて
    //   "database is locked" で**プロセスごと死ぬ**。42.8%地点で1度落とした（2026-08-27）。
    //   何時間も走らせる処理なので、待って何度でも やり直す。
    for (let a = 1; ; a++) {
      try {
        db.exec('BEGIN IMMEDIATE')
        for (const x of buf) {
          if (x.status === 'ok') {
            for (const b of x.parsed.boats)
              insB.run(x.t.race_id, b.lane, b.tilt, b.parts, b.weight, b.ex_time,
                b.ex_course ?? null, b.ex_st ?? null, b.ex_st_flag ?? null, b.adj_weight ?? null)
            insR.run(x.t.race_id, x.parsed.air, x.parsed.water, stamp, 'ok', x.parsed)
          } else insR.run(x.t.race_id, null, null, stamp, x.status)
        }
        db.exec('COMMIT')
        break
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        if (a % 10 === 1) console.log(`  書き込み待ち ${a}回目（${e.message}）`)
        await sleep(Math.min(30_000, 2_000 * a))
      }
    }
    buf.length = 0
  }

  if ((i2 + 1) % 300 < CONC || i2 === targets.length - 1) {
    const done = i2 + 1, el = (Date.now() - t0) / 1000
    console.log(`[${((done / targets.length) * 100).toFixed(1)}%] ${done}/${targets.length}  ok${ok} 空${empty} 失敗${err}  ${(el / done).toFixed(2)}秒/件  残り約${(((targets.length - done) * (el / done)) / 3600).toFixed(1)}時間`)
  }
  await sleep(DELAY)
}
console.log(`\n完了: ok ${ok} / 空 ${empty} / 失敗 ${err}`)
db.close()
