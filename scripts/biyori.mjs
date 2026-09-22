// ボートレース日和の出走表APIから、1レース分の全項目を取得して蓄積する。
//
//   node scripts/biyori.mjs --probe                       項目一覧をファイルに書き出す
//   node scripts/biyori.mjs --from 2025-08-18 --to 2026-08-18
//   node scripts/biyori.mjs --stats
//
// ★経緯
//   日和はJSで後読みするSPAなので、当初はブラウザで開いて画面を読んでいた。
//   だが実体は request_race_shusso_detail_v4.php への1回のPOSTで、
//   **1レース約800KB・選手1人あたり1,516項目**が丸ごと返る。
//   ブラウザは不要で、直接叩けば高速に集められる。
//
// ★返るもの
//   race_list          6艇分の全項目（性別・チルト・F/L/欠場/失格・コース別進入と着順率・
//                      コース別平均ST・SG限定/女子戦/ナイター等の条件別指標）
//   kako_list          過去走
//   start_junban       スタート順番
//   maeduke_list       前づけ
//   chukan_seibi_list  中間整備   ← 公式データには無い
//   flying_kikan_list  フライング期間
//
// ★注意
//   POSTには data(JSON) と token(CSRF) が要る。トークンはページHTMLに埋まっているので
//   1回取得して使い回す。セッションが切れたら取り直す。
//
// ★⚠️ 日和は個人サイトで、叩きすぎるとIPごと遮断される
//   2026/08/18、同時5本・間隔120msで回したところ **TCP接続そのものを拒否**されるようになった
//   （HTTPエラーではなく UND_ERR_CONNECT_TIMEOUT。ヘッダを変えても復帰しない）。
//   公式サイトと同じ感覚で並列数を上げてはいけない。
//   既定は同時1本・間隔1秒。連続失敗したら自動で待ち時間を延ばし、
//   それでも駄目なら止める（遮断された状態で叩き続けても復帰が遅れるだけ）。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DELAY = Number(flag('delay', 1000))
const CONC = Number(flag('conc', 1))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = 'https://kyoteibiyori.com'
const HEAD = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.9',
}

/** 遮断されたら待ち時間を伸ばす。連続失敗が続いたら諦めて止める。 */
let penalty = 0
const noteOk = () => { penalty = Math.max(0, penalty - 1) }
const noteFail = () => { penalty++ }

db.exec(`
  CREATE TABLE IF NOT EXISTS biyori_racer (
    race_id TEXT NOT NULL, lane INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (race_id, lane)
  );
  CREATE TABLE IF NOT EXISTS biyori_race (
    race_id TEXT PRIMARY KEY, extra TEXT, fetched TEXT, status TEXT
  );
`)

if (argv.includes('--stats')) {
  const t = one(`SELECT COUNT(*) c FROM biyori_race WHERE status='ok'`).c
  const total = one(`SELECT COUNT(*) c FROM races`).c
  console.log('=== 日和データの収集状況 ===')
  console.log(`  取得済み ${t} / ${total} レース (${((t / total) * 100).toFixed(1)}%)`)
  console.log(`  biyori_racer 行数: ${one('SELECT COUNT(*) c FROM biyori_racer').c.toLocaleString()}`)
  db.close(); process.exit(0)
}

