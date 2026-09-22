// 当日のレース情報（締切・レース名・何日目・開催名・開催の総日数）を、予想の時点で揃える。
//
//   node scripts/racemeta.mjs --date 2026-09-14     取って表示（DBの race_meta にも保存）
//
// ★なぜ要るか（2026-09-14に判明した学習と本番の食い違い）
//   モデルは「条件補正」9種類を使う。学習(model5.mjs)は競走成績(Kファイル)の実際の値で作るが、
//   予想(predict.mjs)は当日の成績がまだ無いので、そのうち5種類を**固定値**で渡していた。
//     締切の時間帯 hour ……… 常に「不明」→ 0
//     総日数 len / 残り日数 left / 総日数×何日目 lenday … 常に「不明」→ 0
//     レースの格 title ……… 全レース「予選」（9/13は180レース中79レースが予選以外）
//   その結果、同じモデル・同じ9/13のレースで
//     学習側：配信の対象14R・無料枠22本  ／  本番の予想：配信32R・無料枠18本・本命の一致161/180
//   と大きく食い違っていた。旧モデルの頃からあった。検証した数字が本番に当てはまっていなかった。
//
// ★どこから取るか
//   番組表(Bファイル data/extracted/B/Byymmdd.TXT) … レース名・締切・何日目・開催名
//     9/13で競走成績と突き合わせ：締切180/180・何日目180/180・レース名176/180（残り4は空白の数だけ違う）
//     02:00の時点で手元にあり、通信が要らない。
//   公式の出走一覧ページ(raceindex) ……………………… 開催の総日数（初日〜最終日の数）
//     番組表には総日数が書かれていない。成績側の MAX(day_no) は開催途中だと昨日までしか分からない。
//     場ごとに1回だけ取る。順延・中止の日は数えない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// ⚠ import.meta.url は日本語パスを%エンコードするので fileURLToPath を通すこと
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const z2h = (s) => String(s ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/：/g, ':')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 番組表から。Map<race_id, {jcd, race_no, title, deadline, day_no, series}> */
export function parseB(date) {
  const f = join(ROOT, 'data', 'extracted', 'B', `B${date.replace(/-/g, '').slice(2)}.TXT`)
  const out = new Map()
  if (!existsSync(f)) return out
  const L = new TextDecoder('shift_jis').decode(readFileSync(f)).split(/\r?\n/)
  const ymd = date.replace(/-/g, '')
  let jcd = null, day = null, series = null, wantSeries = false
  for (const l of L) {
    const g = l.match(/^(\d{2})BBGN/)
    if (g) { jcd = g[1]; day = null; series = null; wantSeries = false; continue }
    if (!jcd) continue
    if (l.includes('番組表')) { wantSeries = true; continue }
    if (wantSeries && l.trim()) { series = l.trim(); wantSeries = false; continue }
    const d = l.match(/第\s*([０-９\d]+)\s*日/)
    if (d && day == null) day = Number(z2h(d[1]))
    const r = l.match(/^\s*([０-９\d]{1,2})Ｒ\s+(.+?)\s+Ｈ[０-９\d]+ｍ\s+電話投票締切予定([０-９\d]{1,2}：[０-９\d]{2})/)
    if (r) {
      const rno = Number(z2h(r[1]))
      out.set(`${ymd}-${jcd}-${String(rno).padStart(2, '0')}`, {
        jcd: Number(jcd), race_no: rno, title: r[2].trim(),
        deadline: z2h(r[3]).padStart(5, '0'), day_no: day, series,
      })
    }
  }
  return out
}

/** 出走一覧ページの日程から開催の総日数。Map<jcd, 総日数> */
export async function seriesLen(date, jcds) {
  const out = new Map()
  const ymd = date.replace(/-/g, '')
  for (const j of jcds) {
    try {
      const h = await (await fetch(`https://www.boatrace.jp/owpc/pc/race/raceindex?jcd=${String(j).padStart(2, '0')}&hd=${ymd}`,
        { signal: AbortSignal.timeout(20_000) })).text()
      // ⚠ 「レース一覧」はページ上部のメニューにも出てくる。contentsFrame より後ろで探すこと
      //   （最初は前から探して切り出し範囲が空になり、全場の総日数が「不明」になった）。
      const a = h.indexOf('contentsFrame')
      const b = h.indexOf('レース一覧', a)
      const body = h.slice(a, b > a ? b : undefined)
      const t = body.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, '|').split('|').map((s) => s.trim()).filter(Boolean)
      let n = 0
      for (let i = 0; i < t.length - 1; i++) {
        if (!/^\d{1,2}月\d{1,2}日$/.test(t[i])) continue
        const lab = z2h(t[i + 1])
        if (lab === '初日' || lab === '最終日' || /^\d+日目$/.test(lab)) n++   // 順延・中止は数えない
      }
      if (n) out.set(Number(j), n)
    } catch { /* 取れなければ「不明」のまま */ }
    await sleep(250)
  }
  return out
}

/** 予想で使う形にそろえる。DBの race_meta に保存し、2回目以降はそこから返す。 */
export async function ensureMeta(date, { refresh = false } = {}) {
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  db.exec('PRAGMA busy_timeout = 300000')
  db.exec(`CREATE TABLE IF NOT EXISTS race_meta (
    race_id TEXT PRIMARY KEY, date TEXT, jcd INTEGER, race_no INTEGER, deadline TEXT, title TEXT,
    day_no INTEGER, series TEXT, series_len INTEGER, updated_at TEXT)`)
  const M = new Map()
  try {
    const have = db.prepare(`SELECT * FROM race_meta WHERE date = ?`).all(date)
    if (have.length && !refresh && have.every((r) => r.series_len != null)) {
      for (const r of have) M.set(r.race_id, { deadline: r.deadline, title: r.title, day_no: r.day_no, series: r.series, len: r.series_len })
      return M
    }
    const B = parseB(date)
    if (!B.size) return M
    const lens = await seriesLen(date, [...new Set([...B.values()].map((x) => x.jcd))])
    const ins = db.prepare(`INSERT OR REPLACE INTO race_meta VALUES (?,?,?,?,?,?,?,?,?,?)`)
    const now = new Date().toISOString()
    db.exec('BEGIN')
    for (const [id, x] of B) {
      const len = lens.get(x.jcd) ?? null
      ins.run(id, date, x.jcd, x.race_no, x.deadline, x.title, x.day_no, x.series, len, now)
      M.set(id, { deadline: x.deadline, title: x.title, day_no: x.day_no, series: x.series, len })
    }
    db.exec('COMMIT')
    return M
  } finally { db.close() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--date')
  const date = i > -1 ? process.argv[i + 1] : null
  if (!date) { console.log('使い方: node scripts/racemeta.mjs --date 2026-09-14'); process.exit(1) }
  const M = await ensureMeta(date, { refresh: process.argv.includes('--refresh') })
  const byJ = new Map()
  for (const [id, x] of M) { const j = id.slice(9, 11); if (!byJ.has(j)) byJ.set(j, x) }
  console.log(`${date}  ${M.size}レース / ${byJ.size}場`)
  for (const [j, x] of byJ) console.log(`  jcd${j}  ${x.series}  第${x.day_no}日/全${x.len ?? '?'}日`)
}
