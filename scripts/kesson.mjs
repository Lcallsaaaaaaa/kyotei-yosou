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
import './prio.mjs'   // 予定タスク経由だと BelowNormal になる。自分で上げる
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, statSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs'
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

// ★見張る時間帯は、その日の締切から決める（2026-10-09）
//   以前は '08:30'〜'21:30' と決め打ちだった。ところが**ナイターの最終締切は
//   22:54**（10/08の実測）で、**21:30〜23:00は誰も見ていなかった**。
//   開催は日によって違うので、時刻を書き足すのではなく番組表から取る。
//   最初の締切の30分前から、最後の締切の30分後まで見る。
const RACE_WINDOW = (() => {
  const dl = []
  for (const t of ['race_meta', 'races']) {
    try {
      for (const r of db.prepare(`SELECT deadline FROM ${t} WHERE date=? AND deadline IS NOT NULL`).all(TODAY))
        dl.push(r.deadline)
    } catch { /* その表がまだ無い */ }
  }
  if (!dl.length) return null                       // 番組表が無い日は時刻で判断しない
  dl.sort()
  const shift = (hhmm, min) => {
    const [h, m] = hhmm.split(':').map(Number)
    const t = Math.max(0, Math.min(24 * 60 - 1, h * 60 + m + min))
    return `${p2(Math.floor(t / 60))}:${p2(t % 60)}`
  }
  return { from: shift(dl[0], -30), to: shift(dl.at(-1), 30) }
})()
/** いまレースのある時間帯か。番組表が取れない日は fallback の時刻で見る。 */
const inRaceHours = (fallbackFrom, fallbackTo) => RACE_WINDOW
  ? (HHMM >= RACE_WINDOW.from && HHMM <= RACE_WINDOW.to)
  : (HHMM >= fallbackFrom && HHMM <= fallbackTo)
db.exec('PRAGMA busy_timeout = 5000')
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) } catch { return null } }

const items = []
/** name=何が／due=この時刻までにあるはず／ok=あるか／detail=画面に出す一言 */
const add = (name, due, ok, detail) => items.push({ name, due, ok, detail })

// ---------- ① 予想の素 ----------
// ⚠ 大きさだけで見てはいけない（2026-10-28に踏んだ）。
//   この日、予想ファイルは96万バイトあったが**末尾に古い内容の尻尾が残って壊れていた**
//   （chokuzen と strategy が同じ固定名の一時ファイルを掴んだため）。
//   展開予想APIはこれを読むので、**有料会員の中身がまるごと出なくなった**。
//   それでも見張りは「1000バイト以上あるからOK」と言い続けた。**中身を読んで確かめる。**
{
  const f = join(ROOT, 'data', `predict-${TODAY}.json`)
  let ok = false, detail = 'これが無いと配信も無料枠も作れません'
  if (existsSync(f) && statSync(f).size > 1000) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      const n = (j.races ?? []).length
      ok = n > 0
      detail = ok ? `${n}レース（${j.chokuzen_at ? '直前差し替え ' + j.chokuzen_at : '朝のまま'}）`
        : '中身にレースがありません'
    } catch (e) {
      detail = `★壊れています（${String(e.message).slice(0, 50)}）。有料の展開予想が出ません`
    }
  }
  add('当日の予想ファイル', '04:00', ok, detail)
}

// ---------- ①' 有料会員の展開予想 ----------
// ★2026-10-28に追加。お金をいただいている中身なのに、見張りの対象外だった。
//   予想ファイルが壊れた10/28、誰も気づかないまま半日出ていなかった。
{
  const f = join(ROOT, 'data', `predict-${TODAY}.json`)
  let ok = false, detail = '予想ファイルが無いので判定できません'
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      // 展開予想は trio / first / flow から api.mjs が組み立てる。
      // ⚠ entries や lanes という持ち物は**無い**（2026-10-28に確かめた）。
      //   実際の持ち物は race_id, conf, trio, first, top2, flow, sanrentan, …
      const n = (j.races ?? []).filter((r) => Array.isArray(r.trio) && r.trio.length > 0).length
      ok = n > 0
      detail = ok ? `${n}レースぶん` : '0レース（有料会員に出せるものがありません）'
    } catch { detail = '★予想ファイルが壊れていて組み立てられません' }
  }
  add('有料の展開予想', '07:30', ok, detail)
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

