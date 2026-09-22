// スマホから当日の進捗を見るための軽量サーバ。単勝と複勝を1画面で見る。
//
//   node scripts/status.mjs                 http://localhost:3940
//   node scripts/status.mjs --port 3940
//
// ★予想は計算しない（通常の表示では）
//   serve.mjs は predict.mjs を回すので起動に30秒〜1分かかる。
//   進捗を見るだけなら bets テーブルを読むだけでよく、即座に返せる。
//   スマホで開いた時に待たされないことが大事。
//   「予想」ボタンを押したときだけ、裏で refresh-picks.mjs を回す。
//
// ★同じLANの端末から見られるように 0.0.0.0 で待つ
//   PCと同じWi-Fiにいるスマホから http://<PCのIP>:3940 で開ける。
//   **認証は無い。**LAN内に置く前提。外に出すなら必ず認証をかけること。

import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { cardPage } from './racecard.mjs'
import { apiRoute } from './api.mjs'
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { MARGIN, MAX_BUY, FUKU, FUKU90, CHECK_FROM, CHECK_UNTIL, minOddsFor } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const PORT = Number(flag('port', 3940))
const p2 = (n) => String(n).padStart(2, '0')
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// ★LABEL は札の表示、TICKET は「実際に買う舟券」。
//   高的中モードは選び方が違うだけで、買うのは普通の複勝。
//   「高的中」とだけ出すと単勝か複勝か分からない、という指摘を受けて分けた。
const LABEL = { tansho: '単勝', fukusho: '複勝', fuku90: '複勝・高的中' }
const TICKET = { tansho: '単勝', fukusho: '複勝', fuku90: '複勝' }
// ★必要倍率は買い目ごとに違う（1÷確率×余裕）。固定倍率ではない。
const MARGIN_OF = { tansho: MARGIN, fukusho: FUKU.margin }
// ★高的中モードだけは固定の下限（損益分岐方式ではない）
const needFor = (t, p) => (t === 'fuku90' ? FUKU90.minOdds : minOddsFor(p, MARGIN_OF[t] ?? MARGIN))
const RULE_OF = { tansho: `(1÷確率)×${MARGIN}`, fukusho: `(1÷確率)×${FUKU.margin}`,
  fuku90: `確率${FUKU90.minP * 100}%以上×${FUKU90.minOdds}倍以上` }

// ---------- 予想の実行状態 ----------
// ★1つずつしか走らせない。4〜5分かかる処理を並行で叩かれると壊れる。
let job = { running: false, started: null, line: '', code: null }
function runPredict() {
  if (job.running) return false
  job = { running: true, started: new Date(), line: '準備中...', code: null }
  const p = spawn(process.execPath, ['--max-old-space-size=6144', join(ROOT, 'scripts', 'refresh-picks.mjs')],
    { cwd: ROOT })
  const tail = (d) => { const l = String(d).trim().split('\n').filter(Boolean).pop(); if (l) job.line = l.slice(0, 120) }
  p.stdout.on('data', tail); p.stderr.on('data', tail)
  p.on('close', (c) => { job.running = false; job.code = c; job.line = c === 0 ? '完了' : `失敗（code ${c}）` })
  return true
}

// ★人が実際に買ったかを記録する列。判定(decision)とは別物。
//   decision = システムが「買え」と言ったか
//   user_action = 人が実際に買ったか（bought / passed）
//   締切前オッズは確定と一致しないので、最終判断は人がする。その記録が要る。
function ensureCols(db) {
  for (const c of ['user_action TEXT', 'user_at TEXT'])
    try { db.exec('ALTER TABLE bets ADD COLUMN ' + c) } catch {}
}
export function recordAction(raceId, lane, betType, action) {
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  try {
    db.exec('PRAGMA busy_timeout = 3000'); ensureCols(db)
    db.prepare('UPDATE bets SET user_action=?, user_at=? WHERE race_id=? AND lane=? AND bet_type=?')
      .run(action, new Date().toTimeString().slice(0, 8), raceId, Number(lane), betType)
  } catch {} finally { db.close() }
}

// ★当日の結果を公式ページから取る。
//   着順(entries)と払戻(payouts)は翌日15時のKファイル取り込みまで入らない。
//   それだと「買ったのに勝ったのか負けたのか、翌日まで分からない」。
//   買った買い目は1日数本なので、そのレースだけ結果ページを見る。
//   ★同期で待たない（前に execFileSync で画面が固まった）。裏で取って溜める。
const resCache = new Map()   // race_id -> { ord:[艇番], tan:[{lane,yen}], fuku:[{lane,yen}] }
const resBusy = new Set()

// ★取りに行くのは1レースずつ、間隔を空けて。
//   買った分だけなら1日数本だが、**見送った分も的中していたか見たい**ので
//   1日150レース分になる。まとめて叩くと公式に負担をかけるうえ弾かれる。
//   → 待ち行列に積んで 800ms に1件ずつ。150件でも2分で埋まる。
//   締切の新しい順に取る（さっき見送ったレースがすぐ分かるほうが役に立つ）。
const resQueue = []
let resTimer = null
function enqueueResult(raceId) {
  if (resCache.has(raceId) || resBusy.has(raceId) || resQueue.includes(raceId)) return
  resQueue.push(raceId)
  if (!resTimer) resTimer = setInterval(() => {
    const id = resQueue.pop()          // 新しく積まれたもの＝締切が新しいものから
    if (!id) { clearInterval(resTimer); resTimer = null; return }
    fetchResult(id)
  }, 800)
  resTimer.unref?.()
}

