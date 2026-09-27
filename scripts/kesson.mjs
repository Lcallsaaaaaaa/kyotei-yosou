// 欠品の見張り。「あるべきものが、あるか」だけを見る。
//
//   node scripts/kesson.mjs            いまの状態を見て、欠品があれば知らせる
//   node scripts/kesson.mjs --quiet    知らせない（画面に出すだけ）
//   node scripts/kesson.mjs --json     結果をJSONで出す
//
// ★なぜ要るか（2026-09-27）
//   この日ひとつの朝に、壊れているものが4つ見つかった。**4つとも「成功」と
//   報告していた。**
//     ・朝7時の配信作り（3本）… タスクの結果は 0（成功）。中身は毎日まるごと未実行
//     ・サイトへの公開の常駐  … 起動されておらず、見張りの対象でもなかった
//     ・注目レース            … G1を4日間取り逃し。誰も気づかないまま
//     ・差分送信              … 毎回全件送り直し。14分かかるので1日1回しか回せない
//   watchdog.ps1 が見ているのは**プロセスの生死**。動いているのに何も作っていない、
//   という壊れ方を誰も捕まえられない。だから**成果物**を見る係をひとつ置く。
//
// ★うるさくしない
//   問題が無いときは何も言わない。前回と同じ問題のときも知らせ直さない
//   （data/kesson.json に前回の中身を覚えておく）。毎回鳴る見張りは、すぐ見なくなる。
//
// ★期限（due）より前は責めない
//   朝4時に「配信の買い目が無い」と言われても困る。各項目に「この時刻までに
//   出来ているはず」を持たせ、その時刻を過ぎてから欠品とする。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, statSync, appendFileSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const QUIET = argv.includes('--quiet')
const AS_JSON = argv.includes('--json')

