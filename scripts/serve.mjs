// 予想を表示するローカルWebフォーム。
//
//   node scripts/serve.mjs
//   → ブラウザで http://localhost:3939 を開く
//
// ★設計：予想ロジックを二重に書かない
//   フォーム用に予想を作り直すと、片方だけ直して食い違う事故が起きる。
//   ここでは predict.mjs を子プロセスとして定期実行し、結果を保持するだけにする。
//   計算は predict.mjs の1箇所に集約されたまま。
//
// ★なぜ定期実行なのか
//   predict.mjs は起動のたびに133万行の履歴を積み直すので30〜60秒かかる。
//   リクエストのたびに動かすと待たされる。数分おきに裏で走らせて結果を持っておけば、
//   画面は即座に返せる。展示タイムが発表されると次の実行で自動的に反映される。

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const PORT = Number(flag('port', 3939))
const EVERY = Number(flag('every', 4)) * 60_000   // 何分おきに予想を作り直すか

const p2 = (n) => String(n).padStart(2, '0')
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }

let state = { date: today(), races: [], generatedAt: null, running: false, error: null, deadlines: new Map() }

// ---------- 締切時刻を公式から取る ----------
async function loadDeadlines(date) {
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  const ymd = date.replace(/-/g, '')
  const jcds = db.prepare(`SELECT DISTINCT CAST(substr(race_id,10,2) AS INTEGER) j
    FROM programs WHERE substr(race_id,1,8)=?`).all(ymd).map((r) => r.j)
  db.close()
  const m = new Map()
  for (const j of jcds) {
    try {
      const h = await (await fetch(`https://www.boatrace.jp/owpc/pc/race/raceindex?jcd=${p2(j)}&hd=${ymd}`,
        { signal: AbortSignal.timeout(20_000) })).text()
      m.set(j, [...h.matchAll(/(\d{1,2}:\d{2})/g)].map((x) => x[1]).slice(0, 12))
    } catch { m.set(j, []) }
    await new Promise((r) => setTimeout(r, 250))
  }
  return m
}

// ---------- predict.mjs を回して結果を取り込む ----------
function runPredict(date) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--max-old-space-size=6144',
      join(ROOT, 'scripts', 'predict.mjs'), '--date', date, '--trio', '--json'],
      { cwd: ROOT })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', () => {
      // JSONは最後の行に出る（前の行は進捗表示）
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
      if (!line) return resolve({ error: err.slice(0, 400) || out.slice(-400) || '出力が読めません' })
      try { resolve(JSON.parse(line)) } catch (e) { resolve({ error: e.message }) }
    })
  })
}

async function refresh() {
  if (state.running) return
  state.running = true
  const date = today()
  if (date !== state.date) { state.date = date; state.deadlines = new Map() }
  if (!state.deadlines.size) state.deadlines = await loadDeadlines(date)
  const r = await runPredict(date)
  if (r.error) { state.error = r.error }
  else { state.races = r.races; state.generatedAt = r.generatedAt; state.error = null }
  state.running = false
  console.log(`[${new Date().toTimeString().slice(0, 8)}] 更新 ${state.races.length}レース${state.error ? ' / エラー: ' + state.error : ''}`)
}

// ---------- 画面 ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const minsTo = (hhmm) => {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  return (h * 60 + m) - (now.getHours() * 60 + now.getMinutes())
}

