// 開催予定（公式の月間スケジュール）と、各開催の出場予定選手（あっせん）を集める。
//
//   node scripts/schedule.mjs            今月と来月の開催予定＋直近35日以内に始まる開催のあっせん
//   node scripts/schedule.mjs --stats
//
// ★なぜ要るか（2026-09-23）
//   公開サイトを日和と同じ構成にするため。日和の「開催予定」と、選手ページの「出場予定」にあたる。
//   番組表（Bファイル）は前日にならないと出ないので、先の予定はこれでしか分からない。
// ★取り方
//   月間スケジュール：https://www.boatrace.jp/owpc/pc/race/monthlyschedule?ym=YYYYMM
//     場ごとの行に、開催が colspan（日数）つきのセルで並ぶ。セルのリンク assen?jcd=..&hd=初日 が開催の鍵。
//     列の日付は見出しの「日」の並びから決める（前月末・翌月頭の日も並ぶので、1日をまたぐたびに月を進める）。
//   あっせん：https://www.boatrace.jp/owpc/pc/race/assen?jcd=..&hd=初日 の「出場予定レーサー一覧」
//   公式への負担を抑えるため、1ページずつ1秒あける。あっせんは3日に1回だけ取り直す。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jst = () => new Date(Date.now() + 9 * 3600e3)
const today = () => jst().toISOString().slice(0, 10)
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const GRADE = { Ippan: '一般', Venus: 'ヴィーナス', Lady: 'オールレディース', Takumi: 'マスターズ', Rookie: 'ルーキー', G1: 'G1', G2: 'G2', G3: 'G3', SG: 'SG' }

db.exec(`
  CREATE TABLE IF NOT EXISTS schedule (
    jcd INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT, days INTEGER,
    title TEXT, grade TEXT, fetched TEXT, PRIMARY KEY (jcd, start_date));
  CREATE TABLE IF NOT EXISTS assen (
    jcd INTEGER NOT NULL, start_date TEXT NOT NULL, racer_id INTEGER NOT NULL, name TEXT, class TEXT, fetched TEXT,
    PRIMARY KEY (jcd, start_date, racer_id));
  CREATE TABLE IF NOT EXISTS assen_fetch (jcd INTEGER NOT NULL, start_date TEXT NOT NULL, fetched TEXT, n INTEGER,
    PRIMARY KEY (jcd, start_date));
  CREATE INDEX IF NOT EXISTS idx_assen_racer ON assen(racer_id);
`)

if (argv.includes('--stats')) {
  console.log('開催予定', db.prepare(`SELECT COUNT(*) n, MIN(start_date) a, MAX(end_date) b FROM schedule`).get())
  console.log('あっせん', db.prepare(`SELECT COUNT(DISTINCT jcd||start_date) m, COUNT(*) n FROM assen`).get())
  db.close(); process.exit(0)
}

async function get(url) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25_000) })
      if (!r.ok) throw new Error(String(r.status))
      return await r.text()
    } catch (e) { if (a === 3) throw e; await sleep(3000 * a) }
  }
}