function fetchResult(raceId) {
  if (resCache.has(raceId) || resBusy.has(raceId)) return
  resBusy.add(raceId)
  const jcd = raceId.slice(9, 11), rno = Number(raceId.slice(12)), hd = raceId.slice(0, 8)
  fetch(`https://www.boatrace.jp/owpc/pc/race/raceresult?rno=${rno}&jcd=${jcd}&hd=${hd}`,
    { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.text())
    .then((h) => {
      // 着順表：<td class="is-fs14 is-fBold is-boatColorN">艇番</td> が1着から順に並ぶ
      // ★正規表現をシェル経由で書くとバックスラッシュが消える。必ず [0-9] を使う
      const ord = [...new Set([...h.matchAll(/<td class="is-fs14 is-fBold is-boatColor[0-9]">([0-9])<[/]td>/g)].map((m) => Number(m[1])))]
      if (ord.length < 3) return                       // まだ確定していない
      // 払戻は tbody 単位で「単勝」「複勝」の塊を切り出す
      const bodies = [...h.matchAll(/<tbody>([^]*?)<[/]tbody>/g)].map((m) => m[1])
      const pick = (kw) => {
        const b = bodies.find((x) => x.includes('>' + kw + '</td>')); if (!b) return []
        return [...b.matchAll(/numberSet1_number[^>]*>([0-9])<[/]span>[^]{0,300}?is-payout1">&yen;([0-9,]+)/g)]
          .map((m) => ({ lane: Number(m[1]), yen: Number(m[2].replace(/,/g, '')) }))
      }
      resCache.set(raceId, { ord, tan: pick('単勝'), fuku: pick('複勝') })
    })
    .catch(() => {})
    .finally(() => resBusy.delete(raceId))
}

function data(date) {
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  // ★auto-bet が書き込み中でも待ちすぎない。画面が固まるより古い値を出すほうがまし。
  try { db.exec('PRAGMA busy_timeout = 3000'); ensureCols(db) } catch {}
  let rows = [], total = {}
  try {
    rows = db.prepare(`SELECT b.*, py.amount, e.rank_num FROM bets b
      LEFT JOIN payouts py ON py.race_id=b.race_id AND py.bet_type=(CASE b.bet_type WHEN 'fuku90' THEN 'fukusho' ELSE b.bet_type END) AND py.combo=CAST(b.lane AS TEXT)
      LEFT JOIN entries e ON e.race_id=b.race_id AND e.lane=b.lane
      WHERE b.date=? ORDER BY b.deadline`).all(date)
  } catch {}
  try {
    const all = db.prepare(`SELECT b.bet_type, b.date, py.amount, e.rank_num FROM bets b
      LEFT JOIN payouts py ON py.race_id=b.race_id AND py.bet_type=(CASE b.bet_type WHEN 'fuku90' THEN 'fukusho' ELSE b.bet_type END) AND py.combo=CAST(b.lane AS TEXT)
      LEFT JOIN entries e ON e.race_id=b.race_id AND e.lane=b.lane
      WHERE b.decision='buy'`).all()
    for (const k of ['tansho', 'fukusho']) {
      // ★複勝は2着以内なので rank_num===1 では判定できない。払戻の有無で見る。
      const won = (r) => k === 'tansho' ? r.rank_num === 1 : r.amount != null
      const s = all.filter((r) => r.bet_type === k && r.rank_num != null)
      total[k] = { n: s.length, bet: s.length * 100, hit: s.filter(won).length,
        ret: s.reduce((a, r) => a + (won(r) ? (r.amount ?? 0) : 0), 0),
        days: new Set(all.filter((r) => r.bet_type === k).map((r) => r.date)).size }
    }
  } catch {}
  db.close()
  return { rows, total }
}

// ---------- 常駐プロセスの生死 ----------
// ★8/22に判定が31分止まっていたのに気づけなかった。
//   画面が更新されていても、裏で判定が死んでいれば買い目は出ない。
// ★プロセス確認は「裏で」やる。リクエストの中では絶対にやらない。
//   execFileSync はイベントループ全体を止める。PowerShell の Get-CimInstance は
//   平時でも6.5秒かかり、予想の計算で負荷が高いとさらに延びる。
//   2026-08-23 に実際これで画面が全く開かなくなった（同期処理が詰まった）。
//   → 30秒ごとに裏で更新し、リクエストは保持している値を即返すだけにする。
// ★常駐プロセスが生きているかは「生存記録ファイルの更新時刻」で見る。
//   以前は PowerShell でプロセス一覧を取っていたが、spawn経由だと
//   -Command の中の二重引用符が壊れて **必ず exit 1** になり、
//   常に「停止中あり」と赤字が出ていた（直接叩くと動くので気づきにくい）。
//   1回1.8秒かかるのも無駄なので、各プロセスが自分で書く方式にした。
//   古い版が動いていてファイルが無い場合は、ログの更新時刻で代用する。
const AGE = (p) => { try { return (Date.now() - statSync(join(ROOT, 'logs', p)).mtimeMs) / 60000 } catch { return null } }
const newestLog = (prefix) => {
  try {
    const dir = join(ROOT, 'logs')
    const t = readdirSync(dir).filter((x) => x.startsWith(prefix) && !x.startsWith('err-'))
      .map((f) => { try { return statSync(join(dir, f)).mtimeMs } catch { return 0 } })
      .reduce((x, y) => Math.max(x, y), 0)
    return t ? (Date.now() - t) / 60000 : null
  } catch { return null }
}
function workers() {
  // ★許容時間は「何を見ているか」で変える。
  //   生存記録は毎周回書かれるので8分で判断できる。
  //   代用のログは**判定した時にしか書かれない**ので、締切の空く時間帯は
  //   20分以上空く。同じ8分で見ると生きているのに×が出る（実際に出た）。
  const chk = (name, hb, logPrefix) => {
    const beat = AGE(hb)
    const m = beat ?? newestLog(logPrefix)
    const limit = beat != null ? 8 : 40
    return { name, on: m != null && m < limit, min: m == null ? null : Math.round(m) }
  }
  return [
    chk('オッズ記録', 'hb-odds-live.txt', 'live-'),
    chk('買い目判定', 'hb-auto-bet.txt', 'bet-'),
  ]
}


function page(date, demo = false) {
  const { rows, total } = data(date)
  // ★?demo=1 は表示の確認用。DBには書かず、画面に見本を1件混ぜるだけ。
  if (demo) {
    const hhmm = (mins) => { const d = new Date(Date.now() + mins * 60_000)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
    // 3券種とも、買い／見送り／判定待ちの見本を1件ずつ出す
    const mk = (o) => rows.push({ race_id: 'demo' + rows.length, win_rate: null, amount: null, rank_num: null, date, ...o })
    mk({ lane: 3, bet_type: 'tansho', venue: '（見本）大村', race_no: 9, deadline: hhmm(9),
      racer: '山田太郎', p: 0.34, odds_seen: 6.4, decision: 'buy' })
    mk({ lane: 1, bet_type: 'tansho', venue: '（見本）住之江', race_no: 5, deadline: hhmm(26),
      racer: '佐藤次郎', p: 0.62, odds_seen: null, decision: 'pending' })
    mk({ lane: 1, bet_type: 'tansho', venue: '（見本）桐生', race_no: 3, deadline: hhmm(-40),
      racer: '鈴木三郎', p: 0.51, odds_seen: 2.8, decision: 'skip' })
    mk({ lane: 2, bet_type: 'fukusho', venue: '（見本）福岡', race_no: 7, deadline: hhmm(14),
      racer: '田中四郎', p: 0.71, odds_seen: 2.1, decision: 'buy' })
    mk({ lane: 1, bet_type: 'fukusho', venue: '（見本）徳山', race_no: 11, deadline: hhmm(-70),
      racer: '高橋五郎', p: 0.83, odds_seen: 1.2, decision: 'skip' })
    mk({ lane: 1, bet_type: 'fuku90', venue: '（見本）大村', race_no: 2, deadline: hhmm(4),
      racer: '伊藤六郎', p: 0.96, odds_seen: 1.3, decision: 'buy' })
    mk({ lane: 1, bet_type: 'fuku90', venue: '（見本）下関', race_no: 8, deadline: hhmm(-95),
      racer: '渡辺七郎', p: 0.95, odds_seen: 1.0, decision: 'skip' })
  }
  const now = new Date()
  // ★過去の日を見ているときは、今日の時計で締切を比べてはいけない。
  //   14:39締切の昨日のレースが「まだ先」と判定され、買った記録が
  //   「今すぐ買えます」側に出てしまっていた。
  const isToday = date === today()
  const nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : 24 * 60 + 1
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  // ★勝敗は「翌日入るKファイル」か「当日取った結果ページ」のどちらかで判定する。
  //   Kファイルが入るまでは resCache 側を使うので、買ったその日に勝敗が分かる。
  const liveRes = (r) => resCache.get(r.race_id)
  const won = (r) => {
    if (r.rank_num != null) return r.bet_type === 'tansho' ? r.rank_num === 1 : r.amount != null
    const v = liveRes(r); if (!v) return null
    const i = v.ord.indexOf(r.lane)
    return r.bet_type === 'tansho' ? i === 0 : (i === 0 || i === 1)
  }
  const payOf = (r) => {
    if (r.amount != null) return r.amount
    const v = liveRes(r); if (!v) return null
    return (r.bet_type === 'tansho' ? v.tan : v.fuku).find((x) => x.lane === r.lane)?.yen ?? null
  }
  const resHtml = (r) => {
    const w = won(r); if (w == null) return ''
    const y = payOf(r)
    return w ? `<b class="win">的中${y != null ? ' ' + y + '円' : ''}</b>` : '<span class="lose">はずれ</span>'
  }
  // 締切を過ぎた買い目の結果を裏で取りにいく（1日数本なので軽い）
  // ★買った分だけでなく、見送った分も結果を取る。
  //   「見送ったが当たっていた」が続くなら足切りが厳しすぎる、と分かる。
  //   締切が古い順に積む＝pop で新しい順に取り出される。
  {
    const need = rows.filter((r) => r.rank_num == null && toMin(r.deadline) < nowMin - 3)
      .sort((a, b) => toMin(a.deadline) - toMin(b.deadline))
    for (const r of need) {
      if (r.decision === 'buy') fetchResult(r.race_id)   // 買った分は待たせない
      else enqueueResult(r.race_id)
    }
  }

  const KIND = ['tansho', 'fukusho', 'fuku90']
  const PL = (k) => k === 'tansho' ? '1着' : '2着以内'
  const isDemo = demo

  // ★券種ごとの1行。色は左の札で見分ける
  const leg = (r) => {
    const until = toMin(r.deadline) - nowMin
    const th = needFor(r.bet_type, r.p).toFixed(2)
    const res = resHtml(r)
    const st = r.decision === 'buy' ? `<span class="st buy">買い ${r.odds_seen?.toFixed(1)}倍</span>`
      : r.decision === 'skip' ? `<span class="st skip">見送り ${r.odds_seen?.toFixed(1)}倍</span>`
      : r.decision === 'no_odds' ? '<span class="st skip">オッズ未形成</span>'
      : r.decision === 'capped' ? '<span class="st skip">上限到達</span>'
      : r.decision === 'missed' ? '<span class="st skip">判定できず</span>'
      : `<span class="st wait">${until >= 0 ? (until <= CHECK_FROM ? '判定中' : `あと${until}分`) : '締切'}</span>`
    const ua = r.user_action === 'bought' ? '<span class="ua bought">買った</span>'
      : r.user_action === 'passed' ? '<span class="ua passed">見送った</span>' : ''
    return `<div class="leg">
      <span class="kk ${r.bet_type}">${LABEL[r.bet_type]}</span>
      <span>${PL(r.bet_type)}${(r.p * 100).toFixed(0)}%</span>
      <span class="th">${th}倍以上なら買い</span> ${ua} ${res} ${st}
    </div>`
  }

  // ★レース単位でまとめる。同じレースの単勝・複勝・高的中を1枚に並べる
  const raceCards = (list) => {
    const by = new Map()
    for (const r of list) {
      const k = r.race_id
      let g = by.get(k); if (!g) { g = []; by.set(k, g) }
      g.push(r)
    }
    return [...by.values()]
      .sort((x, y) => toMin(x[0].deadline) - toMin(y[0].deadline))
      .map((g) => {
        g.sort((x, y) => KIND.indexOf(x.bet_type) - KIND.indexOf(y.bet_type))
        const h = g[0]
        return `<div class="race">
          <div class="rh"><span class="dl">${esc(h.deadline)}</span> <b>${esc(h.venue)}${h.race_no}R</b>
            <span class="who">${h.lane}号艇 ${esc(h.racer)}</span></div>
          ${g.map(leg).join('')}
        </div>`
      }).join('')
  }

  // ★「今から買えるもの」だけを最上部に大きく出す。
  //   締切を過ぎた買い目は行動できないので、ここには出さない（下の一覧に残る）。
  const live = rows.filter((r) => r.decision === 'buy' && toMin(r.deadline) - nowMin >= 0)
    .sort((a, b) => toMin(a.deadline) - toMin(b.deadline))
  const hero = live.length ? `<div class="hero">
    <div class="ht">今すぐ買えます　${live.length}件</div>
    ${live.map((r) => {
      const m = toMin(r.deadline) - nowMin
      const need = needFor(r.bet_type, r.p).toFixed(2)
      // ★買った／見送った を人が押して記録する。
      //   締切前オッズは確定と一致しないので、最終判断は人がする。その結果を残す。
      const q = `r=${encodeURIComponent(r.race_id)}&l=${r.lane}&t=${r.bet_type}${isDemo ? '&demo=1' : ''}`
      const act = r.user_action
        ? `<div class="done ${r.user_action}">${r.user_action === 'bought' ? '買いました' : '見送りました'}${r.user_at ? '（' + esc(r.user_at.slice(0, 5)) + '）' : ''}</div>`
        : `<div class="act">
            <form method="post" action="/act?${q}&a=bought"><button class="go" type="submit">買った</button></form>
            <form method="post" action="/act?${q}&a=passed"><button class="no" type="submit">見送った</button></form>
          </div>`
      return `<div class="hb ${r.bet_type}">
        <div class="hrow"><span class="hk ${r.bet_type}">${LABEL[r.bet_type]}</span>
          <span class="hv">${esc(r.venue)}${r.race_no}R</span>
          <span class="hm${m <= 3 ? ' urg' : ''}">締切${esc(r.deadline)}・あと${m}分</span></div>
        <div class="hn">${r.lane}号艇　${esc(r.racer)}</div>
        <div class="ho ${r.bet_type}">${TICKET[r.bet_type]} <b>${r.odds_seen?.toFixed(1)}倍</b>
          <span class="hp2">${PL(r.bet_type)}${(r.p * 100).toFixed(0)}%</span></div>
        <div class="need">${need}倍を下回っていたら買わないこと</div>
        ${act}
      </div>`
    }).join('')}</div>` : '<div class="hero none">現在、買える買い目はありません</div>'

  // ★券種ごとの本数だけ上に出し、一覧はレース単位でまとめる
  const tiles = `<div class="sum">${KIND.map((k) => {
    const rs = rows.filter((r) => r.bet_type === k)
    const t = total[k] ?? { n: 0, bet: 0, ret: 0 }
    const roi = t.bet ? (t.ret / t.bet * 100).toFixed(0) + '%' : '—'
    return `<div class="${k}"><b>${rs.filter((r) => r.decision === 'buy').length}</b>
      <span>${LABEL[k]}の買い<br>累計${roi}（${t.n}点）</span></div>`
  }).join('')}</div>`

  const pend = rows.filter((r) => r.decision === 'pending' && toMin(r.deadline) >= nowMin)
  const done = rows.filter((r) => r.decision !== 'pending' && !(r.decision === 'buy' && toMin(r.deadline) - nowMin >= 0))
  // ★買った買い目は締切を過ぎても消さない。
  //   前は「今すぐ買えます」だけで、レースが終わると上から消えて追えなくなっていた。
  const boughtAll = rows.filter((r) => r.decision === 'buy').sort((a, b) => toMin(a.deadline) - toMin(b.deadline))
  const doneBuys = boughtAll.filter((r) => toMin(r.deadline) - nowMin < 0)
  const kept = doneBuys.length ? `<section>
    <h2>本日 買い判定が出たもの<span class="sub">締切後も残します・結果は分かり次第</span></h2>
    ${doneBuys.map((r) => {
      const y = payOf(r), w = won(r)
      const ua = r.user_action === 'bought' ? '<span class="ua bought">買った</span>'
        : r.user_action === 'passed' ? '<span class="ua passed">見送った</span>' : '<span class="ua passed">未記録</span>'
      return `<div class="race">
        <div class="rh"><span class="dl">${esc(r.deadline)}</span> <b>${esc(r.venue)}${r.race_no}R</b>
          <span class="who">${r.lane}号艇 ${esc(r.racer)}</span></div>
        <div class="leg"><span class="kk ${r.bet_type}">${LABEL[r.bet_type]}</span>
          <span>判定時 <b>${r.odds_seen?.toFixed(1)}倍</b></span>
          ${ua}
          <span class="st ${w == null ? 'wait' : w ? 'buy' : 'skip'}">${w == null ? '結果待ち' : w ? '的中' + (y != null ? ' ' + y + '円' : '') : 'はずれ'}</span></div>
      </div>`
    }).join('')}
  </section>` : ''

  // ★見送りが当たっていたかの集計。
  //   足切りが厳しすぎないかを判断する材料。的中率が高くても、そのオッズでは
  //   買っても負けるので「当たっていた＝間違い」ではない。そこは取り違えないこと。
  const skipStat = () => {
    const KIND2 = ['tansho', 'fukusho', 'fuku90']
    const out = KIND2.map((k) => {
      const s = rows.filter((r) => r.bet_type === k && r.decision === 'skip' && won(r) != null)
      if (!s.length) return null
      const h = s.filter((r) => won(r))
      const avg = h.length ? h.reduce((a, r) => a + (payOf(r) ?? 0), 0) / h.length : 0
      return `<div class="leg"><span class="kk ${k}">${LABEL[k]}</span>
        <span>見送り ${s.length}本中 <b>${h.length}本が的中</b>（${(h.length / s.length * 100).toFixed(0)}%）</span>
        <span class="th">買っていたら回収${(s.reduce((a, r) => a + (won(r) ? (payOf(r) ?? 0) : 0), 0) / (s.length * 100) * 100).toFixed(0)}%${h.length ? `・平均配当${Math.round(avg)}円` : ''}</span></div>`
    }).filter(Boolean)
    if (!out.length) return ''
    return `<div class="race" style="margin-bottom:14px">
      <div class="rh"><b>見送った買い目は当たっていたか</b>
        <span class="who">結果が取れたものだけ</span></div>${out.join('')}</div>`
  }

  const list = `<section>
    <h2>本日の判定<span class="sub">レースごと・券種は色で分けています</span></h2>
    ${tiles}
    ${skipStat()}
    <h3>判定待ち</h3>${pend.length ? raceCards(pend) : '<p class="empty">なし</p>'}
    <h3>判定済み</h3>${done.length ? raceCards(done) : '<p class="empty">なし</p>'}
  </section>`

  const w = workers()
  const ng = w.filter((x) => !x.on)
  const jb = job.running
    ? `<div class="job run"><span class="spin"></span>予想を計算中…（30秒〜1分）　<i>${esc(job.line)}</i></div>`
    : job.code != null ? `<div class="job ${job.code === 0 ? 'ok' : 'ng'}">前回の予想: ${esc(job.line)}</div>` : ''

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${job.running ? 15 : live.length ? 5 : 20}">
<title>競艇 ${date}</title>
<style>
/* ★配色の考え方
   前は「明るい緑の上に白文字」で読めなかった（本人の指摘）。
   面を明るくするのはやめ、**濃い面 × 明るい文字**か **淡い面 × 濃い文字**に統一する。
   券種は色で見分ける：単勝=青／複勝=緑／高的中=金。3色とも明暗どちらでも判別できる。 */
:root{
  --bg:#f2f5f8; --card:#fff; --ink:#111820; --mut:#57636f; --line:#dbe3ea; --line2:#eef2f6;
  --tan:#1c5fb0; --tanb:#e8f0fb;      /* 単勝 */
  --fuk:#0f6b4f; --fukb:#e5f4ee;      /* 複勝 */
  --hit:#8a5a00; --hitb:#fbf1dd;      /* 高的中 */
  --urg:#a3341f; --ok:#0f6b4f; --skip:#6b7683; --acc:#0e5a73;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0b1016; --card:#151d26; --ink:#e9eff5; --mut:#9aa8b6; --line:#26313d; --line2:#1c2530;
  --tan:#74aef5; --tanb:#132234;
  --fuk:#57cfa2; --fukb:#0f2620;
  --hit:#e5bb63; --hitb:#2a2113;
  --urg:#f08a72; --ok:#57cfa2; --skip:#8996a4; --acc:#63bcd6;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;padding:12px 12px 40px}
h1{font-size:1.05rem;margin:0 0 2px}
.meta{color:var(--mut);font-size:12px;margin:0 0 12px}
.bar{display:flex;gap:8px;margin-bottom:12px}
.bar form{flex:1;margin:0}
.bar button{width:100%;padding:12px;border-radius:10px;border:1px solid var(--acc);background:var(--card);color:var(--acc);font:inherit;font-weight:700;cursor:pointer}
.bar button.p{background:var(--acc);color:var(--card)}
.bar button:disabled{opacity:.5;cursor:default}

/* 今すぐ買えるもの。面は暗いまま、券種の色は左の帯と札で示す */
.hero{border:2px solid var(--ok);border-radius:14px;padding:12px 12px 4px;margin-bottom:14px;background:var(--card)}
.hero.none{border:1px dashed var(--line);color:var(--mut);text-align:center;padding:16px;font-size:13px}
.ht{font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--ok);margin-bottom:9px}
.hb{border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;padding:11px 13px;margin-bottom:9px;background:var(--line2)}
.hb.tansho{border-left-color:var(--tan)} .hb.fukusho{border-left-color:var(--fuk)} .hb.fuku90{border-left-color:var(--hit)}
.hrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px}
.hk{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:99px;border:1px solid currentColor}
.hk.tansho{color:var(--tan)} .hk.fukusho{color:var(--fuk)} .hk.fuku90{color:var(--hit)}
.hv{font-size:1.15rem;font-weight:800}
.hm{margin-left:auto;font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.hm.urg{font-weight:800;color:var(--card);background:var(--urg);padding:2px 9px;border-radius:99px}
.hn{font-size:1.4rem;font-weight:800;line-height:1.35}
.ho{font-size:1.05rem;font-weight:700;margin-top:2px}
.ho b{font-size:1.7rem;font-variant-numeric:tabular-nums}
.ho.tansho b{color:var(--tan)} .ho.fukusho b{color:var(--fuk)} .ho.fuku90 b{color:var(--hit)}
.hp2{font-size:12px;font-weight:400;color:var(--mut);margin-left:8px}
.need{font-size:12.5px;color:var(--mut);margin-top:4px}
.need b{color:var(--ink)}

/* 買った／見送った のボタン */
.act{display:flex;gap:8px;margin-top:10px}
.act form{flex:1;margin:0}
.act button{width:100%;padding:11px 6px;border-radius:9px;font:inherit;font-weight:700;font-size:14px;cursor:pointer;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
.act button.go{border-color:var(--ok);color:var(--ok)}
.act button.no{border-color:var(--skip);color:var(--mut)}
.done{margin-top:10px;font-size:13px;font-weight:700;padding:9px;border-radius:9px;text-align:center}
.done.bought{background:var(--fukb);color:var(--fuk)}
.done.passed{background:var(--line2);color:var(--mut)}

.hpz{display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:12px;font-size:12px}
.hpz.bad{border-color:var(--urg)}
.hpz .ok{color:var(--ok)} .hpz .ng{color:var(--urg);font-weight:700}
.hpz i{font-style:normal;color:var(--mut);margin-left:4px}
.job{border-radius:10px;padding:9px 12px;margin-bottom:12px;font-size:12.5px;border:1px solid var(--line);background:var(--card)}
.job.run{border-color:var(--hit);background:var(--hitb)}
.job.ng{border-color:var(--urg)}
.job i{font-style:normal;color:var(--mut)}
.spin{display:inline-block;width:9px;height:9px;border:2px solid var(--hit);border-top-color:transparent;border-radius:50%;margin-right:7px;animation:s .8s linear infinite;vertical-align:-1px}
@keyframes s{to{transform:rotate(360deg)}}

section{margin-bottom:24px}
h2{font-size:1rem;margin:0 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line);display:flex;align-items:baseline;gap:8px}
h2 .sub{font-size:11.5px;color:var(--mut);font-weight:400}
h3{font-size:.78rem;color:var(--mut);margin:16px 0 6px;font-weight:600;letter-spacing:.04em}
.sum{display:flex;gap:8px;margin-bottom:14px}
.sum div{flex:1;background:var(--card);border:1px solid var(--line);border-top-width:3px;border-radius:10px;padding:9px 6px;text-align:center}
.sum div.tansho{border-top-color:var(--tan)} .sum div.fukusho{border-top-color:var(--fuk)} .sum div.fuku90{border-top-color:var(--hit)}
.sum b{display:block;font-size:1.25rem;font-variant-numeric:tabular-nums}
.sum span{font-size:10.5px;color:var(--mut)}

/* レース単位でまとめる。券種は左の帯と札の色で見分ける */
.race{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin-bottom:7px}
.rh{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.rh .dl{font-variant-numeric:tabular-nums;color:var(--mut);font-size:13px}
.rh b{font-size:1.02rem}
.rh .who{color:var(--mut);font-size:12.5px;margin-left:auto}
.leg{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:5px 0 4px;border-top:1px solid var(--line2);font-size:12.5px}
.leg:first-of-type{border-top:0}
.kk{font-size:11px;font-weight:700;padding:1px 8px;border-radius:99px;border:1px solid currentColor;flex:none}
.kk.tansho{color:var(--tan)} .kk.fukusho{color:var(--fuk)} .kk.fuku90{color:var(--hit)}
.leg .st{margin-left:auto;font-size:11.5px;padding:2px 8px;border-radius:99px;white-space:nowrap}
.st.buy{background:var(--ok);color:var(--card);font-weight:700}
.st.skip{background:var(--line);color:var(--skip)}
.st.wait{background:var(--hitb);color:var(--hit);font-weight:700}
.leg .th{color:var(--mut)}
.ua{font-size:11px;font-weight:700;padding:1px 7px;border-radius:99px;border:1px solid currentColor}
.ua.bought{color:var(--fuk)} .ua.passed{color:var(--mut)}
.win{color:var(--ok);font-weight:700} .lose{color:var(--mut)}
.empty{color:var(--mut);font-size:12.5px;padding:6px 2px;margin:0}
.note{color:var(--mut);font-size:11.5px;line-height:1.85;margin-top:20px;border-top:1px solid var(--line);padding-top:12px}
.note b{color:var(--ink)}
</style></head><body>
<h1>競艇 買い目　${date}</h1>${`<div style="margin:6px 0 10px;display:flex;gap:14px"><a href="/asa" style="font-size:13px;color:inherit">朝の見張り表 →</a><a href="/haishin" style="font-size:13px;color:inherit">配信用 →</a></div>`}
<p class="meta">${now.toTimeString().slice(0, 5)} 時点／${job.running ? 15 : live.length ? 5 : 20}秒ごとに自動更新</p>
<div class="bar">
  <form method="get" id="rf"><button type="submit">更新</button></form>
  <form method="post" action="/predict"><button type="submit" class="p"${job.running ? ' disabled' : ''}>${job.running ? '計算中…' : '予想'}</button></form>
</div>
${hero}
${kept}
${jb}
<div class="hpz ${ng.length ? 'bad' : ''}">${w.map((x) =>
  `<span class="${x.on ? 'ok' : 'ng'}">${x.on ? '●' : '×'} ${x.name}${x.min != null ? `<i>${x.min}分前</i>` : ''}</span>`).join('')}
  ${ng.length ? '<b style="color:#c2410c;font-size:11.5px;width:100%">停止中あり。30分以内に自動復帰します</b>' : ''}</div>
${list}
<p class="note">
単勝：<b>必要倍率＝(1÷1着確率)×${MARGIN}</b>／1日${MAX_BUY}本まで<br>
　　　想定 的中35.8%・回収193.9%（573点・1日2.54本・月別8/8）<br>
複勝：<b>必要倍率＝(1÷2着以内確率)×${FUKU.margin}</b>（複勝は下限で見る）／1日${FUKU.maxBuy}本まで<br>
　　　想定 的中60.3%・回収188.5%（693点・1日3.07本・月別8/8）<br>
高的中：<b>買うのは複勝</b>。2着以内確率${FUKU90.minP * 100}%以上 かつ ${FUKU90.minOdds}倍以上／1日${FUKU90.maxBuy}本まで<br>
　　　想定 <b>的中91.9%</b>・回収128.1%（149点・1日1.39本・月別8/8・最高配当4.5倍）<br>
　　　複勝の中で当てる回数を最優先する別枠（上の複勝とは選び方が違うだけ）。<br>　　　荒れやすい4場（宮島・児島・尼崎・蒲郡）は外しています。<br>
<b>買うのは締切2〜3分前。表示の倍率は目安なので、その場のオッズが必要倍率を下回っていたら買わないこと。</b><br>
判定は各レースの締切${CHECK_FROM}分前〜${CHECK_UNTIL}分前に自動で行われます。<br>
歩進検証2026年1〜8月・実払戻・締切が早い順・1日の上限つき。<br>
<b>100点に届くまで実績は判断材料になりません。</b>
</p>
<script>
(function () {
  var loadedAt = Date.now();
  // ★新しい買い目に気づけるようにする。
  //   判定は締切8〜12分前に出るが、画面を見ていなければ気づけない。
  //   Windows通知はPCの前にいないと見えないので、スマホ側でも鳴らす。
  //   直前に見た買い目を localStorage に持ち、増えていたら音とバイブを出す。
  var ids = ${JSON.stringify(live.map((r) => r.race_id + '|' + r.bet_type + '|' + r.lane))};
  try {
    var seen = JSON.parse(localStorage.getItem('seenBuys') || '[]');
    var fresh = ids.filter(function (x) { return seen.indexOf(x) < 0; });
    if (fresh.length) {
      localStorage.setItem('seenBuys', JSON.stringify(ids.concat(seen).slice(0, 50)));
      document.title = '★買い目 ' + ids.length + '件';
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
      // 短いビープを3回。無音モードだと鳴らないのでバイブと併用する。
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          var ac = new AC();
          [0, 0.35, 0.7].forEach(function (t) {
            var o = ac.createOscillator(), g = ac.createGain();
            o.connect(g); g.connect(ac.destination);
            o.frequency.value = 880; g.gain.value = 0.25;
            o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.18);
          });
        }
      } catch (e) {}
    } else if (ids.length) { document.title = '買い目 ' + ids.length + '件'; }
  } catch (e) {}
  // ★更新はURLに時刻を付け直して読み込む。
  //   同じURLのままだとスマホのブラウザが保存済みの内容を出すことがある。
  //   ?demo=1 などの指定は引き継ぐ（時刻だけ差し替える）。
  function reload() {
    var p = new URLSearchParams(location.search);
    p.set('t', String(Date.now()));
    location.replace(location.pathname + '?' + p.toString());
  }
  var f = document.getElementById('rf');
  if (f) f.addEventListener('submit', function (e) { e.preventDefault(); reload(); });
  // 見出しをタップしても更新できる
  var h = document.querySelector('h1');
  if (h) { h.style.cursor = 'pointer'; h.title = 'タップで更新'; h.addEventListener('click', reload); }
  // ★スマホでタブを戻したときに自動更新する。
  //   meta refresh は画面が隠れている間は止まるので、戻った瞬間は古いままになる。
  //   ただし読み込み直後は無視する（表示 → 再読込 → 表示 の連鎖を防ぐ）。
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - loadedAt > 3000) reload();
  });
})();
</script>
</body></html>`
}

// ★朝の見張り表（/asa）
//   watchlist.mjs が作る data/watch-YYYY-MM-DD.json を読んで、
//   「どのレースのどの艇を、オッズいくら以上で買うか」を一覧にする。
//   締切前にオッズを見て、必要倍率を超えていれば買う。
//   朝の時点ではオッズが無いので、ここでは「買え」とは言わない。見張る対象を示すだけ。
function asaData(date) {
  const f = join(ROOT, "data", `watch-${date}.json`)
  // ⚠ ここで try/catch を広く取ると、import 漏れなどの本当の誤りを握り潰す（実際に一度やった）。
  //   ファイルが無い場合だけ null にして、それ以外は落とす。
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, "utf8"))
}
function asaPage(date, margin) {
  const d = asaData(date)
  const M = String(margin)
  const head = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>朝の見張り表 ${date}</title>
<style>
:root{--bg:#eef1f4;--card:#fff;--ink:#101820;--sub:#5f7080;--line:#d3dbe2;--hit:#0d6b3f;--warn:#b01026}
@media(prefers-color-scheme:dark){:root{--bg:#0c1116;--card:#151d25;--ink:#e6edf3;--sub:#8fa1b0;--line:#25313c}}
*{box-sizing:border-box}
body{margin:0;padding:12px 10px 60px;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;line-height:1.6}
h1{font-size:17px;margin:4px 0 2px}
.sub{font-size:12.5px;color:var(--sub);margin-bottom:10px}
.tabs{display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap}
.tabs a{padding:6px 13px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--ink);text-decoration:none;font-size:13px}
.tabs a.on{background:var(--ink);color:var(--bg);border-color:var(--ink);font-weight:700}
.r{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}
.rh{display:flex;justify-content:space-between;align-items:baseline;padding:9px 12px;
border-bottom:1px solid var(--line);background:rgba(0,0,0,.02)}
.rh b{font-size:14.5px}
.rh a.cardlink{color:inherit;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}.rh span{font-size:12.5px;color:var(--sub)}
.b{display:flex;align-items:center;gap:9px;padding:7px 12px;border-bottom:1px solid var(--line);font-size:14px}
.b:last-child{border-bottom:none}
.ln{width:22px;height:22px;border-radius:5px;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff;flex:0 0 auto}
.l1{background:#555}.l2{background:#111}.l3{background:#c0392b}.l4{background:#2565c7}.l5{background:#d4a017}.l6{background:#1e8449}
.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p{font-variant-numeric:tabular-nums;color:var(--sub);font-size:12.5px;width:52px;text-align:right}
.o{font-variant-numeric:tabular-nums;font-weight:700;width:76px;text-align:right}
.o.hi{color:var(--hit)}.o.no{color:var(--sub);font-weight:400}
.note2{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sub);
border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--sub);margin-bottom:12px}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);
border-radius:8px;padding:11px 13px;font-size:13px;margin-bottom:12px}
</style>`
  // ★B2判定の表示は 2026-09-01 に本人の指定で外した。記録（b2_daily）は続けている。
  //   戻すときは git 履歴から b2html のブロックを拾う。
  const b2html = ""

  if (!d) return head + `<h1>朝の見張り表</h1><div class="sub">${date}</div>` +
    b2html + `<div class="note2">${date} の見張り表（オッズ条件）はありません。<br>買うのはB2判定だけなので、無くても支障はありません。</div>`
  const tabs = d.margins.map((m) => `<a href="/asa?date=${date}&m=${m}"${String(m) === M ? " class=\"on\"" : ""}>余裕 ${m.toFixed(1)}</a>`).join("")

  let n = 0
  const body = d.races.map((r) => {
    const bs = r.boats.filter((b) => b.need[M] != null && b.need[M] <= 30)
    if (!bs.length) return ""
    n += bs.length
    const rows = bs.map((b) => `<div class="b"><div class="ln l${b.lane}">${b.lane}</div>` +
      `<div class="nm">${esc(b.name || "")}</div>` +
      `<div class="p">${(b.pc * 100).toFixed(1)}%</div>` +
      `<div class="o hi">${b.need[M].toFixed(1)}倍〜</div></div>`).join("")
    return `<div class="r"><div class="rh"><b>${esc(r.venue)} ${r.race_no}R</b>` +
      `<span>締切 ${esc(r.deadline || "-")}</span></div>${rows}</div>`
  }).join("")
  return head + `<h1>朝の見張り表</h1><div class="sub">${date}　${d.races.length}レース　見張る艇 ${n}本</div>` +
    `<div class="tabs">${tabs}<a href="/">当日の判定へ</a><a href="/haishin">配信用</a></div>` + b2html +
    `<div class="note"><b>⚠ 2026-08-31：この判定は実測で成立していません</b><br>
単勝は総取り式で、<b>払戻は締切後に決まります</b>。締切前の表示は目安でしかありません。<br>
締切0分前の実測（6,486件）で、表示が高いほど確定で崩れます：<br>
　20〜50倍の表示 → 確定はその<b>0.688倍</b>／50倍以上 → <b>0.395倍</b><br>
この判定は高オッズの艇を狙うので、これを丸ごと受けます。<br>
さらに締切前オッズの記録自体が<b>85%壊れていました</b>（板が開く前の値など）。<br>
健全な記録だけで測り直しても <b>回収 87.1%（マイナス・336本/9日）</b>。<br>
確定オッズで判定できたなら111.3%なので、<b>差はオッズのズレ</b>です。<br>
帯ごとの補正も試しましたが効きませんでした（65.9%→63.3%）。<br>
⚠ ただし336本しかありません。<b>結論ではなく「まだ言えない」状態</b>です。<br>
<b>実弾を入れる前に、この画面の数字は信用しないでください。</b>
</div>`
    + `<div class="note2"><b>もとの使い方（いま検証中）</b><br>
締切前にオッズを見て、表示の倍率以上なら単勝を買う。下回っていれば見送る。<br>
1レースで複数出たら、条件を満たしたものは全部買う。<br>
※ 従来ここに出していた「回収172.7%」は<b>確定オッズで判定した場合</b>の数字で、
締切前には実現できません。
</div>`
    + `<div class="note2"><b>この一覧は「候補」です</b><br>
朝はオッズが分からないので、ここでは買う艇を決められません。<b>見張る対象</b>を並べています。<br>
オッズが必要倍率に届くのは一部だけで、実測では<b>見張り515本のうち実際に買うのは1日64本</b>、
<b>7割のレースは1本も買いません</b>。<br>
必要倍率が30倍を超えるものは現実に届かないので隠しています。
</div>` + (body || "<div class=\"note\">条件に合う艇がありません。</div>")
}
// ★配信用（/haishin）
//   haishin.mjs が haishin_daily に入れた「当てにいく予想」を見せる。
//   ⚠ 買う判定（/ と /asa）とは狙いが逆。混ぜないこと。
//     買う判定 … 単勝。的中16.5%・回収172.7%。当たらないが増える。
//     配信用   … 3連複/3連単。的中は高いが**回収はマイナス**。
// ★N点プラン（/plan2 = 3連複2点）。2026-09-19に追加。
//   記録(haishin_daily)は4点ぶん入っているので、その上位N点を見せているだけ。
//   選び方は同じ（自信度0.7645以上）。新しい記録を作らないので実績もそのまま読める。
function haishinPage(date, N = 4) {
  const TRIO = N < 4          // 点数を絞ったときは3連複だけのプランとして見せる
  const REF = { 1: ['37.3%', '84.9%'], 2: ['58.9%', '83.1%'], 3: ['74.0%', '83.1%'], 4: ['82.5%', '81.7%'] }[N]
  const head = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TRIO ? `3連複${N}点プラン` : '配信用'} ${date}</title>