// ---------- ⑤'' SEO記事（ニュース・場別攻略） ----------
// ★2026-10-28に追加。記事の生成は morning.sh の中にあり、
//   morning が毎朝 3221225786（強制終了）で死んでいたため **10/23から5日間止まっていた**。
//   見張りの対象外だったので、誰も気づかなかった。検索からの入口なので放置は効く。
{
  const dir = join(ROOT, 'content', 'news')
  let ok = false, detail = 'content/news がありません'
  try {
    // ⚠ プレビュー記事（auto-preview-…）は**未来の日付**を名前に持つ（2026-10-29に踏んだ）。
    //   外さないと「最新 2026-11-05」になり、止まっていても気づけない。
    const names = readdirSync(dir).filter((n) => n.endsWith('.md') && !n.includes('preview'))
    // ファイル名の日付（auto-YYYY-MM-DD-種類.md）で鮮度を見る。
    const days = names.map((n) => (/(\d{4}-\d{2}-\d{2})/.exec(n) ?? [])[1])
      .filter((d) => d && d <= TODAY).sort()
    const last = days[days.length - 1] ?? null
    ok = last === TODAY
    detail = last ? (ok ? `最新 ${last}` : `最新が ${last}（今日のぶんがありません）`) : '1本もありません'
  } catch { /* 読めない */ }
  add('ニュース記事', '08:00', ok, detail)
}
{
  const dir = join(ROOT, 'content', 'venues')
  // 24場を1日1場ずつ回す設計。**3日以上どれも更新されていなければ止まっている。**
  let ok = false, detail = 'content/venues がありません'
  try {
    const fs2 = readdirSync(dir).filter((n) => n.endsWith('.md'))
    let newest = 0
    for (const n of fs2) newest = Math.max(newest, statSync(join(dir, n)).mtimeMs)
    const ageDays = (Date.now() - newest) / 86400000
    ok = fs2.length >= 24 && ageDays < 3
    detail = `${fs2.length}場・最後の更新は ${Math.floor(ageDays)}日前`
  } catch { /* 読めない */ }
  add('場別攻略記事', '08:00', ok, detail)
}

// ---------- ⑤''' 検索エンジンが見る静的HTML ----------
// ★2026-10-30に追加。毎晩23:40の publish がメモリ不足で落ちていたのに
//   keepawake-run.ps1 が終了コードを捨てていたため、タスクは毎回「成功」。
//   **静的HTMLとサイトマップが10/23から7日間止まり**、クローラーには
//   「1週間なにも起きていないサイト」に見えていた。アクセスの入口そのもの。
//   データが新しくても、ここが止まれば検索からの流入は落ちる。
{
  const dir = join(ROOT, 'site')
  let ok = false, detail = 'site/ がありません'
  try {
    // 代表として index.html の更新時刻を見る（全部を走査すると重い）
    const idx = join(dir, 'index.html')
    if (existsSync(idx)) {
      const ageH = (Date.now() - statSync(idx).mtimeMs) / 3600000
      ok = ageH < 36                      // 毎晩作り直すので、36時間を超えたら止まっている
      detail = `最後の書き出しは ${Math.floor(ageH)}時間前`
    } else detail = 'site/index.html がありません'
  } catch { /* 読めない */ }
  add('静的HTML（検索エンジン向け）', '01:00', ok, detail)
}