const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
// ⚠ 日付は toISOString(UTC) で比べないこと。深夜0〜9時に前日と判定される。
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const HHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`
const past = (due) => HHMM >= due

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) } catch { return null } }

const items = []
/** name=何が／due=この時刻までにあるはず／ok=あるか／detail=画面に出す一言 */
const add = (name, due, ok, detail) => items.push({ name, due, ok, detail })

// ---------- ① 予想の素 ----------
{
  const f = join(ROOT, 'data', `predict-${TODAY}.json`)
  const ok = existsSync(f) && statSync(f).size > 1000
  add('当日の予想ファイル', '04:00', ok,
    ok ? `data/predict-${TODAY}.json` : 'これが無いと配信も無料枠も作れません')
}

// ---------- ② 配信（3連複4点・3連単4点） ----------
{
  const r = one(`SELECT COUNT(DISTINCT race_id) n FROM haishin_daily WHERE date=?`, TODAY)
  add('配信の買い目', '07:30', (r?.n ?? 0) > 0, `${r?.n ?? 0}レース`)
}

// ---------- ③ 無料枠（単勝1点） ----------
{
  const r = one(`SELECT COUNT(*) n FROM tansho_daily WHERE date=?`, TODAY)
  add('無料枠（単勝1点）', '07:30', (r?.n ?? 0) > 0, `${r?.n ?? 0}本`)
}

// ---------- ④ 注目レース（グレード開催がある日だけ） ----------
// ★spot.mjs と同じ見方で「今日は格上の開催があるか」を自分で判定する。
//   2026-09-13〜16は徳山のG1を名前で拾えず4日間欠品したが、誰も気づかなかった。
//   ここは名前を使わず、1号艇のA1率だけで見る（実測で綺麗に分かれる）。
{
  const ymd = TODAY.replace(/-/g, '')
  const jcds = (() => { try {
    return db.prepare(`SELECT DISTINCT CAST(substr(race_id,10,2) AS INTEGER) j
      FROM programs WHERE substr(race_id,1,8)=?`).all(ymd).map((r) => r.j)
  } catch { return [] } })()
  let top = 0, topJcd = null
  for (const j of jcds) {
    const a = one(`SELECT SUM(CASE WHEN grade='A1' THEN 1 ELSE 0 END) a1, COUNT(*) n
      FROM programs WHERE substr(race_id,1,8)=? AND substr(race_id,10,2)=? AND lane=1`, ymd, p2(j))
    const rate = a && a.n ? a.a1 / a.n : 0
    if (rate > top) { top = rate; topJcd = j }
  }
  const hasGrade = top >= 0.7
  const r = one(`SELECT COUNT(DISTINCT race_id) n FROM spot_daily WHERE date=?`, TODAY)
  if (hasGrade) add('注目レース（企画枠）', '07:30', (r?.n ?? 0) > 0,
    (r?.n ?? 0) > 0 ? `${r.n}レース` : `jcd=${topJcd} が1号艇A1率${(top * 100).toFixed(0)}%＝格上なのに出ていません`)
  else add('注目レース（企画枠）', '07:30', true, '今日は格上の開催なし')
}

// ---------- ⑤ 朝の配信文（note・X用） ----------
{
  const f = join(ROOT, 'logs', `morning-post-${TODAY}.txt`)
  const ok = existsSync(f) && statSync(f).size > 500
  add('朝の配信文（note・X）', '07:30', ok,
    ok ? `${(statSync(f).size / 1024).toFixed(0)}KB` : `logs/morning-post-${TODAY}.txt が無い／空`)
}

// ---------- ⑥ 再学習 ----------
{
  const r = one(`SELECT run_at, verdict, adopted FROM model_history ORDER BY run_at DESC LIMIT 1`)
  // run_at は UTC の ISO。JSTの日付に直して今日かどうかを見る
  const d = r?.run_at ? new Date(new Date(r.run_at).getTime() + 9 * 3600e3) : null
  const day = d ? d.toISOString().slice(0, 10) : null
  add('モデルの再学習', '06:00', day === TODAY,
    day ? `最後は ${day}（${r.verdict}${r.adopted ? '・入れ替え済み' : '・未入れ替え'}）` : '記録なし')
}

// ---------- ⑦ 公開サイトが固まっていないか ----------
// ★レースのある時間帯だけ見る。深夜に「更新が無い」と言っても意味がない。
{
  const watch = HHMM >= '08:30' && HHMM <= '21:30'
  if (!watch) add('サイトの更新', '08:30', true, '見張る時間帯の外')
  else {
    let detail = '確かめられませんでした', ok = true
    // ⚠ AbortSignal.timeout() は残ったタイマーが process.exit と噛み合って
    //   Windows で libuv のアサーションを吐く。自分で止める。
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    try {
      const res = await fetch('https://kyotei-site.pages.dev/data/meta.json',
        { signal: ac.signal, cache: 'no-store' })
      if (res.ok) {
        const j = await res.json()
        const t = j.updated_at ? new Date(j.updated_at.replace(' ', 'T') + '+09:00') : null
        const min = t ? Math.round((Date.now() - t.getTime()) / 60000) : null
        ok = min != null && min <= 30
        detail = min == null ? '更新時刻が読めません' : `${min}分前に更新`
      } else { detail = `読めません（${res.status}）` }
    } catch (e) { detail = `つながりません（${e.name}）` }   // 回線側は欠品にしない
    finally { clearTimeout(timer) }
    add('サイトの更新', '08:30', ok, detail)
  }
}

db.close()

// ---------- まとめ ----------
const bad = items.filter((x) => !x.ok && past(x.due))
const yet = items.filter((x) => !x.ok && !past(x.due))
const line = (x) => `${x.ok ? '✓' : '✗'} ${x.name}　${x.detail}`

if (AS_JSON) {
  console.log(JSON.stringify({ date: TODAY, at: HHMM, bad: bad.map((x) => x.name), items }, null, 1))
} else {
  for (const x of items) console.log('  ' + line(x))
  if (yet.length) console.log(`  （まだ期限前： ${yet.map((x) => `${x.name} ${x.due}まで`).join('・')}）`)
  console.log(bad.length ? `★ 欠品 ${bad.length}件` : '✓ 欠品はありません')
}

// 画面（status.mjs）が読む。朝の見張り表と当日の判定に赤帯を出すため
mkdirSync(join(ROOT, 'data'), { recursive: true })
writeFileSync(join(ROOT, 'data', 'kesson.json'), JSON.stringify(
  { date: TODAY, at: HHMM, checked_at: new Date().toISOString(), bad: bad.map((x) => ({ name: x.name, detail: x.detail })) }))

// ---------- 知らせる ----------
// 同じ欠品を何度も知らせない。前回と顔ぶれが変わったときだけ鳴らす。
if (!QUIET && bad.length) {
  const key = bad.map((x) => x.name).sort().join('|')
  const memo = join(ROOT, 'data', 'kesson-last.json')
  let prev = null
  try { prev = JSON.parse(readFileSync(memo, 'utf8')) } catch { /* 初回 */ }
  if (prev?.date !== TODAY || prev?.key !== key) {
    writeFileSync(memo, JSON.stringify({ date: TODAY, key, at: HHMM }))
    const text = bad.map((x) => `・${x.name}：${x.detail}`).join('\n')
    appendFileSync(join(ROOT, 'logs', `kesson-${TODAY}.log`), `${HHMM}\n${text}\n\n`, 'utf8')
    try {
      const { notifyBuy } = await import('./notify.mjs')
      await notifyBuy(text, `欠品 ${bad.length}件（${HHMM}）`)
    } catch (e) { console.log('知らせに失敗:', e.message) }
  }
}

// ⚠ process.exit() で抜けると Windows で libuv のアサーションが出る
//   （fetch と DatabaseSync が残っているところへ割り込むため）。
//   exitCode を置いて自然に終わらせる。
process.exitCode = bad.length ? 1 : 0
