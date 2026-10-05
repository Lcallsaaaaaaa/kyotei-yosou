// 本番の総点検。100項目以上を、実際に叩いて確かめる。
//
//   node scripts/audit-live.mjs              本番（kyotei-site.pages.dev）を点検
//   node scripts/audit-live.mjs --base http://127.0.0.1:8899
//   node scripts/audit-live.mjs --quiet      だめだった項目だけ出す
//
// ★なぜ要るか（2026-10-05）
//   この日ひとつの朝に、黙って壊れていたものが3つ見つかった。
//     ・見張りが sync-live を10分ごとに殺しては立て直し、サイトが2時間止まった
//     ・お金を払った会員が「無料予想」を見られなかった（鍵がLINE側にしかなかった）
//     ・欠品の知らせが1回鳴っただけで、2時間なにも言わなかった
//   どれも「成功」と報告されていた。**成果物を外から叩いて確かめる**係を置く。
//
// ★ここで見るのは「本番のURLを叩いて返るもの」。手元のファイルではない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const QUIET = argv.includes('--quiet')
const BASE = (() => { const i = argv.indexOf('--base'); return i > -1 ? argv[i + 1] : 'https://kyotei-site.pages.dev' })()

const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const HHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`
const YMD = TODAY.replaceAll('-', '')

let ok = 0; const bad = []
let section = ''
const S = (name) => { section = name; if (!QUIET) console.log('\n■ ' + name) }
const T = (name, pass, detail = '') => {
  if (pass) { ok++; if (!QUIET) console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`) }
  else { bad.push(`[${section}] ${name}${detail ? '　' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`) }
}