/** ページからCSRFトークンと開催キーを拾う */
async function getContext(jcd, raceNo, ymd) {
  const url = `${BASE}/race_shusso.php?place_no=${jcd}&race_no=${raceNo}&hiduke=${ymd}&slider=0`
  const html = await (await fetch(url, { headers: HEAD, signal: AbortSignal.timeout(25_000) })).text()
  const g = (re) => { const m = html.match(re); return m ? m[1] : '' }
  return {
    token: g(/CSRF_TOKEN\s*=\s*['"]([^'"]+)['"]/),
    race_name: g(/m_RaceName\s*=\s*['"]([^'"]*)['"]/),
    season: g(/m_Searson\s*=\s*['"]?([^'";\s]*)/),
    term: g(/m_Term\s*=\s*['"]?([^'";\s]*)/),
    kaisai_key: g(/m_Kaisai_key\s*=\s*['"]?([^'";\s]*)/),
    taikai_count: g(/m_Taikai_count\s*=\s*['"]?([^'";\s]*)/),
    group_no: g(/m_Group_no\s*=\s*['"]?([^'";\s]*)/),
  }
}

async function fetchRace(ctx, jcd, raceNo, ymd) {
  const q = {
    place_no: jcd, race_no: raceNo, hiduke: Number(ymd),
    race_name: ctx.race_name, season: ctx.season, term: ctx.term,
    kaisai_key: ctx.kaisai_key, taikai_count: ctx.taikai_count, group_no: ctx.group_no,
    type: 0, grade: 0,
  }
  const res = await fetch(`${BASE}/request_race_shusso_detail_v4.php`, {
    method: 'POST',
    headers: { ...HEAD, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/race_shusso.php` },
    body: `data=${encodeURIComponent(JSON.stringify(q))}&token=${encodeURIComponent(ctx.token)}`,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(String(res.status))
  const j = await res.json()
  if (!j?.race_list || !Array.isArray(j.race_list) || j.race_list.length !== 6) return null
  return j
}

if (argv.includes('--probe')) {
  const ctx = await getContext(16, 12, '20260818')
  if (!ctx.token) { console.error('トークンが取得できません'); process.exit(1) }
  const j = await fetchRace(ctx, 16, 12, '20260818')
  if (!j) { console.error('データが取得できません'); process.exit(1) }
  const keys = Object.keys(j.race_list[0])
  writeFileSync(join(ROOT, 'data', 'biyori-fields.txt'), keys.join('\n'))
  console.log(`項目数 ${keys.length} → data/biyori-fields.txt に書き出し`)
  console.log(`上位キー: ${Object.keys(j).join(', ')}`)
  for (const k of ['chukan_seibi_list', 'flying_kikan_list', 'maeduke_list', 'start_junban']) {
    console.log(`  ${k}: ${JSON.stringify(j[k]).slice(0, 160)}`)
  }
  db.close(); process.exit(0)
}

const from = flag('from'), to = flag('to')
if (!from || !to) { console.error('--from --to が必要'); process.exit(1) }

const targets = all(`
  SELECT r.race_id, r.jcd, r.race_no, r.date FROM races r
  WHERE r.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM biyori_race b WHERE b.race_id=r.race_id AND b.status IN ('ok','empty'))
  ORDER BY r.date DESC, r.jcd, r.race_no`, from, to)

console.log(`=== 日和データ収集 ${from} 〜 ${to} ===`)
console.log(`対象 ${targets.length.toLocaleString()} レース  同時${CONC}本  間隔${DELAY}ms\n`)

const insR = db.prepare(`INSERT INTO biyori_racer (race_id,lane,data) VALUES (?,?,?)
  ON CONFLICT(race_id,lane) DO UPDATE SET data=excluded.data`)
const insM = db.prepare(`INSERT INTO biyori_race (race_id,extra,fetched,status) VALUES (?,?,?,?)
  ON CONFLICT(race_id) DO UPDATE SET extra=excluded.extra, fetched=excluded.fetched, status=excluded.status`)

// 開催ごとにトークンと開催キーが変わるので、日付+場ごとに取り直す
const ctxCache = new Map()
async function ctxFor(t) {
  const key = `${t.date}:${t.jcd}`
  if (!ctxCache.has(key)) ctxCache.set(key, await getContext(t.jcd, t.race_no, t.date.replace(/-/g, '')))
  return ctxCache.get(key)
}

let ok = 0, empty = 0, err = 0
const buf = []
const t0 = Date.now()
const stamp = new Date().toISOString()

const flush = () => {
  if (!buf.length) return
  db.exec('BEGIN')
  for (const x of buf) {
    if (x.status === 'ok') {
      x.j.race_list.forEach((b, i) => insR.run(x.t.race_id, i + 1, JSON.stringify(b)))
      insM.run(x.t.race_id, JSON.stringify({
        chukan_seibi: x.j.chukan_seibi_list, flying_kikan: x.j.flying_kikan_list,
        maeduke: x.j.maeduke_list, start_junban: x.j.start_junban,
      }), stamp, 'ok')
    } else insM.run(x.t.race_id, null, stamp, x.status)
  }
  db.exec('COMMIT')
  buf.length = 0
}

for (let i = 0; i < targets.length; i += CONC) {
  const batch = targets.slice(i, i + CONC)
  const got = await Promise.all(batch.map(async (t) => {
    for (let a = 1; a <= 3; a++) {
      try {
        const ctx = await ctxFor(t)
        if (!ctx.token) throw new Error('no token')
        const j = await fetchRace(ctx, t.jcd, t.race_no, t.date.replace(/-/g, ''))
        noteOk()
        return { t, j, status: j ? 'ok' : 'empty' }
      } catch {
        ctxCache.delete(`${t.date}:${t.jcd}`)   // トークン切れの可能性があるので取り直す
        noteFail()
        if (a === 3) return { t, j: null, status: 'error' }
        await sleep(DELAY * a * 5)
      }
    }
  }))
  for (const g of got) { buf.push(g); g.status === 'ok' ? ok++ : g.status === 'empty' ? empty++ : err++ }
  if (buf.length >= 40) flush()
  const done = Math.min(i + CONC, targets.length)
  if (done % 200 < CONC || done === targets.length) {
    const el = (Date.now() - t0) / 1000
    console.log(`[${((done / targets.length) * 100).toFixed(1)}%] ${done}/${targets.length}  ok${ok} 空${empty} 失敗${err}  ${(el / done).toFixed(2)}秒/件  残り約${(((targets.length - done) * (el / done)) / 3600).toFixed(1)}時間`)
  }
  // 遮断されているのに叩き続けると復帰が遅れる。失敗が続いたら待ち、止まらなければ諦める。
  if (penalty >= 5) {
    console.log(`  失敗が続いています（penalty=${penalty}）。60秒待機します`)
    flush()
    await sleep(60_000)
  }
  if (penalty >= 15) { console.log('  遮断されたと判断して中断します。時間を空けて再実行してください'); break }
  await sleep(DELAY + penalty * 500)
}
flush()
console.log(`\n完了: ok ${ok} / 空 ${empty} / 失敗 ${err}`)
db.close()