// ---------- ⑤' 直前のフルモデル差し替え ----------
// ★展示が出て締切前のレースがあるのに、差し替えが動いていなければ欠品。
//   止まっても画面は朝の数字を出し続けるので、見ているだけでは気づけない（2026-10-02）。
{
  const watch = inRaceHours('10:30', '21:00')
  const f = join(ROOT, 'logs', `chokuzen-${TODAY}.log`)
  const age = existsSync(f) ? (Date.now() - statSync(f).mtimeMs) / 60000 : null
  if (!watch) add('直前の予想差し替え', '10:30', true, '見張る時間帯の外')
  else add('直前の予想差し替え', '10:30', age != null && age <= 20,
    age == null ? `logs/chokuzen-${TODAY}.log が無い` : `${Math.round(age)}分前に動いた`)
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
  const watch = inRaceHours('08:30', '21:30')
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

// ---------- ⑧ 手元の画面（status.mjs）が開けるか ----------
// ★ 2026-10-05。「配信のURLにアクセスできない」と言われて調べたら、
//   status.mjs が死んでいた。watchdog は10分ごとに立て直すが、その穴に
//   入るとこちらには何も届かない。**買い目があっても読めなければ欠品と同じ。**
//   日に1回くらい静かに死ぬので、見つけたら先に知らせる。
{
  const watch = inRaceHours('07:30', '23:00')
  if (!watch) add('手元の画面', '07:30', true, '見張る時間帯の外')
  else {
    let ok = false, detail = ''
    // ⚠ AbortSignal.timeout() は使わない（⑦と同じ理由）
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8_000)
    try {
      const res = await fetch('http://127.0.0.1:3940/haishin', { signal: ac.signal, cache: 'no-store' })
      ok = res.ok
      detail = ok ? 'localhost:3940 は開けます' : `開けません（${res.status}）`
    } catch {
      detail = 'localhost:3940 が答えません（status.mjs が落ちています）'
    } finally { clearTimeout(timer) }
    add('手元の画面', '07:30', ok, detail)
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
// ★ただし「直っていない」ときは2時間ごとに鳴らし直す（2026-10-05）
//   10/05、サイトの更新が13:13で止まったのを13:30に1回だけ知らせ、
//   そのあと**2時間なにも言わなかった**。顔ぶれが変わらないので黙る作りだった。
//   一度きりの知らせは見逃す。直るまでは間隔を空けて鳴らし直す。
const RENOTIFY_MIN = 120
if (!QUIET && bad.length) {
  const key = bad.map((x) => x.name).sort().join('|')
  const memo = join(ROOT, 'data', 'kesson-last.json')
  let prev = null
  try { prev = JSON.parse(readFileSync(memo, 'utf8')) } catch { /* 初回 */ }
  const mins = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
  const stale = prev?.date === TODAY && prev?.key === key && prev?.at
    && mins(HHMM) - mins(prev.at) >= RENOTIFY_MIN
  if (prev?.date !== TODAY || prev?.key !== key || stale) {
    writeFileSync(memo, JSON.stringify({ date: TODAY, key, at: HHMM }))
    const text = bad.map((x) => `・${x.name}：${x.detail}`).join('\n')
    appendFileSync(join(ROOT, 'logs', `kesson-${TODAY}.log`), `${HHMM}\n${text}\n\n`, 'utf8')
    try {
      // ★notifyBuy は買い目の記録（logs/buy-日付.txt）に追記するので使わない。
      //   欠品の知らせが混ざると、あとで何を買ったのか読み返せなくなる（2026-10-20に発覚）。
      const { notifyOps } = await import('./notify.mjs')
      await notifyOps(text, `欠品 ${bad.length}件（${HHMM}）`)
    } catch (e) { console.log('知らせに失敗:', e.message) }
  }
}

// ⚠ process.exit() で抜けると Windows で libuv のアサーションが出る
//   （fetch と DatabaseSync が残っているところへ割り込むため）。
//   exitCode を置いて自然に終わらせる。
process.exitCode = bad.length ? 1 : 0