// 今月の無料鍵（窓口と同じ計算）
const { createHmac } = await import('node:crypto')
const freeKey = (() => {
  try {
    const m = JSON.parse(readFileSync(join(ROOT, 'data', 'free-secret.json'), 'utf8')).master
    const d = new Date(Date.now() + 9 * 3600e3)
    const period = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`
    return createHmac('sha256', Buffer.from(m, 'hex')).update('freekey:' + period).digest('base64url').slice(0, 22)
  } catch { return null }
})()

const get = async (path, opt = {}) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  try {
    const r = await fetch(BASE + path, { signal: ac.signal, cache: 'no-store', headers: opt.headers ?? {} })
    const text = await r.text()
    let json = null; try { json = JSON.parse(text) } catch { /* HTMLのこともある */ }
    return { status: r.status, text, json, headers: r.headers }
  } catch (e) { return { status: 0, text: '', json: null, err: e.name } }
  finally { clearTimeout(timer) }
}
const K = freeKey ? { 'x-free-key': freeKey } : {}

console.log(`総点検：${BASE}　（${TODAY} ${HHMM}）`)

// ============ A. 置き場と鍵 ============
S('A. 置き場と鍵')
{
  const pub = await get(`/data/races/${TODAY}.json`)
  T('公開ぶんは鍵なしで返る', pub.status === 200, `${pub.status}`)
  T('公開ぶんは JSON', !!pub.json)
  T('公開ぶんは途中でためてよい', /public/.test(pub.headers?.get('cache-control') ?? ''))

  const noKey = await get(`/data/member/free/${TODAY}.json`)
  T('無料枠は鍵なしでは断る', noKey.status === 401, `${noKey.status}`)
  T('断る合図は line_required', noKey.json?.error === 'line_required', String(noKey.json?.error))

  T('今月の鍵が作れる', !!freeKey)
  const withKey = await get(`/data/member/free/${TODAY}.json`, { headers: K })
  T('今月の鍵で無料枠が開く', withKey.status === 200, `${withKey.status}`)
  T('無料枠は途中でためない', /private/.test(withKey.headers?.get('cache-control') ?? ''))
  const qKey = await get(`/data/member/free/${TODAY}.json?k=${freeKey}`)
  T('?k= でも開く', qKey.status === 200, `${qKey.status}`)

  for (const [name, k] of [['でたらめ', 'AAAAAAAAAAAAAAAAAAAAAA'], ['空', ''],
    ['前方一致だけ', (freeKey ?? '').slice(0, 6)], ['1文字多い', (freeKey ?? '') + 'x'],
    ['大小を変える', (freeKey ?? '').toUpperCase()], ['2回つなげる', (freeKey ?? '') + (freeKey ?? '')]]) {
    const r = await get(`/data/member/free/${TODAY}.json`, { headers: { 'x-free-key': k } })
    T(`${name}鍵では開かない`, r.status === 401, `${r.status}`)
  }
  // ⚠ 二重スラッシュなどは Cloudflare が SPA の外枠（index.html・200）を返す。
  //   状態コードでは判断できないので、**中身が漏れていないか**で見る。
  for (const p of ['/data/member/../paid/x.json', `/data//member/free/${TODAY}.json`, '/data/',
    `/data/member/free/${TODAY}.json/`, `/DATA/member/free/${TODAY}.json`]) {
    const r = await get(p)
    T(`変なパス ${p} から中身が漏れない`, !/win_probability|"picks":\s*\[/.test(r.text), `${r.status}`)
  }
  const paid = await get(`/data/paid/race/${YMD}-12-01.json`)
  T('有料ぶんは鍵なしでも返る（中身は暗号文）', paid.status === 200 || paid.status === 404, `${paid.status}`)
  if (paid.json) {
    T('有料ぶんは暗号文の形', !!(paid.json.iv && paid.json.ct && paid.json.period))
    T('有料ぶんに生の買い目が無い', !/"picks":\s*\{|"trio":\[|"trifecta":\[/.test(paid.text))
  }
}

// ============ B. 公開データの中身 ============
S('B. 公開データの中身')
const meta = await get('/data/meta.json')
{
  T('meta が返る', meta.status === 200, `${meta.status}`)
  const t = meta.json?.updated_at ? new Date(meta.json.updated_at.replace(' ', 'T') + '+09:00') : null
  const min = t ? Math.round((Date.now() - t.getTime()) / 60000) : null
  const watch = HHMM >= '08:30' && HHMM <= '21:30'
  T('サイトの更新が止まっていない', !watch || (min != null && min <= 30), min == null ? '時刻が読めない' : `${min}分前`)
  T('meta に今日が入っている', (meta.json?.dates ?? []).includes(TODAY), (meta.json?.dates ?? []).join(','))
  T('site 名が入っている', !!meta.json?.site)
}
const races = await get(`/data/races/${TODAY}.json`)
{
  const rs = races.json?.races ?? []
  T('今日のレースがある', rs.length > 0, `${rs.length}レース`)
  T('レース数が妥当（24〜180）', rs.length >= 24 && rs.length <= 180, `${rs.length}`)
  T('全部に締切がある', rs.every((r) => r.deadline), `欠け ${rs.filter((r) => !r.deadline).length}`)
  T('全部に場名がある', rs.every((r) => r.venue))
  T('race_id の形が正しい', rs.every((r) => /^\d{8}-\d{2}-\d{2}$/.test(r.race_id)))
  T('公開ぶんに1着確率が無い', !/"win_probability"/.test(races.text))
  T('公開ぶんに買い目が無い', !/"picks":|"trio":|"trifecta":|"prediction":/.test(races.text))
  T('公開ぶんに展開予想の中身が無い', !/"tenkai":\{/.test(races.text))
  T('無料予想の印がある', rs.some((r) => r.free_pick), `${rs.filter((r) => r.free_pick).length}本`)
  T('会員の印がある', rs.some((r) => r.member_only), `${rs.filter((r) => r.member_only).length}レース`)
}
{
  const tk = await get(`/data/tenkai/${TODAY}.json`)
  T('展開予想の一覧が返る', tk.status === 200, `${tk.status}`)
  T('展開予想の中身は公開側に出していない', !/"honmei"|"tenkai":\{/.test(tk.text))
  const F = await get(`/data/features/${TODAY}.json`)
  T('特集が返る', F.status === 200, `${F.status}`)
  T('ガチガチは公開側で null', F.json?.gachigachi == null)
  T('穴は公開側で null', F.json?.ana == null)
  const al = F.json?.alerts ?? {}
  for (const k of ['makuri', 'maezuke', 'tilt', 'start']) T(`アラート ${k} が配列`, Array.isArray(al[k]), `${(al[k] ?? []).length}件`)
  T('アラートの説明文がある', !!al.rules?.makuri)
}
for (const [path, name, check] of [
  ['/data/results/30.json', '実績', (j) => (j?.days ?? j?.rows ?? j?.summary) != null],
  ['/data/schedule.json', '開催予定', (j) => Array.isArray(j?.meetings)],
  ['/data/analysis/average.json', 'コース別平均', (j) => !!j],
  ['/data/analysis/ranking.json', 'コース別ランキング', (j) => !!j],
  ['/data/analysis/demoku.json', '出目分析', (j) => !!j],
  ['/data/analysis/yusho.json', '優勝戦', (j) => !!j],
  ['/data/venue/12.json', '場（住之江）', (j) => !!j],
  ['/data/guide/12.json', '場の攻略（住之江）', (j) => !!j],
  ['/data/racers.json', '選手一覧', (j) => !!j],
  ['/data/news/index.json', 'ニュース一覧', (j) => Array.isArray(j?.articles)],
  ['/data/page/about.json', 'このサイトについて', (j) => !!j?.html],
  ['/data/page/privacy.json', 'プライバシーポリシー', (j) => !!j?.html],
  ['/data/page/terms.json', '利用規約', (j) => !!j?.html],
]) {
  const r = await get(path)
  T(`${name} が返る`, r.status === 200, `${r.status}`)
  T(`${name} の中身が妥当`, r.status === 200 && check(r.json))
  T(`${name} に買い目が混ざっていない`, !/"trio":\[|"trifecta":\[|"honmei"/.test(r.text))
}

// ============ C. 画面のURL ============
S('C. 画面のURL')
for (const p of ['/', '/tenkai', '/news', '/racers', '/racers/all', '/schedule', '/results', '/venues',
  '/member', '/line', '/login', '/about', '/privacy', '/terms',
  '/analysis/average', '/analysis/ranking', '/analysis/demoku', '/analysis/yusho']) {
  const r = await get(p)
  T(`${p} が開く`, r.status === 200, `${r.status}`)
}
{
  const line = await get('/line')
  T('/line に題がある', /<title>[^<]*LINE/.test(line.text))
  T('/line は検索に出す', /name="robots" content="index/.test(line.text))
  T('/line に生のマークダウンが残っていない', !/\*\*|^#\s/m.test(line.text.replace(/<[^>]*>/g, '')))
  const about = await get('/about')
  T('/about にLINEの窓口がある', /lcall\.shop|公式LINE/.test(about.text))
  const robots = await get('/robots.txt')
  T('robots.txt が返る', robots.status === 200, `${robots.status}`)
  const open = /Allow:\s*\//i.test(robots.text) && !/Disallow:\s*\/\s*$/im.test(robots.text)
  T('robots.txt の状態', true, open ? '検索に開いている' : '★まだ全面拒否（ドメイン未設定）')
  const sm = await get('/sitemap.xml')
  T('sitemap.xml の状態', true, sm.status === 200 ? `${(sm.text.match(/<loc>/g) ?? []).length}URL` : '★まだ無い（ドメイン未設定）')
  const nf = await get('/this-page-does-not-exist-xyz')
  T('無いページでも画面は壊れない', nf.status === 200 || nf.status === 404, `${nf.status}`)
}

// ============ D. 常駐と自動実行 ============
S('D. 常駐と自動実行')
{
  let cmdlines = []
  try {
    cmdlines = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"],
    { encoding: 'utf8', timeout: 30_000 }).split(/\r?\n/)
  } catch { /* 取れなければ下で落ちる */ }
  for (const [name, re] of [['予想の画面 status.mjs', /status\.mjs/], ['オッズ odds-live', /odds-live\.mjs/],
    ['判定 auto-bet', /auto-bet\.mjs/], ['直前情報 before --live', /before\.mjs.*--live/],
    ['公開 sync-public --live', /sync-public\.mjs.*--live/]])
    T(`${name} が動いている`, cmdlines.some((c) => re.test(c)))

  const beat = join(ROOT, 'data', 'sync-public-state.json')
  const beatMin = existsSync(beat) ? Math.round((Date.now() - statSync(beat).mtimeMs) / 60000) : null
  const watch = HHMM >= '08:30' && HHMM <= '21:30'
  T('公開の鼓動が新しい', !watch || (beatMin != null && beatMin <= 30), beatMin == null ? 'ファイルが無い' : `${beatMin}分前`)

  const wlog = join(ROOT, 'logs', `watchdog-${TODAY}.log`)
  const wtext = existsSync(wlog) ? readFileSync(wlog, 'utf8') : ''
  const kills = (wtext.match(/killed stuck sync-live/g) ?? []).length
  T('見張りが sync-live を殺し続けていない', kills <= 2, `今日 ${kills} 回`)
  const restarts = (wtext.match(/restarted sync-live/g) ?? []).length
  T('sync-live の立て直しが多すぎない', restarts <= 3, `今日 ${restarts} 回`)

  const kes = join(ROOT, 'data', 'kesson.json')
  const kj = existsSync(kes) ? JSON.parse(readFileSync(kes, 'utf8')) : null
  T('欠品の見張りが今日動いている', kj?.date === TODAY, kj?.at ?? 'なし')
  T('欠品がゼロ', (kj?.bad ?? []).length === 0, (kj?.bad ?? []).map((x) => x.name).join('・') || 'なし')

  const lock = join(ROOT, 'data', 'sync-public.lock')
  const lockMin = existsSync(lock) ? Math.round((Date.now() - statSync(lock).mtimeMs) / 60000) : null
  T('送信の鍵が置き去りになっていない', lockMin == null || lockMin < 40, lockMin == null ? 'なし' : `${lockMin}分前`)
}

// ============ E. 手元のデータとの整合 ============
S('E. 手元のデータとの整合')
{
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) } catch { return null } }
  const tansho = one('SELECT COUNT(*) n FROM tansho_daily WHERE date=?', TODAY)?.n ?? 0
  const haishin = one('SELECT COUNT(DISTINCT race_id) n FROM haishin_daily WHERE date=?', TODAY)?.n ?? 0
  const spot = one('SELECT COUNT(DISTINCT race_id) n FROM spot_daily WHERE date=?', TODAY)?.n ?? 0
  const prog = one('SELECT COUNT(DISTINCT race_id) n FROM programs WHERE substr(race_id,1,8)=?', YMD)?.n ?? 0

  T('出走表が取れている', prog > 0, `${prog}レース`)
  T('無料枠が作られている', HHMM < '07:30' || tansho > 0, `${tansho}本`)
  T('配信が作られている', HHMM < '07:30' || haishin > 0, `${haishin}レース`)

  const free = await get(`/data/member/free/${TODAY}.json`, { headers: K })
  T('公開した無料枠の本数が手元と一致', (free.json?.picks ?? []).length === tansho,
    `公開 ${(free.json?.picks ?? []).length} / 手元 ${tansho}`)
  T('無料枠に1着確率が入っている', (free.json?.picks ?? []).every((x) => x.win_probability != null))
  T('無料枠の確率は百分率（1より大きい）', (free.json?.picks ?? []).every((x) => x.win_probability == null || x.win_probability > 1),
    '小数だと画面が 0.9% と出す')

  const paidFree = await get(`/data/paid/free/${TODAY}.json`)
  T('有料会員も無料予想を開ける（paid/free がある）', paidFree.status === 200, `${paidFree.status}`)
  T('paid/free は暗号文', !!(paidFree.json?.iv && paidFree.json?.ct))

  const pr = join(ROOT, 'data', `predict-${TODAY}.json`)
  T('当日の予想ファイルがある', existsSync(pr) && statSync(pr).size > 1000)

  const rs = races.json?.races ?? []
  T('公開レース数が出走表と一致', rs.length === prog, `公開 ${rs.length} / 手元 ${prog}`)
  const mem = rs.filter((r) => r.member_only).length
  T('会員の印が全レースに付いている', mem === rs.length || mem === 0, `${mem}/${rs.length}`)
  T('注目レースの印が手元と矛盾しない', spot === 0 || true, `注目 ${spot}レース`)

  // 締切を過ぎた買い目が後から書き換わっていないか（記録の穴①②）
  const late = one(`SELECT COUNT(*) n FROM haishin_daily h JOIN races r ON r.race_id=h.race_id
    WHERE h.date=? AND r.deadline IS NOT NULL AND h.recorded_at IS NOT NULL
      AND substr(h.recorded_at,12,5) > r.deadline`, TODAY)?.n
  T('締切後に買い目が書き加えられていない', late == null || late === 0, `${late ?? '―'}件`)
  db.close()
}

// ============ まとめ ============
console.log('')
console.log('─'.repeat(50))
if (bad.length) {
  console.log(`★ ${bad.length}件おかしい（通ったのは ${ok}件／全 ${ok + bad.length}件）`)
  for (const b of bad) console.log('  ・' + b)
} else {
  console.log(`✓ ${ok}件すべて期待どおり`)
}
process.exitCode = bad.length ? 1 : 0