<style>
:root{--bg:#eef1f4;--card:#fff;--ink:#101820;--sub:#5f7080;--line:#d3dbe2;--hit:#0d6b3f;--warn:#b01026}
@media(prefers-color-scheme:dark){:root{--bg:#0c1116;--card:#151d25;--ink:#e6edf3;--sub:#8fa1b0;--line:#25313c}}
*{box-sizing:border-box}
body{margin:0;padding:12px 10px 60px;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;line-height:1.6}
h1{font-size:17px;margin:4px 0 2px}
.sub{font-size:12.5px;color:var(--sub);margin-bottom:10px}
.tabs{display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap}
.tabs a{padding:6px 13px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--ink);text-decoration:none;font-size:13px}
.r{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}
.rh{display:flex;justify-content:space-between;align-items:baseline;padding:9px 12px;
border-bottom:1px solid var(--line);background:rgba(0,0,0,.02)}
.rh b{font-size:14.5px}.rh span{font-size:12.5px;color:var(--sub)}
.k{padding:7px 12px;border-bottom:1px solid var(--line);font-size:14px;display:flex;gap:10px;align-items:baseline}
.k:last-child{border-bottom:none}
.kl{font-size:12px;color:var(--sub);width:44px;flex:0 0 auto}
.kl.ana{color:#b8860b;font-weight:700}
.kv{font-variant-numeric:tabular-nums;letter-spacing:.02em}
.kv i{font-style:normal;margin-right:11px;display:inline-block}
.kv i.h{color:var(--hit);font-weight:700}
.kv i.m{color:var(--sub)}
.kv i em{font-style:normal;font-size:11.5px;margin-left:3px;color:var(--hit);font-weight:700}
.sumline{padding:6px 12px;font-size:12.5px;color:var(--sub);border-top:1px solid var(--line);
font-variant-numeric:tabular-nums}
.sumline b{font-size:14px;color:var(--ink)}.sumline b.g{color:var(--hit)}
.sumline span{margin-left:4px}
.cf{font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--sub)}
.rh .res{font-size:12.5px;color:var(--sub);font-variant-numeric:tabular-nums}
.rh .res b.g{color:var(--hit)}.rh .res b.x{color:var(--sub);font-weight:400}
.r.won{border-color:var(--hit)}
.r.lost{opacity:.72}
.sum{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px;margin-bottom:12px}
.sumh{font-size:13px;font-weight:700;margin-bottom:7px}
.sr{display:flex;flex-direction:column;gap:1px;padding:6px 0;border-top:1px solid var(--line);font-size:13px}
.sr b{font-size:13px}
.sr span{font-size:12.5px;color:var(--sub);font-variant-numeric:tabular-nums}
.sr span b{color:var(--ink)}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);
border-radius:8px;padding:11px 13px;font-size:13px;margin-bottom:12px}
.note2{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sub);
border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--sub);margin-bottom:12px}
</style>`
  // ⚠ ここを広い try/catch にすると、db の取り違えのような本当の誤りを握り潰す。
  //   実際に一度やった（db はモジュール直下に無く関数内で開く作りなのを見落とし、
  //   ReferenceError が catch に吸われて「配信用がありません」と出た）。
  //   テーブルが無い場合だけ空にして、それ以外は落とす。
  const hdb = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  let rows = []
  const live = new Map()   // race_id → "1-5-3"（確定した着順）
  const off = new Set()   // 順延・中止のレース
  try {
    hdb.exec('PRAGMA busy_timeout = 3000')
    const has = hdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='haishin_daily'").get()
    if (has) rows = hdb.prepare(`SELECT race_id,venue,race_no,deadline,conf,kind,rank,combo,hit,payout,
      COALESCE(ana,0) ana FROM haishin_daily WHERE date=? AND rank<=?
      ${TRIO ? `AND kind='sanrenpuku'` : ''} ORDER BY deadline, race_id, kind, rank`).all(date, N)
    // 着順は当日取り（raceresult.mjs → result_live）。翌日のKファイルが来るまではこれが唯一の結果。
    const hasR = hdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='result_live'").get()
    if (hasR) for (const r of hdb.prepare(`SELECT race_id,lane1,lane2,lane3 FROM result_live
      WHERE date=? AND status='ok'`).all(date)) live.set(r.race_id, `${r.lane1}-${r.lane2}-${r.lane3}`)
    // ★順延・中止。走らないので結果は永久に来ない。「締切 14:24」のまま何時間も残ると
    //   壊れて見える（2026-09-09の江戸川がそうだった）。成績の分母には入れない。
    if (hasR) for (const r of hdb.prepare(`SELECT race_id FROM result_live
      WHERE date=? AND status='cancel'`).all(date)) off.add(r.race_id)
  } finally { hdb.close() }
  const title = TRIO ? `3連複${N}点プラン` : '配信用の予想'
  const tabs = `<div class="tabs">` +
    (TRIO ? `<a href="/haishin?date=${date}">4点＋3連単</a>` : `<a href="/plan2?date=${date}">3連複2点プラン</a>`) +
    `<a href="/tansho?date=${date}">無料予想（単勝1点）</a><a href="/seiseki">これまでの実績</a><a href="/spot?date=${date}">企画枠</a><a href="/">当日の判定</a><a href="/asa?date=${date}">朝の見張り表</a></div>`
  if (!rows.length) return head + `<h1>${title}</h1><div class="sub">${date}</div>` + tabs +
    `<div class="note">${date} の配信用がありません。<br><br>作るには:<br><code>node scripts/haishin.mjs --date ${date}</code></div>`
  const R = new Map()
  for (const r of rows) {
    let a = R.get(r.race_id)
    if (!a) { a = { id: r.race_id, v: r.venue, n: r.race_no, dl: r.deadline, cf: r.conf, f: [], t: [] }; R.set(r.race_id, a) }
    ;(r.kind === 'sanrenpuku' ? a.f : a.t).push(r)
  }
  // ★その日の成績。判定できたレースだけを分母にする（まだ走っていない分は入れない）。
  const done = [...R.values()].filter((a) => a.f.some((x) => x.hit != null))
  const sc = (arr) => {
    const hit = arr.filter((a) => a.some((x) => x.hit === 1)).length
    const ret = arr.reduce((s, a) => s + a.reduce((t, x) => t + (x.hit === 1 ? (x.payout ?? 0) : 0), 0), 0)
    const bets = arr.reduce((s, a) => s + a.length, 0)
    return { hit, n: arr.length, ret, bets }
  }
  const F = sc(done.map((a) => a.f)), T = sc(done.map((a) => a.t))
  const line = (nm, s, ref) => !s.n ? '' :
    `<div class="sr"><b>${nm}</b><span>${s.hit}/${s.n}本 的中 <b>${(s.hit / s.n * 100).toFixed(0)}%</b>` +
    `<span class="cf">（過去の実測 ${ref}）</span></span><span>払戻 ${s.ret.toLocaleString()}円 ／ ` +
    `${(s.bets * 100).toLocaleString()}円ぶん買った場合 回収 ${(s.ret / (s.bets * 100) * 100).toFixed(0)}%</span></div>`
  const score = !done.length ? '' :
    `<div class="sum"><div class="sumh">きょうの結果　${done.length}/${R.size}レース終了</div>` +
    line(`3連複${N}点`, F, TRIO ? REF[0] : '80.9%') + (TRIO ? '' : line('3連単4点', T, '44.1%')) +
    `<div class="cf" style="margin-top:6px">※ 結果は公式の結果ページから取っています（翌朝の競走成績で上書き）。
