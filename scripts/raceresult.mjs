// 公式のレース結果ページから、その日のうちに着順と払戻を取る。
//
//   node scripts/raceresult.mjs --date 2026-08-31             未取得のレースを取る
//   node scripts/raceresult.mjs --date 2026-08-31 --race 20260831-23-01
//
// ★なぜ要るか
//   競走成績（Kファイル）は翌日にならないと出ない。night.sh の照合はそれ待ちなので、
//   当日は「当たったかどうか」が分からなかった。ここで公式の結果ページを直接見る。
//
// ★入れ先は payouts / entries ではない
//   あの2つはKファイル由来で、点時点を守る作りの土台になっている。
//   当日取りの値を混ぜると、あとで「いつの情報か」が分からなくなる。
//   別テーブル result_live に入れ、翌日Kファイルが来たらそちらが正になる。
//
// ★中止・失格
//   3着までが埋まらないレースは status='partial' として残す。消さない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DATE = flag('date') || new Date().toISOString().slice(0, 10)
const CONC = Number(flag('conc', '4'))
const DELAY = Number(flag('delay', '250'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

db.exec(`
  CREATE TABLE IF NOT EXISTS result_live (
    race_id TEXT PRIMARY KEY, date TEXT, jcd INTEGER, race_no INTEGER,
    lane1 INTEGER, lane2 INTEGER, lane3 INTEGER,
    sanrentan TEXT, sanrentan_pay REAL,
    sanrenpuku TEXT, sanrenpuku_pay REAL,
    tansho TEXT, tansho_pay REAL,
    status TEXT, fetched_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rl_date ON result_live(date);
`)

// ---------- 解析 ----------
// 着順表は各行が「着（全角数字）」＋「is-boatColorN」。ページ内で is-boatColor はここにしか出ない。
// ★2026-09-23に足した列：決まり手・6着までの並び・全券種の払戻（JSON）。公開サイトの「結果」に使う
for (const c of ['kimarite TEXT', 'order_all TEXT', 'pays TEXT'])
  try { db.exec('ALTER TABLE result_live ADD COLUMN ' + c) } catch { /* すでにある */ }
const ZEN = '１２３４５６'
export function parseResult(html) {
  const order = []
  const re = /is-fs14">\s*([１-６])\s*<\/td>\s*<td[^>]*is-boatColor(\d)[^>]*>/g
  let m
  while ((m = re.exec(html))) order[ZEN.indexOf(m[1])] = Number(m[2])
  // 払戻。<td rowspan="2">3連単</td> … numberSet1_row … is-payout1">&yen;1,370
  // ⚠ 区切りを切らずに前から一定文字数だけ見ると、次の券種の数字まで拾う。
  //   最初にそれをやって 3連単の組番が "1=5=3=1=3=5" になった。
  //   券種の見出しは rowspan="2" で順に並ぶので、次の見出しまでで切る。
  //   組番は最初の numberSet1_row だけ見る（2行目は同着用の空の予備行）。
  const pay = {}
  const KINDS = ['3連単', '3連複', '2連単', '2連複', '拡連複', '単勝', '複勝']
  const at = KINDS.map((k) => [k, html.indexOf(`rowspan="2">${k}<`)]).filter(([, i]) => i >= 0)
    .sort((a, b) => a[1] - b[1])
  for (let n = 0; n < at.length; n++) {
    const [kind, i] = at[n]
    const seg = html.slice(i, n + 1 < at.length ? at[n + 1][1] : i + 4000)
    const row = seg.match(/numberSet1_row[^>]*>([\s\S]*?)<\/div>/)
    if (!row) continue
    const nums = [...row[1].matchAll(/numberSet1_number[^>]*>(\d)</g)].map((x) => x[1])
    const sep = row[1].includes('numberSet1_text">=') ? '=' : '-'
    const a = seg.match(/is-payout1">&yen;([\d,]+)</)
    if (!nums.length || !a) continue
    // 区切りは payouts テーブルに揃えて '-' に統一する（あちらは 3連複も "1-2-5"）。
    // 画面で "=" にしたいときは出す側で置き換える。
    pay[kind] = { combo: nums.join('-'), sep, amount: Number(a[1].replace(/,/g, '')) }
  }
  // 決まり手：<th>決まり手</th> の表の次の <td class="is-fs16">逃げ</td>
  const km = html.match(/<th>決まり手<\/th>[\s\S]{0,300}?<td class="is-fs16">([^<]+)</)
  return { order, pay, kimarite: km ? km[1].trim() : null }
}

if (argv.includes('--selftest')) {   // 解析だけ確かめる
  const { readFileSync } = await import('node:fs')
  const r = parseResult(readFileSync(flag('file'), 'utf8'))
  console.log(JSON.stringify(r, null, 1)); process.exit(0)
}

// ---------- 対象を決める ----------
// その日に何かを記録した全テーブルを対象にする。
// 締切を過ぎたものだけ。まだ走っていないレースを叩いても無駄。
//
// ⚠ 2026-09-06まで haishin_daily と bets しか見ていなかった。
//   配信(haishin)と無料枠(tansho)と企画枠(spot)は**選ぶレースが違う**ので、
//   haishin に無いレースは当日ずっと「結果なし」のままだった
//   （その日の spot 48点・tansho 11点が丸ごと未照合で残っていた）。
//   記録するテーブルを増やしたら、必ずここにも足すこと。
// ★「締切を過ぎたものだけ」の絞りは**当日のときだけ**掛ける。
//   過去日を指定したときに掛けると、いま03:06なら12時締切のレースが全部外れて
//   「取るものなし」になる。2026-09-10に遡って埋めようとして実際にそうなった。
// ⚠ toISOString() は UTC。日本時間の 00:00〜09:00 は UTC だと前日なので、
//   これで「今日かどうか」を判定すると深夜に必ず狂う（2026-09-10 の 03:07 に実際にやった）。
const _d = new Date()
const TODAY = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`
const now = DATE === TODAY ? new Date().toTimeString().slice(0, 5) : '23:59'
const ONE = flag('race')
const SRC = ['haishin_daily', 'tansho_daily', 'spot_daily']
  .filter((t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t))
// ★2026-09-23：公開サイト（日和と同じ構成）で「全レースの当日結果」を出すため、番組表の全レースも対象にした。
//   それまでは予想を記録したレースだけで、残りは翌日の競走成績まで空だった。
//   15分おきに「締切を過ぎて、まだ結果の無いレース」だけを取るので、1回あたり十数ページ程度。
const HAS_META = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='race_meta'`).get()
const union = SRC.map((t) => `SELECT DISTINCT race_id, date, race_no, deadline FROM ${t} WHERE date=?`)
  .concat([`SELECT DISTINCT race_id, date, race_no, deadline FROM bets WHERE date=? AND decision='buy'`])
  .concat(HAS_META ? [`SELECT race_id, date, race_no, deadline FROM race_meta WHERE date=?`] : [])
  .join(' UNION ')
const params = [...SRC.map(() => DATE), DATE, ...(HAS_META ? [DATE] : [])]
const targets = ONE
  ? db.prepare(`SELECT DISTINCT race_id, date, race_no FROM ${SRC[0] ?? 'haishin_daily'} WHERE race_id=?`).all(ONE)
  : db.prepare(`
      SELECT race_id, date, race_no, deadline FROM (${union})
      WHERE race_id NOT IN (SELECT race_id FROM result_live WHERE status='cancel' OR (status='ok' AND kimarite IS NOT NULL))
        AND (deadline IS NULL OR deadline <= ?)
      ORDER BY deadline`).all(...params, now)
if (!targets.length) { console.log(`${DATE} ${now} 取るものなし`); db.close(); process.exit(0) }
console.log(`${DATE} ${now}　対象 ${targets.length}レース`)

const url = (t) => {
  const [hd, jcd, rno] = t.race_id.split('-')
  return `https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${Number(rno)}&jcd=${jcd}&hd=${hd}`
}
// ★その日が「順延」「中止」なら、そのレースは**走らない**＝結果は永久に出ない。
//   公式ページの日程欄が「9月9日／順延」のようになる（開催中の日は「５日目」等）。
//   これを見ずにいたので、2026-09-09の江戸川11Rが1時間経っても「結果待ち」のまま残った。
//   過去にも 2026-08-30(5R)・2026-09-04(4R) が未照合のまま放置されていた。
//   ⚠ 日程欄には他の日付も並ぶので、**対象日の行だけ**を見ること。
const dayOff = (h, date) => {
  const [, m, d] = date.split('-').map(Number)
  const body = h.slice(h.indexOf('contentsFrame'))
    .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, '\n')
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const i = body.indexOf(`${m}月${d}日`)
  if (i < 0) return null
  const label = body[i + 1] ?? ''
  return /順延|中止/.test(label) ? label : null
}
async function get(t) {
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url(t), { signal: AbortSignal.timeout(25_000) })
      if (!res.ok) throw new Error(String(res.status))
      const h = await res.text()
      if (h.includes('データがありません')) return { none: true }
      const off = dayOff(h, t.date ?? DATE)
      if (off) return { cancelled: off }
      return parseResult(h)
    } catch { if (a === 3) return undefined; await sleep(DELAY * a * 3) }
  }
}
const ins0 = db.prepare(`INSERT OR REPLACE INTO result_live (race_id,date,jcd,race_no,lane1,lane2,lane3,sanrentan,sanrentan_pay,
  sanrenpuku,sanrenpuku_pay,tansho,tansho_pay,status,fetched_at,kimarite,order_all,pays) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const ins = { run: (...a) => ins0.run(...a, ...(a.length === 15 ? [null, null, null] : [])) }
const stamp = new Date().toISOString()
let ok = 0, waiting = 0, partial = 0, err = 0, off = 0
for (let i = 0; i < targets.length; i += CONC) {
  const got = await Promise.all(targets.slice(i, i + CONC).map(async (t) => ({ t, r: await get(t) })))
  db.exec('BEGIN IMMEDIATE')
  for (const { t, r } of got) {
    const [hd, jcd, rno] = t.race_id.split('-')
    if (r === undefined) { err++; continue }
    // ★順延・中止。走らないので結果は来ない。status='cancel' で置いて、以後取りに行かない。
    //   hit は NULL のまま＝成績の分母には入らない（買えなかったのだから正しい）。
    if (r.cancelled) {
      off++
      ins.run(t.race_id, DATE, Number(jcd), Number(rno), null, null, null,
        null, null, null, null, null, null, 'cancel', stamp)
      continue
    }
    if (r.none || !r.order.filter(Boolean).length) { waiting++; continue }   // まだ結果が出ていない
    const [a, b, c] = r.order
    const st = (a && b && c) ? 'ok' : 'partial'
    if (st === 'partial') partial++; else ok++
    ins.run(t.race_id, DATE, Number(jcd), Number(rno), a ?? null, b ?? null, c ?? null,
      r.pay['3連単']?.combo ?? null, r.pay['3連単']?.amount ?? null,
      r.pay['3連複']?.combo ?? null, r.pay['3連複']?.amount ?? null,
      r.pay['単勝']?.combo ?? null, r.pay['単勝']?.amount ?? null, st, stamp,
      r.kimarite ?? null, r.order.map((x) => x ?? '-').join('-'), JSON.stringify(r.pay))
  }
  db.exec('COMMIT')
  if (i + CONC < targets.length) await sleep(DELAY)
}
console.log(`確定 ${ok} / 3着まで揃わず ${partial} / まだ結果なし ${waiting} / 順延・中止 ${off} / 取得失敗 ${err}`)
db.close()