// ---------- 月間スケジュール ----------
function parseMonth(html, ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6))
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'))
  const dayNums = [...head.matchAll(/<th[^>]*>(\d{1,2})<br>/g)].map((x) => Number(x[1]))
  // 見出しの日付を実際の日付にする。最初が前月末なら月を1つ戻して始め、1日をまたぐたびに進める
  let cy = y, cm = dayNums[0] > 1 ? m - 1 : m
  if (cm < 1) { cm = 12; cy-- }
  const dates = []
  dayNums.forEach((d, i) => {
    if (i > 0 && d < dayNums[i - 1]) { cm++; if (cm > 12) { cm = 1; cy++ } }
    dates.push(`${cy}-${String(cm).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  })
  const out = []
  for (const tb of html.split('<tbody>').slice(1)) {
    const jm = tb.match(/stadium\?jcd=(\d{2})/)
    if (!jm) continue
    const jcd = Number(jm[1])
    let col = 0
    for (const td of tb.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
      const span = Number(td[1].match(/colspan\s*=\s*"(\d+)"/)?.[1] ?? 1)
      const a = td[2].match(/assen\?jcd=(\d{2})&(?:amp;)?hd=(\d{8})">([^<]*)</)
      if (a) {
        const g = td[1].match(/is-gradeColor(\w+)/)?.[1]
        const start = `${a[2].slice(0, 4)}-${a[2].slice(4, 6)}-${a[2].slice(6, 8)}`
        out.push({ jcd, start, end: dates[Math.min(col + span - 1, dates.length - 1)], days: span, title: a[3].trim(), grade: GRADE[g] ?? g ?? null })
      }
      col += span
    }
  }
  return out
}

// ---------- あっせん ----------
function parseAssen(html) {
  const out = []
  // ⚠ 'photoGallery3_body' で区切ると bodyNumber・bodyName でも切れて、番号と名前が別の塊になる。1人＝1つの <li>
  for (const li of html.split('<li>').slice(1)) {
    const id = li.match(/photoGallery3_bodyNumber">(\d+)</)?.[1]
    const name = li.match(/photoGallery3_bodyName">([^<]+)</)?.[1]
    const cls = li.match(/photoGallery3_bodyClass">[\s\S]*?<span>\s*([AB][12])/)?.[1]
    if (id) out.push({ racer_id: Number(id), name: (name ?? '').replace(/\s+/g, ' ').trim(), class: cls ?? null })
  }
  return out
}

const stamp = new Date().toISOString()
const d0 = today()
const months = [d0.slice(0, 7).replace('-', ''), addDays(d0.slice(0, 8) + '01', 40).slice(0, 7).replace('-', '')]
const upS = db.prepare(`INSERT INTO schedule (jcd,start_date,end_date,days,title,grade,fetched) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(jcd,start_date) DO UPDATE SET end_date=excluded.end_date, days=excluded.days, title=excluded.title,
  grade=excluded.grade, fetched=excluded.fetched`)
let nS = 0
for (const ym of months) {
  const list = parseMonth(await get(`https://www.boatrace.jp/owpc/pc/race/monthlyschedule?ym=${ym}`), ym)
  db.exec('BEGIN'); for (const x of list) { upS.run(x.jcd, x.start, x.end, x.days, x.title, x.grade, stamp); nS++ } db.exec('COMMIT')
  console.log(`${ym}: ${list.length}開催`)
  await sleep(1000)
}

// 直近35日以内に始まる開催（と、いま開催中のもの）のあっせんを、3日に1回取り直す
const targets = db.prepare(`SELECT s.jcd, s.start_date FROM schedule s
  LEFT JOIN assen_fetch f ON f.jcd=s.jcd AND f.start_date=s.start_date
  WHERE s.start_date <= ? AND s.end_date >= ? AND (f.fetched IS NULL OR f.fetched < ? OR f.n = 0)
  ORDER BY s.start_date`).all(addDays(d0, 35), d0, new Date(Date.now() - 3 * 86400e3).toISOString())
console.log(`あっせんを取る開催 ${targets.length}件`)
const delA = db.prepare(`DELETE FROM assen WHERE jcd=? AND start_date=?`)
const insA = db.prepare(`INSERT OR REPLACE INTO assen (jcd,start_date,racer_id,name,class,fetched) VALUES (?,?,?,?,?,?)`)
const insF = db.prepare(`INSERT OR REPLACE INTO assen_fetch (jcd,start_date,fetched,n) VALUES (?,?,?,?)`)
let nA = 0
for (const t of targets) {
  try {
    const list = parseAssen(await get(`https://www.boatrace.jp/owpc/pc/race/assen?jcd=${String(t.jcd).padStart(2, '0')}&hd=${t.start_date.replace(/-/g, '')}`))
    db.exec('BEGIN')
    if (list.length) delA.run(t.jcd, t.start_date)   // 取れたときだけ入れ替える（空振りで消さない）
    for (const r of list) insA.run(t.jcd, t.start_date, r.racer_id, r.name, r.class, stamp)
    insF.run(t.jcd, t.start_date, stamp, list.length)
    db.exec('COMMIT')
    nA += list.length
  } catch (e) { console.log(`  取れなかった ${t.jcd} ${t.start_date}: ${e.message}`) }
  await sleep(1000)
}
console.log(`完了：開催予定 ${nS}件・あっせん ${targets.length}開催 ${nA}人`)
db.close()