本数が少ないうちは的中率が大きく振れます。</div></div>`

  // ★当たった買い目の隣に払戻を出す（2026-09-01に追加）。
  //   配信では「当たった」だけでなく「いくらになったか」が見せ場になる。
  const yen = (v) => (v == null ? '' : Number(v).toLocaleString() + '円')
  const cell = (x, sep) => `<i class="${x.hit === 1 ? 'h' : (x.hit === 0 ? 'm' : '')}">${esc(x.combo.split('-').join(sep))}` +
    `${x.hit === 1 && x.payout != null ? `<em>${yen(x.payout)}</em>` : ''}</i>`
  const body = [...R.values()].map((a) => {
    const w = live.get(a.id)
    const hitF = a.f.some((x) => x.hit === 1), hitT = a.t.some((x) => x.hit === 1)
    // そのレースで買っていたらいくら戻ったか（4点表示なら3連複4点＋3連単4点＝800円ぶん）
    const cost = (a.f.length + a.t.length) * 100
    const got = [...a.f, ...a.t].reduce((v, x) => v + (x.hit === 1 ? (x.payout ?? 0) : 0), 0)
    const done = [...a.f, ...a.t].some((x) => x.hit != null)
    const isOff = off.has(a.id)
    const res = isOff
      ? '<span class="res"><b class="x">中止・順延</b></span>'
      : w
      ? `<span class="res">結果 ${esc(w)}　${hitT ? '<b class="g">3連単的中</b>' : (hitF ? '<b class="g">3連複的中</b>' : '<b class="x">不的中</b>')}</span>`
      : `<span>締切 ${esc(a.dl || '-')}</span>`
    const sum = done
      ? `<div class="sumline">${cost}円ぶん買っていたら　<b class="${got > cost ? 'g' : ''}">${yen(got)}</b>` +
        `<span>（${got >= cost ? '+' : ''}${(got - cost).toLocaleString()}円）</span></div>`
      : ''
    return `<div class="r${isOff ? ' lost' : w ? (hitF || hitT ? ' won' : ' lost') : ''}">