function page(q) {
  const venue = q.get('venue') ? Number(q.get('venue')) : null
  const only = q.get('upcoming') === '1'
  const venues = [...new Map(state.races.map((r) => [r.jcd, r.venue])).entries()].sort((a, b) => a[0] - b[0])
  let list = state.races.map((r) => {
    const dl = state.deadlines.get(r.jcd)?.[r.race_no - 1] ?? null
    return { ...r, dl, mins: minsTo(dl) }
  })
  if (venue) list = list.filter((r) => r.jcd === venue)
  if (only) list = list.filter((r) => r.mins != null && r.mins >= 0)
  list.sort((a, b) => b.conf - a.conf)

  const age = state.generatedAt ? Math.round((Date.now() - new Date(state.generatedAt)) / 60000) : null
  const rows = list.map((r) => {
    const near = r.mins != null && r.mins >= 0 && r.mins <= 25
    return `<tr class="${near ? 'near' : ''}">
      <td class="mono">${r.dl ?? '—'}${r.mins != null && r.mins >= 0 ? `<span class="mins">${r.mins}分後</span>` : ''}</td>
      <td>${esc(r.venue)} <b>${r.race_no}R</b></td>
      <td class="mono conf">${(r.conf * 100).toFixed(1)}%</td>
      <td class="mono">${r.trio.map((t, i) => `<span class="c${i}">${t.combo} <em>${(t.p * 100).toFixed(1)}%</em></span>`).join(' ')}</td>
      <td class="first">${r.first.slice(0, 3).map((f) => `${f.lane} ${esc(f.name)} <em>${(f.p * 100).toFixed(0)}%</em>`).join(' / ')}</td>
    </tr>`
  }).join('')

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>競艇予想 ${state.date}</title>
<style>
 :root{--bg:#f6f8fa;--card:#fff;--ink:#101821;--mut:#5b6875;--line:#dce3ea;--acc:#0e5a73;--near:#fff8e6}
 @media(prefers-color-scheme:dark){:root{--bg:#0c1116;--card:#131a21;--ink:#e4eaf0;--mut:#96a3b0;--line:#232c36;--acc:#5fb6cf;--near:#2a2415}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Noto Sans JP",system-ui,sans-serif}
 .wrap{max-width:1100px;margin:0 auto;padding:1.5rem 1rem 4rem}
 h1{font-size:1.3rem;margin:0 0 .3rem}
 .meta{color:var(--mut);font-size:13px;margin:0 0 1.2rem}
 form{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-bottom:1.2rem}
 select,button,label{font:inherit}
 select,button{padding:.45rem .7rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
 button{cursor:pointer;border-color:var(--acc);color:var(--acc)}
 .scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
 table{border-collapse:collapse;width:100%;font-size:13.5px}
 th,td{padding:.55rem .7rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
 th{font-size:11.5px;color:var(--mut);background:var(--bg)}
 tr:last-child td{border-bottom:none}
 tr.near td{background:var(--near)}
 .mono{font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
 .conf{font-weight:700}
 .mins{color:var(--mut);font-size:11px;margin-left:.4rem}
 em{font-style:normal;color:var(--mut);font-size:11.5px}
 .c0{font-weight:700;color:var(--acc)}
 .first{color:var(--mut);font-size:12.5px}
 .err{background:#f7e9e4;color:#9c4227;padding:.8rem;border-radius:6px;margin-bottom:1rem}
 .note{color:var(--mut);font-size:12.5px;margin-top:1.2rem;line-height:1.9}
</style></head><body><div class="wrap">
<h1>競艇予想　${state.date}</h1>
<p class="meta">${state.races.length}レース／更新 ${age == null ? '未' : age + '分前'}${state.running ? '（更新中…）' : ''}　自動更新 ${EVERY / 60000}分おき</p>
${state.error ? `<div class="err">${esc(state.error)}</div>` : ''}
<form method="get">
 <select name="venue"><option value="">全場</option>
 ${venues.map(([j, v]) => `<option value="${j}"${venue === j ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
 <label><input type="checkbox" name="upcoming" value="1"${only ? ' checked' : ''}> 締切前のみ</label>
 <button type="submit">表示</button>
 <button type="submit" formaction="/refresh" formmethod="post">今すぐ更新</button>
</form>
<div class="scroll"><table>
<thead><tr><th>締切</th><th>レース</th><th>自信</th><th>3連複3点</th><th>1着予想</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">該当なし</td></tr>'}</tbody>
</table></div>
<p class="note">
 自信＝3点の的中確率の合計。締切前に分かる情報のみ使用（進入は枠番で代用）。<br>
 展示タイムは各レースの15〜20分前に公表され、次の自動更新で反映される。<br>
 <b>3連複3点の実測は 的中54.1% / 回収78.8%</b>（8ヶ月35,668レース）。当たっても平均では負ける。<br>
 優位があるのは<b>1着確率30〜60%かつ締切2分前の単勝オッズ6倍以上</b>のときのみ（想定117.5%）。<br>
 <b>締切15分前より前のオッズは使えない</b>（プール未形成。Σ1/オッズが2.7〜4.1になる）。
</p>
</div></body></html>`
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  if (req.method === 'POST' && u.pathname === '/refresh') {
    refresh()
    res.writeHead(303, { Location: '/' }); res.end(); return
  }
  if (u.pathname === '/json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ date: state.date, generatedAt: state.generatedAt, races: state.races })); return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(page(u.searchParams))
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT} で待機中`)
  console.log('最初の予想を作成中（30〜60秒）...')
  refresh()
  setInterval(refresh, EVERY)
})