<div class="rh"><b><a class="cardlink" href="/card?race=${esc(a.id)}">${esc(a.v)} ${a.n}R</a></b>${res}<span class="cf">自信度 ${(a.cf * 100).toFixed(0)}</span></div>
<div class="k"><div class="kl">3連複</div><div class="kv">${a.f.map((x) => cell(x, '=')).join('')}</div></div>
${TRIO ? '' : `<div class="k"><div class="kl">3連単</div><div class="kv">${a.t.map((x) => cell(x, '-')).join('')}</div></div>`}
${sum}</div>`
  }).join('')
  const intro = TRIO
    ? `<div class="note"><b>これは買う判定ではありません</b><br>
1レース<b>3連複を${N}点だけ</b>買うプランです。本番モデルで学習に使っていない175日・2,689レースを実測して<br>
<b>${N}点 ${REF[0]}</b> が当たります。ただし<b>回収率は ${REF[1]} でマイナス</b>。買い続けると減ります。<br>
1レース${N * 100}円・1日15本前後なので、1日あたり ${15 * N * 100}円前後です。<br>
買うのは <a href="/asa?date=${date}">朝の見張り表</a> の単勝だけにしてください。
</div>`
    : `<div class="note"><b>これは買う判定ではありません</b><br>
当てることを優先した予想です。本番モデルで学習後の22,614レースを実測して<br>
<b>3連複4点 80.9%</b>／<b>3連単4点 44.1%</b> が当たります。<br>
ただし<b>回収率はマイナス</b>（3連複80.3%・3連単85.0%）。買い続けると減ります。<br>
買うのは <a href="/asa?date=${date}">朝の見張り表</a> の単勝だけにしてください。
</div>`
  return head + `<h1>${title}</h1><div class="sub">${date}　${R.size}レース</div>` + tabs + score + intro + body +
    `<div class="note2">絞りは<b>自信度</b>（3連複の上位4点の確率の合計）が0.76以上＝本番モデルの上位10%のレース。
朝の予想だけで決まるので、オッズは使っていません。<br>
1日15本前後。自信のあるレースが少ない日は本数が減ります。<br>
${TRIO ? `出しているのは<b>確率の高い順に${N}点</b>です。4点ぶんは <a href="/haishin?date=${date}">こちら</a>。<br>` : ''}
的中したものは<b>緑</b>で出ます（<code>node scripts/haishin.mjs --fill</code> のあと）。</div>`
}
// ★記事生成用のJSON（/plan2.json）
//   読み手はGPT。人が見る画面と同じ記録(haishin_daily)から作るので、記事の買い目と実績が必ず一致する。
//   status: ok … 予想あり / empty … その日の予想が1件も無い（バッチ停止など。記事を作らないこと）
//   各レースの closed=true は締切済み。これから投稿する記事には使わない。
function planJson(date, N = 2) {
  const REF = { 1: ['37.3%', '84.9%'], 2: ['58.9%', '83.1%'], 3: ['74.0%', '83.1%'], 4: ['82.5%', '81.7%'] }[N]
  const jdb = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  let rows = [], live = new Map(), off = new Set(), rec = null
  try {
    jdb.exec('PRAGMA busy_timeout = 3000')
    const has = jdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='haishin_daily'").get()
    if (has) {
      rows = jdb.prepare(`SELECT race_id,venue,race_no,deadline,conf,kind,rank,combo,p,hit,payout FROM haishin_daily
        WHERE date=? AND rank<=? ORDER BY deadline, race_id, kind, rank`).all(date, N)
      rec = jdb.prepare(`SELECT MAX(recorded_at) m FROM haishin_daily WHERE date=?`).get(date)?.m ?? null
    }
    const hasR = jdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='result_live'").get()
    if (hasR) for (const r of jdb.prepare(`SELECT race_id,lane1,lane2,lane3,status FROM result_live WHERE date=?`).all(date)) {
      if (r.status === 'cancel') off.add(r.race_id)
      else if (r.status === 'ok') live.set(r.race_id, `${r.lane1}-${r.lane2}-${r.lane3}`)
    }
  } finally { jdb.close() }
  // 時刻はすべて日本時間で返す（toISOString は UTC なので使わない）
  const jst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)
  const now = new Date(), nowHM = jst(now).slice(11), isToday = jst(now).slice(0, 10) === date
  const R = new Map()
  for (const r of rows) {
    let a = R.get(r.race_id)
    if (!a) {
      a = { race_id: r.race_id, venue: r.venue, race_no: r.race_no, deadline: r.deadline,
        confidence: Math.round(r.conf * 100), trio: [], trifecta: [] }
      R.set(r.race_id, a)
    }
    const pick = { combo: r.kind === 'sanrenpuku' ? r.combo.split('-').join('=') : r.combo, probability: Math.round(r.p * 1000) / 10,
      hit: r.hit == null ? null : r.hit === 1, payout: r.hit === 1 ? r.payout : null }
    if (r.kind === 'sanrenpuku') a.trio.push(pick)
    else if (N === 4) a.trifecta.push(pick)
  }
  const races = [...R.values()].map((a) => ({
    ...a,
    closed: isToday ? (a.deadline ?? '99:99') <= nowHM : date < jst(now).slice(0, 10),
    cancelled: off.has(a.race_id),
    result: live.get(a.race_id) ?? null,
    ...(N === 4 ? {} : { trifecta: undefined }),
  }))
  return {
    status: races.length ? 'ok' : 'empty',
    message: races.length ? null
      : `${date} の予想はまだありません。記事は作らないでください（生成前か、夜間の処理が止まっています）。`,
    date, plan: `3連複${N}点`, points_per_race: N, yen_per_race: N * 100,
    generated_at: rec ? jst(new Date(rec)) : null, now: jst(now),
    races_total: races.length, races_open: races.filter((x) => !x.closed && !x.cancelled).length,
    reference: { hit_rate: REF[0], return_rate: REF[1],
      basis: '本番モデル・学習に使っていない175日・2,689レースの実測',
      note: '回収率は100%未満（買い続けると減る）。的中を優先した予想。' },
    races,
  }
}
// ★配信の実績（/seiseki）
//   毎日の的中を積み上げて見せる。配信に出す以上、当たった日だけでなく
//   外した日も同じ表に並べる。都合の良い日だけ見せないための作り。
function seisekiPage(N = 4) {
  // ★N点ぶんの実績（2026-09-19）。記録は4点ぶん入っているので rank<=N で絞るだけ。
  const TRIO = N < 4
  const REF = { 1: ['37.3%', '84.9%'], 2: ['58.9%', '83.1%'], 3: ['74.0%', '83.1%'], 4: ['82.5%', '81.7%'] }[N]
  const sdb = new DatabaseSync(join(ROOT, "data", "boatrace.db"))
  let days = [], tot = null, best = []
  try {
    sdb.exec("PRAGMA busy_timeout = 3000")
    const has = sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='haishin_daily'").get()
    if (has) {
      // 1レース＝1口として数える（4点セットで当たれば1）
      days = sdb.prepare(`SELECT date,
        COUNT(DISTINCT race_id) races,
        COUNT(DISTINCT CASE WHEN hit IS NOT NULL THEN race_id END) done,
        COUNT(DISTINCT CASE WHEN kind='sanrenpuku' AND hit=1 THEN race_id END) f_hit,
        COUNT(DISTINCT CASE WHEN kind='sanrentan'  AND hit=1 THEN race_id END) t_hit,
        SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret,
        SUM(CASE WHEN hit IS NOT NULL THEN 100 ELSE 0 END) inv
        FROM haishin_daily WHERE rank<=? ${TRIO ? "AND kind='sanrenpuku'" : ''} GROUP BY date ORDER BY date DESC`).all(N)
      tot = days.reduce((a, d) => ({ races: a.races + d.races, done: a.done + d.done,
        f: a.f + d.f_hit, t: a.t + d.t_hit, ret: a.ret + (d.ret ?? 0), inv: a.inv + (d.inv ?? 0) }),
        { races: 0, done: 0, f: 0, t: 0, ret: 0, inv: 0 })
      best = sdb.prepare(`SELECT date,venue,race_no,kind,combo,payout FROM haishin_daily
        WHERE hit=1 AND payout IS NOT NULL AND rank<=? ${TRIO ? "AND kind='sanrenpuku'" : ''} ORDER BY payout DESC LIMIT 8`).all(N)
    }
  } finally { sdb.close() }
  const head = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TRIO ? `3連複${N}点プランの実績` : "配信の実績"}</title>
<style>
:root{--bg:#eef1f4;--card:#fff;--ink:#101820;--sub:#5f7080;--line:#d3dbe2;--hit:#0d6b3f;--warn:#b01026}
@media(prefers-color-scheme:dark){:root{--bg:#0c1116;--card:#151d25;--ink:#e6edf3;--sub:#8fa1b0;--line:#25313c}}
*{box-sizing:border-box}
body{margin:0;padding:12px 10px 60px;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;line-height:1.6}
h1{font-size:17px;margin:4px 0 2px}
.sub{font-size:12.5px;color:var(--sub);margin-bottom:10px}
.tabs{display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap}
.tabs a{padding:6px 13px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--ink);text-decoration:none;font-size:13px}
.big{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:13px;margin-bottom:12px}
.big h2{font-size:13px;margin:0 0 9px;color:var(--sub);font-weight:600}
.n{display:flex;gap:16px;flex-wrap:wrap}
.n div{min-width:96px}
.n b{display:block;font-size:26px;font-variant-numeric:tabular-nums;line-height:1.15}
.n span{font-size:11.5px;color:var(--sub)}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:7px 5px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}
th{font-size:11.5px;color:var(--sub);font-weight:600}
.wrap{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 12px 8px;margin-bottom:12px;overflow-x:auto}
.wrap h2{font-size:13px;margin:10px 0 4px}
.g{color:var(--hit);font-weight:700}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sub);
border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--sub);margin-bottom:12px}
</style>`
  const tabs = `<div class="tabs">${TRIO ? '<a href="/plan2">きょうの2点プラン</a><a href="/seiseki">4点＋3連単の実績</a>' : '<a href="/haishin">きょうの予想</a><a href="/seiseki?n=2">3連複2点プランの実績</a>'}<a href="/tansho">無料予想（単勝1点）</a><a href="/">当日の判定</a><a href="/asa">朝の見張り表</a></div>`
  if (!tot || !tot.done) return head + `<h1>${TRIO ? `3連複${N}点プランの実績` : "配信の実績"}</h1>` + tabs +
    `<div class="note">まだ結果がありません。</div>`
  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : "0.0")
  return head + `<h1>${TRIO ? `3連複${N}点プランの実績` : "配信の実績"}</h1><div class="sub">${days.length}日ぶん・${tot.done}レース（結果が出たもの）</div>` + tabs +
`<div class="big"><h2>ぜんぶ合わせて</h2><div class="n">
<div><b class="g">${pct(tot.f, tot.done)}%</b><span>3連複${N}点 の的中<br>${tot.f}/${tot.done}レース</span></div>
${TRIO ? '' : `<div><b class="g">${pct(tot.t, tot.done)}%</b><span>3連単4点 の的中<br>${tot.t}/${tot.done}レース</span></div>`}
<div><b>${pct(tot.ret, tot.inv)}%</b><span>回収率<br>（マイナスが続きます）</span></div>
</div></div>
<div class="wrap"><h2>日ごと</h2><table>
<tr><th>日付</th><th>レース</th><th>3連複</th>${TRIO ? '' : '<th>3連単</th>'}<th>払戻</th></tr>
${days.map((d) => `<tr><td>${d.date.slice(5)}</td><td>${d.done}${d.done < d.races ? ` <span style="color:var(--sub)">/${d.races}</span>` : ""}</td>
<td>${d.f_hit}<span style="color:var(--sub)">（${pct(d.f_hit, d.done)}%）</span></td>
${TRIO ? '' : `<td>${d.t_hit}<span style="color:var(--sub)">（${pct(d.t_hit, d.done)}%）</span></td>`}
<td>${(d.ret ?? 0).toLocaleString()}円</td></tr>`).join("")}
</table></div>
<div class="wrap"><h2>大きかった的中</h2><table>
<tr><th>日付</th><th>レース</th><th>券種</th><th>買い目</th><th>払戻</th></tr>
${best.map((b) => `<tr><td>${b.date.slice(5)}</td><td>${esc(b.venue)}${b.race_no}R</td>
<td>${b.kind === "sanrenpuku" ? "3連複" : "3連単"}</td>
<td>${esc(b.combo.split("-").join(b.kind === "sanrenpuku" ? "=" : "-"))}</td>
<td class="g">${(b.payout ?? 0).toLocaleString()}円</td></tr>`).join("")}
</table></div>
<div class="note">1レース＝1口（${N}点セット）で数えています。<br>
${TRIO ? `過去の実測（学習外175日・2,689レース）は 3連複${N}点 ${REF[0]}・回収 ${REF[1]}。<br>` : "過去の実測は 3連複4点 80.9% ／ 3連単4点 44.1%。<br>"}
<b>回収率はマイナスです。</b>当てることを優先した予想で、買い続けると減ります。<br>
外した日も同じ表に並べています。都合の良い日だけ見せないためです。</div>`
}
// ★企画枠（/spot）＝場を指定した全レース予想
//   通常の配信（/haishin）は自信度で絞った15本前後。こちらは**場の全レース**。
//   当たりにくいレースも入るので的中率は下がる。
//   **/seiseki（配信の実績）には入れない。**混ぜると配信の数字が濁る。
function spotPage(date) {
  const sdb = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  let rows = []
  const live = new Map()
  const off = new Set()   // 順延・中止のレース
  try {
    sdb.exec('PRAGMA busy_timeout = 3000')
    const has = sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spot_daily'").get()
    if (has) rows = sdb.prepare(`SELECT race_id,venue,race_no,deadline,series,day_no,conf,kind,rank,combo,hit,payout
      FROM spot_daily WHERE date=? ORDER BY race_no, kind, rank`).all(date)
    const hasR = sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='result_live'").get()
    if (hasR) for (const r of sdb.prepare(`SELECT race_id,lane1,lane2,lane3 FROM result_live
      WHERE date=? AND status='ok'`).all(date)) live.set(r.race_id, `${r.lane1}-${r.lane2}-${r.lane3}`)
    // ★順延・中止。走らないので結果は永久に来ない。「締切 14:24」のまま何時間も残ると
    //   壊れて見える（2026-09-09の江戸川がそうだった）。成績の分母には入れない。
    if (hasR) for (const r of sdb.prepare(`SELECT race_id FROM result_live
      WHERE date=? AND status='cancel'`).all(date)) off.add(r.race_id)
  } finally { sdb.close() }
  const head = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>企画枠 ${date}</title>
<style>
:root{--bg:#eef1f4;--card:#fff;--ink:#101820;--sub:#5f7080;--line:#d3dbe2;--hit:#0d6b3f;--acc:#7a4bd0}
@media(prefers-color-scheme:dark){:root{--bg:#0c1116;--card:#151d25;--ink:#e6edf3;--sub:#8fa1b0;--line:#25313c}}
*{box-sizing:border-box}
body{margin:0;padding:12px 10px 60px;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;line-height:1.6}
h1{font-size:17px;margin:4px 0 2px}
.sub{font-size:12.5px;color:var(--sub);margin-bottom:10px}
.tabs{display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap}
.tabs a{padding:6px 13px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--ink);text-decoration:none;font-size:13px}
.r{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}
.r.won{border-color:var(--hit)}.r.lost{opacity:.72}
.rh{display:flex;justify-content:space-between;align-items:baseline;gap:6px;padding:9px 12px;
border-bottom:1px solid var(--line);background:rgba(0,0,0,.02)}
.rh b{font-size:14.5px}.rh span{font-size:12.5px;color:var(--sub)}
.rh .g{color:var(--hit);font-weight:700}.rh .x{color:var(--sub);font-weight:400}
.k{padding:7px 12px;border-bottom:1px solid var(--line);font-size:14px;display:flex;gap:10px;align-items:baseline}
.kl{font-size:12px;color:var(--sub);width:44px;flex:0 0 auto}
.kv{font-variant-numeric:tabular-nums;letter-spacing:.02em}
.kv i{font-style:normal;margin-right:11px;display:inline-block}
.kv i.h{color:var(--hit);font-weight:700}.kv i.m{color:var(--sub)}
.kv i em{font-style:normal;font-size:11.5px;margin-left:3px;color:var(--hit);font-weight:700}
.sumline{padding:6px 12px;font-size:12.5px;color:var(--sub);border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
.sumline b{font-size:14px;color:var(--ink)}.sumline b.g{color:var(--hit)}
.cf{font-size:11.5px;color:var(--sub);font-variant-numeric:tabular-nums}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);
border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--sub);margin-bottom:12px}
</style>`
  const tabs = `<div class="tabs"><a href="/haishin">きょうの配信</a><a href="/seiseki">配信の実績</a><a href="/">当日の判定</a></div>`
  if (!rows.length) return head + `<h1>企画枠</h1><div class="sub">${date}</div>` + tabs +
    `<div class="note">${date} の企画枠がありません。<br><br>作るには:<br><code>node scripts/spot.mjs --date ${date} --jcd 9</code></div>`
  const R = new Map()
  for (const r of rows) {
    let a = R.get(r.race_id)
    if (!a) { a = { id: r.race_id, v: r.venue, n: r.race_no, dl: r.deadline, se: r.series, dn: r.day_no, cf: r.conf, f: [], t: [] }; R.set(r.race_id, a) }
    ;(r.kind === 'sanrenpuku' ? a.f : a.t).push(r)
  }
  const first = [...R.values()][0]
  const yen = (v) => (v == null ? '' : Number(v).toLocaleString() + '円')
  const cell = (x, sep) => `<i class="${x.hit === 1 ? 'h' : (x.hit === 0 ? 'm' : '')}">${esc(x.combo.split('-').join(sep))}` +
    `${x.hit === 1 && x.payout != null ? `<em>${yen(x.payout)}</em>` : ''}</i>`
  const done = [...R.values()].filter((a) => a.f.some((x) => x.hit != null))
  const hf = done.filter((a) => a.f.some((x) => x.hit === 1)).length
  const ht = done.filter((a) => a.t.some((x) => x.hit === 1)).length
  const got = done.reduce((s, a) => s + [...a.f, ...a.t].reduce((v, x) => v + (x.hit === 1 ? (x.payout ?? 0) : 0), 0), 0)
  const score = !done.length ? '' :
    `<div class="note" style="border-left-color:var(--hit);color:var(--ink)">
<b>途中経過　${done.length}/${R.size}レース終了</b><br>
3連複4点 <b>${hf}/${done.length}</b>（${(hf / done.length * 100).toFixed(0)}%）
3連単4点 <b>${ht}/${done.length}</b>（${(ht / done.length * 100).toFixed(0)}%）<br>
${(done.length * 800).toLocaleString()}円ぶん買っていたら <b class="${got > done.length * 800 ? 'g' : ''}">${yen(got)}</b>
（${got >= done.length * 800 ? '+' : ''}${(got - done.length * 800).toLocaleString()}円）</div>`
  const body = [...R.values()].map((a) => {
    const w = live.get(a.id)
    const hitF = a.f.some((x) => x.hit === 1), hitT = a.t.some((x) => x.hit === 1)
    const g = [...a.f, ...a.t].reduce((v, x) => v + (x.hit === 1 ? (x.payout ?? 0) : 0), 0)
    const fin = [...a.f, ...a.t].some((x) => x.hit != null)
    const isOff = off.has(a.id)
    const res = isOff
      ? '<span><b class="x">中止・順延</b></span>'
      : w
      ? `<span>結果 ${esc(w)}　${hitT ? '<b class="g">3連単的中</b>' : (hitF ? '<b class="g">3連複的中</b>' : '<b class="x">不的中</b>')}</span>`
      : `<span>締切 ${esc(a.dl || '-')}</span>`
    const sum = fin
      ? `<div class="sumline">800円ぶん買っていたら　<b class="${g > 800 ? 'g' : ''}">${yen(g)}</b>（${g >= 800 ? '+' : ''}${(g - 800).toLocaleString()}円）</div>`
      : ''
    return `<div class="r${isOff ? ' lost' : w ? (hitF || hitT ? ' won' : ' lost') : ''}">
<div class="rh"><b><a class="cardlink" href="/card?race=${esc(a.id)}">${esc(a.v)} ${a.n}R</a></b>${res}<span class="cf">自信度 ${(a.cf * 100).toFixed(0)}</span></div>
<div class="k"><div class="kl">3連複</div><div class="kv">${a.f.map((x) => cell(x, '=')).join('')}</div></div>
<div class="k"><div class="kl">3連単</div><div class="kv">${a.t.map((x) => cell(x, '-')).join('')}</div></div>
${sum}</div>`
  }).join('')
  return head + `<h1>${esc(first.v)}　${esc(first.se || '')}</h1>` +
    `<div class="sub">${date}　${first.dn ? first.dn + '日目　' : ''}全${R.size}レース</div>` + tabs + score +
    `<div class="note"><b>これは企画枠です</b><br>
場を指定した<b>全レース</b>の予想で、当たりにくいレースも入っています。<br>
通常の配信（<a href="/haishin">きょうの配信</a>）は自信度で絞った15本前後で、そちらとは別物です。<br>
<b>この結果は配信の実績（/seiseki）には入れていません。</b><br>
絞りなしの過去実測は 3連複4点 63.7% ／ 3連単4点 30.5%（絞ると80.9% ／ 44.1%）。</div>` + body
}
// ★無料公開する枠（/tansho）＝単勝1点だけ
//   作っているのは scripts/tansho.mjs → tansho_daily。
//   /haishin（3連複4点・3連単4点）とは券種が違うので、テーブルも画面も分ける。
//   ⚠ ここに出す回収率は**前向きの記録だけ**を分母にする。
//     過去データの検証値（96.3%）は前向き実測（84.0%）と12pt離れた。原因は2つ：
//       1. races.grade が 2026-08-19〜09-05 の間 NULL（→ 直すと86.5%。差の1/3だけ埋まる）
//       2. 学習と本番で入力が違う。model4.mjs は races.wave / wind_speed を使うが
//          これはレース後の値で、02:00バッチの --nobefore は取得ごと飛ばす。
//          学習期間に波高NULLのレースは0本＝モデルは「不明」を見たことがない。
//     どちらも直るまで、無料で配る画面に検証値を出さない。
function tanshoPage(date) {
  const tdb = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  let rows = [], days = [], tot = null
  const off = new Set()   // 順延・中止のレース
  try {
    tdb.exec('PRAGMA busy_timeout = 3000')
    const has = tdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tansho_daily'").get()
    if (has) {
      rows = tdb.prepare(`SELECT race_id,venue,race_no,deadline,lane,racer,p,hit,payout
        FROM tansho_daily WHERE date=? ORDER BY deadline, race_id`).all(date)
      days = tdb.prepare(`SELECT date, COUNT(*) bets,
        SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) done,
        SUM(COALESCE(hit,0)) hits,
        SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret
        FROM tansho_daily GROUP BY date ORDER BY date DESC`).all()
      tot = days.reduce((a, d) => ({ done: a.done + d.done, hits: a.hits + d.hits,
        ret: a.ret + (d.ret ?? 0) }), { done: 0, hits: 0, ret: 0 })
    }
    // ★順延・中止のレース。走らないので結果は永久に来ない。
    //   これを出さないと「結果待ち」のまま何時間も残って、壊れているように見える
    //   （2026-09-09の江戸川がまさにそれだった）。成績の分母には入れない。
    const hasR = tdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='result_live'").get()
    if (hasR) for (const r of tdb.prepare(`SELECT race_id FROM result_live
      WHERE date=? AND status='cancel'`).all(date)) off.add(r.race_id)
  } finally { tdb.close() }
  const head = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>無料予想 単勝1点 ${date}</title>
<style>
:root{--bg:#eef1f4;--card:#fff;--ink:#101820;--sub:#5f7080;--line:#d3dbe2;--hit:#0d6b3f;--warn:#b01026}
@media(prefers-color-scheme:dark){:root{--bg:#0c1116;--card:#151d25;--ink:#e6edf3;--sub:#8fa1b0;--line:#25313c}}
*{box-sizing:border-box}
body{margin:0;padding:12px 10px 60px;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;line-height:1.6}
h1{font-size:17px;margin:4px 0 2px}
.sub{font-size:12.5px;color:var(--sub);margin-bottom:10px}
.tabs{display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap}
.tabs a{padding:6px 13px;border-radius:999px;border:1px solid var(--line);
background:var(--card);color:var(--ink);text-decoration:none;font-size:13px}
.big{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:13px;margin-bottom:12px}
.big h2{font-size:13px;margin:0 0 9px;color:var(--sub);font-weight:600}
.n{display:flex;gap:16px;flex-wrap:wrap}
.n div{min-width:96px}
.n b{display:block;font-size:26px;font-variant-numeric:tabular-nums;line-height:1.15}
.n span{font-size:11.5px;color:var(--sub)}
.r{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:7px;
display:flex;justify-content:space-between;align-items:center;padding:9px 12px;gap:10px}
.r.won{border-color:var(--hit)}.r.lost{opacity:.68}
.r .l{font-size:14px}
.r .l b{font-size:15px}
.r .l span{font-size:12px;color:var(--sub);margin-left:6px}
/* 出走表へのリンク。押せることが分かるよう下線を残す */
.r .l a.cardlink{font-size:15px;font-weight:700;color:var(--ink);text-decoration:underline;
text-decoration-color:var(--line);text-underline-offset:3px}
.r .v{font-size:12.5px;color:var(--sub);font-variant-numeric:tabular-nums;text-align:right;flex:0 0 auto}
.r .v b.g{color:var(--hit);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:7px 5px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}
th{font-size:11.5px;color:var(--sub);font-weight:600}
.wrap{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 12px 8px;margin-bottom:12px;overflow-x:auto}
.wrap h2{font-size:13px;margin:10px 0 4px}
.g{color:var(--hit);font-weight:700}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);
border-radius:8px;padding:11px 13px;font-size:13px;margin-bottom:12px}
.note2{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sub);
border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--sub);margin-bottom:12px}
</style>`
  const tabs = `<div class="tabs"><a href="/haishin?date=${date}">3連複・3連単</a><a href="/seiseki">配信の実績</a><a href="/spot?date=${date}">企画枠</a><a href="/">当日の判定</a></div>`
  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0.0')
  const warn = `<div class="note"><b>買い続ければ減ります。</b>
これは「よく当たる」予想であって「増える」予想ではありません。<br>
当たったときの払戻は平均120円ほど＝100円が120円になるだけです。</div>`
  const head2 = head + `<h1>無料予想　単勝1点</h1>
<div class="sub">${date}　1着になる確率が80%以上と出たレースだけ、その1艇。オッズは使っていません。</div>` + tabs
  const sum = tot && tot.done
    ? `<div class="big"><h2>この画面で出した予想の記録（${days.filter((d) => d.done).length}日ぶん）</h2><div class="n">
<div><b class="g">${pct(tot.hits, tot.done)}%</b><span>的中率<br>${tot.hits}/${tot.done}本</span></div>
<div><b>${pct(tot.ret, tot.done * 100)}%</b><span>回収率<br>100%を下回れば減ります</span></div>
<div><b>${(tot.ret - tot.done * 100).toLocaleString()}円</b><span>1点100円で買った場合<br>の合計収支</span></div>
</div></div>` : ''
  if (!rows.length)
    return head2 + sum + warn + `<div class="note2">${date} の予想はまだありません。<br>
作るには <code>node scripts/tansho.mjs --date ${date}</code></div>`
  const list = rows.map((r) => {
    const isOff = off.has(r.race_id)
    const cls = isOff ? ' lost' : r.hit == null ? '' : (r.hit ? ' won' : ' lost')
    const res = isOff ? '<b>中止・順延</b>'
      : r.hit == null ? `<span>締切 ${esc(r.deadline ?? '-')}</span>`
      : (r.hit ? `<b class="g">的中 ${(r.payout ?? 0).toLocaleString()}円</b>` : '外れ')
    return `<div class="r${cls}"><div class="l"><a class="cardlink" href="/card?race=${esc(r.race_id)}">${esc(r.venue ?? '')}${r.race_no}R</a>
<span>単勝</span><b>${r.lane}号艇</b><span>${esc(r.racer ?? '')}</span></div>
<div class="v">${res}</div></div>`
  }).join('')
  const done = rows.filter((r) => r.hit != null)
  const dh = done.filter((r) => r.hit === 1)
  const dret = dh.reduce((a, r) => a + (r.payout ?? 0), 0)
  const todaySum = done.length
    ? `<div class="note2">きょうの結果：${done.length}本中 ${dh.length}本的中（${pct(dh.length, done.length)}%）。
1点100円なら 投資 ${(done.length * 100).toLocaleString()}円 → 払戻 ${dret.toLocaleString()}円
（${dret - done.length * 100 >= 0 ? '+' : ''}${(dret - done.length * 100).toLocaleString()}円）</div>` : ''
  return head2 + sum + warn + todaySum + list +
`<div class="wrap"><h2>日ごと（外した日も消していません）</h2><table>
<tr><th>日付</th><th>本数</th><th>的中</th><th>回収率</th><th>収支</th></tr>
${days.filter((d) => d.done).map((d) => `<tr><td>${d.date.slice(5)}</td>
<td>${d.done}${d.done < d.bets ? ` <span style="color:var(--sub)">/${d.bets}</span>` : ''}</td>
<td>${d.hits}<span style="color:var(--sub)">（${pct(d.hits, d.done)}%）</span></td>
<td>${pct(d.ret ?? 0, d.done * 100)}%</td>
<td>${((d.ret ?? 0) - d.done * 100 >= 0 ? '+' : '')}${(((d.ret ?? 0) - d.done * 100)).toLocaleString()}円</td></tr>`).join('')}
</table></div>
<div class="note2">1レース1点・100円で数えています。<br>
選ばれる艇のほとんどは1号艇です。1号艇を機械的に買うだけでも近い成績になります。<br>
外した日も同じ表に並べています。都合の良い日だけ見せないためです。</div>`
}
createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  // ★データAPI（サイト・アプリ・GPT用）。中身は api.mjs、仕様は「API仕様.md」
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) return apiRoute(u, res)
  const date = u.searchParams.get('date') || today()
  if (req.method === 'POST' && u.pathname === '/act') {
    // 買った／見送った を記録して元の画面に戻す
    recordAction(u.searchParams.get('r'), u.searchParams.get('l'),
      u.searchParams.get('t'), u.searchParams.get('a') === 'bought' ? 'bought' : 'passed')
    res.writeHead(303, { Location: u.searchParams.get('demo') === '1' ? '/?demo=1' : '/' }); return res.end()
  }
  if (req.method === 'POST' && u.pathname === '/predict') {
    runPredict()
    res.writeHead(303, { Location: '/' }); return res.end()
  }
  if (u.pathname === '/card') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(cardPage(join(ROOT, 'data', 'boatrace.db'), u.searchParams.get('race')))
  }
  if (u.pathname === '/tansho') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(tanshoPage(date))
  }
  if (u.pathname === '/spot') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(spotPage(date))
  }
  if (u.pathname === '/seiseki') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(seisekiPage(Math.min(4, Math.max(1, Number(u.searchParams.get('n') || 4)))))
  }
  if (u.pathname === '/haishin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(haishinPage(date))
  }
  // ★記事の自動生成（GPT）が読むためのJSON（2026-09-21）。
  //   HTMLを読ませると、予想が空の日（バッチが止まった日）でも「それらしい記事」を作りかねない。
  //   status が "ok" 以外なら記事を作らない、と判断できる形で渡す。
  //   /plan2.json?date=YYYY-MM-DD&n=2   n=4 なら3連単4点も付ける
  if (u.pathname === '/plan2.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(JSON.stringify(planJson(date, Math.min(4, Math.max(1, Number(u.searchParams.get('n') || 2)))), null, 1))
  }
  // ★3連複2点プラン（2026-09-19）。/plan2?n=3 で3点にもできる。
  if (u.pathname === '/plan2') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(haishinPage(date, Math.min(4, Math.max(1, Number(u.searchParams.get('n') || 2)))))
  }
  if (u.pathname === '/asa') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(asaPage(date, Number(u.searchParams.get('m') || 1.3)))
  }
  if (u.pathname === '/json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' })
    return res.end(JSON.stringify({ ...data(date), job }))
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // ★スマホのブラウザが古い内容を出すのを防ぐ。
    //   これが無いと「更新を押しても変わらない」が起きる。
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache', 'Expires': '0',
  })
  res.end(page(date, u.searchParams.get('demo') === '1'))
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
  console.log(`PC   : http://localhost:${PORT}`)
  for (const ip of ips) console.log(`スマホ: http://${ip}:${PORT}　（同じWi-Fiに繋いで開く）`)
  console.log('\n※ 認証はありません。LAN内で使ってください。')
})
