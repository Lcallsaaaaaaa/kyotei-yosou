// レースごとの出走表ページ（/card?race=YYYYMMDD-JJ-RR）。
//
// ★どこから来た数字か
//   艇・選手・級別・全国勝率・当地勝率・モーター2連対率 … programs（番組表＝Bファイル）。公式の値そのもの。
//   平均ST・F回数 … **公式の出走表には載っているがこちらのDBに無い**ので、
//                   entries（過去の出走）から自前で計算している。
//   ⚠ 平均STを「公式の出走表と同じ値」として出さないこと。集計期間が違うので一致しない。
//     公式は期別（半年）の集計、こちらは直近60走。画面の下にその旨を書いてある。
//
// ★デザインは本人から支給されたものをそのまま使っている（2026-09-08）。
//   配色・段組み・印刷指定に手を入れないこと。中身の差し込みだけをここで行う。
import { DatabaseSync } from 'node:sqlite'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const VENUE = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国',
  'びわこ', '住之江', '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

const CSS = `
:root {
  --page: #03111e;
  --board-top: #071e31;
  --board-bottom: #082b42;
  --head: #0b2a40;
  --row-a: rgba(7, 31, 49, 0.92);
  --row-b: rgba(14, 45, 66, 0.92);
  --line: #27536b;
  --text: #f5f9fc;
  --muted: #91b5c7;
  --cyan: #32deea;
  --blue: #1a76ff;
}
* { box-sizing: border-box; }
html { min-width: 320px; background: var(--page); }
body {
  margin: 0; min-height: 100vh; color: var(--text);
  background:
    radial-gradient(circle at 14% 0%, rgba(24, 122, 166, 0.18), transparent 34rem),
    radial-gradient(circle at 100% 100%, rgba(18, 102, 145, 0.16), transparent 38rem),
    var(--page);
  font-family: "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif;
  font-feature-settings: "palt" 1;
  -webkit-font-smoothing: antialiased;
}
.page { width: 100%; padding: 24px; }
.board {
  position: relative; isolation: isolate; width: min(100%, 1500px); margin: 0 auto;
  overflow: hidden; padding: clamp(32px, 4vw, 60px);
  border: 1px solid rgba(76, 173, 214, 0.22); border-radius: 26px;
  background: linear-gradient(180deg, var(--board-top), var(--board-bottom));
  box-shadow: 0 35px 95px rgba(0, 5, 13, 0.52);
}
.board::before {
  position: absolute; z-index: -2; top: -245px; right: -155px; width: 510px; height: 510px;
  border: 132px solid rgba(16, 89, 128, 0.2); border-radius: 50%;
  box-shadow: 0 0 0 130px rgba(9, 63, 94, 0.1); content: "";
}
.board::after {
  position: absolute; z-index: -1; right: -220px; bottom: -185px; width: 980px; height: 310px;
  border: 4px solid rgba(32, 157, 196, 0.26); border-radius: 50%; content: ""; transform: rotate(12deg);
}
.board-header {
  position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between;
  gap: 34px; width: 100%; min-height: 154px; margin-bottom: 30px;
}
.brand { display: grid; grid-template-columns: 11px minmax(0, auto); column-gap: 24px; align-items: center; min-width: 0; }
.brand-accent {
  grid-row: 1 / 3; width: 11px; height: 94px; border-radius: 999px;
  background: linear-gradient(180deg, #48e8ef, #1c78ff); box-shadow: 0 0 24px rgba(50, 222, 234, 0.22);
}
h1 {
  margin: 0; color: #ffffff; font-size: clamp(42px, 4.4vw, 68px); font-weight: 900; line-height: 1.1;
  letter-spacing: 0.035em; white-space: nowrap; text-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
}
.subheading {
  display: flex; align-items: center; gap: 12px; margin-top: 13px; color: #70e8ef;
  font-size: 18px; font-weight: 900; line-height: 1.2; letter-spacing: 0.13em;
}
.subheading .jp { color: #dffbff; letter-spacing: 0.08em; }
.header-badge {
  display: flex; flex: 0 1 600px; align-items: center; justify-content: center; min-height: 74px;
  padding: 14px 30px; border: 2px solid var(--cyan); border-radius: 999px; color: #e0f7ff;
  background: rgba(7, 34, 53, 0.78); font-size: clamp(18px, 1.55vw, 23px); font-weight: 900;
  line-height: 1.35; letter-spacing: 0.025em; text-align: center;
  box-shadow: inset 0 0 24px rgba(50, 222, 234, 0.035);
}
.table-scroll {
  position: relative; z-index: 1; width: 100%; overflow-x: auto; overflow-y: hidden;
  border: 1px solid rgba(85, 165, 200, 0.48); border-radius: 20px 20px 5px 5px;
  background: rgba(5, 24, 39, 0.74); box-shadow: 12px 12px 0 rgba(0, 11, 24, 0.32);
  scrollbar-color: #367c98 #071c2c;
}
table { width: 100%; min-width: 1180px; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
col.lane { width: 8%; }
col.player { width: 22%; }
col.grade { width: 9%; }
col.national { width: 16%; }
col.local { width: 16%; }
col.motor { width: 18%; }
col.st { width: 11%; }
th, td { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: center; vertical-align: middle; }
tr > :last-child { border-right: 0; }
tbody tr:last-child > * { border-bottom: 0; }
thead tr { height: 92px; }
th {
  padding: 12px 8px; border-bottom: 3px solid var(--cyan); color: #def0f7;
  background: rgba(10, 40, 61, 0.96); font-size: 21px; font-weight: 900; line-height: 1.15; letter-spacing: 0.035em;
}
th small { display: block; margin-top: 8px; color: #84aabd; font-size: 14px; font-weight: 800; letter-spacing: 0; }
tbody tr { height: 122px; }
tbody tr:nth-child(odd) { background: var(--row-a); }
tbody tr:nth-child(even) { background: var(--row-b); }
td { padding: 13px 10px; color: #f0f8fc; font-size: 26px; font-weight: 850; line-height: 1.25; letter-spacing: 0.012em; }
.player-name {
  color: #ffffff; font-size: 34px; font-weight: 900; letter-spacing: 0.025em; white-space: nowrap;
  text-shadow: 0 2px 16px rgba(0, 0, 0, 0.18);
}
.f1-mark {
  display: inline-flex; align-items: center; justify-content: center; margin-left: 8px; padding: 4px 8px;
  border: 1px solid rgba(255, 137, 149, 0.72); border-radius: 7px; background: rgba(225, 35, 55, 0.22);
  color: #ff8793; font-size: 16px; font-weight: 950; line-height: 1; vertical-align: middle; text-shadow: none;
}
.stat-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.motor-value { display: inline-flex; flex-direction: column; gap: 5px; font-size: 25px; font-variant-numeric: tabular-nums; }
.lane-badge {
  display: inline-flex; align-items: center; justify-content: center; width: 74px; height: 74px;
  border: 2px solid rgba(255, 255, 255, 0.38); border-radius: 50%; font-size: 34px; font-weight: 950;
  line-height: 1; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
}
.lane-1 { color: #07101b; background: #fbfbfc; border-color: #becbd2; }
.lane-2 { color: #ffffff; background: #11151b; border-color: #586572; }
.lane-3 { color: #ffffff; background: #df2236; border-color: #ff6878; }
.lane-4 { color: #ffffff; background: #1760be; border-color: #5ca1ff; }
.lane-5 { color: #0c1420; background: #ffdd33; border-color: #fff084; }
.lane-6 { color: #ffffff; background: #139b65; border-color: #5ce1ae; }
.grade-pill {
  display: inline-flex; align-items: center; justify-content: center; min-width: 60px; min-height: 52px;
  padding: 6px 10px; border-radius: 10px; color: #071725; font-size: 24px; font-weight: 950; letter-spacing: 0;
}
.grade-a1 { background: #f4c438; }
.grade-a2 { background: #5ed0df; }
.grade-b1 { background: #afc3d1; }
.grade-b2 { background: #899fac; }
.board-footer {
  position: relative; z-index: 1; display: flex; align-items: center; gap: 17px; min-height: 68px;
  padding: 24px 5px 0; color: #bad4df; font-size: 17px; font-weight: 800; letter-spacing: 0.02em;
}
.board-footer::before { flex: 0 0 auto; width: 7px; height: 25px; border-radius: 999px; background: var(--cyan); content: ""; }
.nav { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; padding: 18px 5px 0; }
.nav a {
  padding: 8px 15px; border: 1px solid rgba(85, 165, 200, 0.5); border-radius: 999px;
  color: #cfeaf5; background: rgba(7, 34, 53, 0.6); font-size: 14px; font-weight: 800; text-decoration: none;
}
.nav a.on { border-color: var(--cyan); color: #071725; background: var(--cyan); }
.pick { color: #9fe9ef; font-weight: 900; }
@media (max-width: 980px) {
  .page { padding: 12px; }
  .board { padding: 28px 20px 30px; border-radius: 16px; }
  .board-header { flex-direction: column; align-items: stretch; min-height: 0; gap: 22px; margin-bottom: 24px; }
  .brand-accent { height: 76px; }
  h1 { font-size: clamp(38px, 8vw, 54px); white-space: normal; }
  .header-badge { flex-basis: auto; width: 100%; min-height: 62px; font-size: 18px; }
  .table-scroll { border-radius: 14px 14px 4px 4px; }
  .board-footer { font-size: 15px; }
}
@media (max-width: 520px) {
  .page { padding: 0; }
  .board { padding: 24px 12px 26px; border-width: 0; border-radius: 0; }
  .brand { grid-template-columns: 8px minmax(0, auto); column-gap: 16px; }
  .brand-accent { width: 8px; height: 68px; }
  h1 { font-size: 37px; }
  .subheading { gap: 8px; font-size: 14px; }
  .header-badge { padding: 12px 17px; font-size: 16px; }
  .board-footer { align-items: flex-start; line-height: 1.55; }
}
@media print {
  @page { size: A4 landscape; margin: 8mm; }
  html, body { background: #071f31; }
  .page { padding: 0; }
  .board { width: 100%; max-width: none; padding: 24px; border: 0; border-radius: 0; box-shadow: none; }
  .board-header { min-height: 100px; margin-bottom: 18px; }
  h1 { font-size: 42px; }
  .table-scroll { overflow: visible; box-shadow: none; }
  table { min-width: 0; }
  thead tr { height: 60px; }
  tbody tr { height: 73px; }
  th { font-size: 15px; }
  th small { font-size: 10px; }
  td { font-size: 17px; }
  .player-name { font-size: 21px; }
  .f1-mark { margin-left: 4px; padding: 3px 5px; font-size: 12px; }
  .lane-badge { width: 48px; height: 48px; font-size: 23px; }
  .grade-pill { min-width: 42px; min-height: 36px; font-size: 16px; }
  .motor-value { font-size: 16px; }
  .board-footer { min-height: 44px; padding-top: 12px; font-size: 12px; }
  .nav { display: none; }
}
`

/** 出走表ページを組み立てる。race は "YYYYMMDD-JJ-RR"。 */
export function cardPage(dbPath, race) {
  const head = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<style>${CSS}</style></head><body><main class="page">${body}</main></body></html>`

  if (!/^\d{8}-\d{2}-\d{2}$/.test(String(race ?? '')))
    return head('出走表', `<section class="board"><h1>出走表</h1>
<div class="board-footer">レースの指定がありません。例: /card?race=20260908-03-01</div></section>`)

  const ymd = race.slice(0, 8)
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
  const jcd = Number(race.slice(9, 11))
  const rno = Number(race.slice(12, 14))
  const venue = VENUE[jcd] ?? `場${jcd}`

  const db = new DatabaseSync(dbPath)
  let rows = [], meta = null, pick = null, sameDay = []
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    rows = db.prepare(`SELECT lane, racer_id, racer_name, grade, win_rate_nat, win_rate_loc,
      motor_no, motor_top2, boat_no, boat_top2 FROM programs WHERE race_id=? ORDER BY lane`).all(race)
    meta = db.prepare(`SELECT deadline, series, day_no, grade FROM races WHERE race_id=?`).get(race) ?? null
    // 予想（無料枠に選ばれていれば本命を出す）
    try {
      pick = db.prepare(`SELECT lane, p FROM tansho_daily WHERE race_id=?`).get(race) ?? null
    } catch { /* テーブルが無い */ }
    sameDay = db.prepare(`SELECT DISTINCT race_id, CAST(substr(race_id,13,2) AS INTEGER) rno
      FROM programs WHERE substr(race_id,1,11)=? ORDER BY rno`).all(race.slice(0, 11))
  } finally { db.close() }

  if (!rows.length)
    return head(`${venue}${rno}R出走表`, `<section class="board">
<header class="board-header"><div class="brand"><span class="brand-accent"></span>
<h1>凪の予想配信</h1><div class="subheading"><span class="jp">${esc(venue)}${rno}R出走表</span><span>RACE ENTRY DATA</span></div>
</div></header>
<div class="board-footer">${esc(date)} の ${esc(venue)}${rno}R は番組表がありません。</div></section>`)

  // ---- 平均ST と F回数を出走履歴から計算する ----
  // ⚠ 公式出走表の「平均ST」は期別集計。こちらは直近60走なので値は一致しない。
  //   同じ名前で違う中身を出さないよう、画面の下に計算方法を書いている。
  const db2 = new DatabaseSync(dbPath)
  const st = new Map(), fc = new Map(), name = new Map()
  try {
    db2.exec('PRAGMA busy_timeout = 3000')
    // ★選手名は racer_period から引く。
    //   ⚠ programs.racer_name は番組表(Bファイル)の**4文字固定幅**で、長い名前が切れている。
    //     テーブル全体で5文字以上の名前が1件も無いのが証拠。「鈴木結平太」→「鈴木結平」、
    //     「石渡翔一郎」→「石渡翔一」。racer_period には6文字まで入っている（5文字以上が257人）。
    //   レース月より後の期は使わない（改名が未来から漏れないように）。
    const qN = db2.prepare(`SELECT name FROM racer_period WHERE racer_id = ? AND period <= ?
      ORDER BY period DESC LIMIT 1`)
    const qN2 = db2.prepare(`SELECT name FROM racer_period WHERE racer_id = ? ORDER BY period DESC LIMIT 1`)
    for (const r of rows) {
      if (r.racer_id == null) continue
      const a = qN.get(r.racer_id, date.slice(0, 7)) ?? qN2.get(r.racer_id)
      if (a?.name) name.set(r.lane, a.name)
    }
    const qSt = db2.prepare(`SELECT AVG(st) a, COUNT(*) n FROM (
      SELECT e.st FROM entries e JOIN races r ON r.race_id = e.race_id
      WHERE e.racer_id = ? AND e.st IS NOT NULL AND e.st > 0 AND r.date < ?
      ORDER BY r.date DESC LIMIT 60)`)
    const qF = db2.prepare(`SELECT COUNT(*) n FROM entries e JOIN races r ON r.race_id = e.race_id
      WHERE e.racer_id = ? AND e.st_flag = 'F' AND r.date < ? AND r.date >= date(?, '-180 day')`)
    for (const r of rows) {
      if (r.racer_id == null) continue
      const a = qSt.get(r.racer_id, date)
      if (a && a.n >= 5 && a.a != null) st.set(r.lane, a.a)
      const f = qF.get(r.racer_id, date, date)
      if (f && f.n) fc.set(r.lane, f.n)
    }
  } finally { db2.close() }

  const gradeCls = (g) => ({ A1: 'grade-a1', A2: 'grade-a2', B1: 'grade-b1', B2: 'grade-b2' }[g] ?? 'grade-b2')
  const num = (v, d) => (v == null ? '―' : Number(v).toFixed(d))
  const pct = (v) => (v == null ? '―' : Number(v).toFixed(1) + '％')

  const body = rows.map((r) => {
    const f = fc.get(r.lane)
    return `<tr>
<td><span class="lane-badge lane-${r.lane}">${r.lane}</span></td>
<td class="player-name">${esc(name.get(r.lane) ?? r.racer_name)}${f ? `<span class="f1-mark">F${f}</span>` : ''}</td>
<td><span class="grade-pill ${gradeCls(r.grade)}">${esc(r.grade ?? '―')}</span></td>
<td class="stat-value">${num(r.win_rate_nat, 2)}</td>
<td class="stat-value">${num(r.win_rate_loc, 2)}</td>
<td class="stat-value">${pct(r.motor_top2)}</td>
<td class="stat-value">${num(st.get(r.lane), 2)}</td>
</tr>`
  }).join('')

  const badge = pick
    ? `本命 <span class="pick">${pick.lane}号艇</span>　1着確率 <span class="pick">${(pick.p * 100).toFixed(1)}%</span>`
    : '全国勝率・当地勝率・モーター2連対率・平均ST'
  const dl = meta?.deadline ? `　締切 ${esc(meta.deadline)}` : ''
  const series = meta?.series ? `　${esc(meta.series)}${meta.day_no ? `（${meta.day_no}日目）` : ''}` : ''
  const nav = `<div class="nav">${sameDay.map((x) =>
    `<a href="/card?race=${x.race_id}"${x.race_id === race ? ' class="on"' : ''}>${x.rno}R</a>`).join('')}
<a href="/tansho?date=${date}">無料予想へ</a><a href="/haishin?date=${date}">配信へ</a></div>`

  return head(`凪の予想配信｜${venue}${rno}R出走表`, `<section class="board" aria-label="凪の予想配信 ${esc(venue)}${rno}R出走表">
<header class="board-header">
<div class="brand"><span class="brand-accent" aria-hidden="true"></span>
<h1>凪の予想配信</h1>
<div class="subheading"><span class="jp">${esc(venue)}${rno}R出走表</span><span>RACE ENTRY DATA</span></div></div>
<div class="header-badge">${badge}</div>
</header>
<div class="table-scroll" aria-label="出走表。狭い画面では横方向にスクロールできます">
<table>
<colgroup><col class="lane"><col class="player"><col class="grade">
<col class="national"><col class="local"><col class="motor"><col class="st"></colgroup>
<thead><tr>
<th scope="col">艇</th><th scope="col">選手</th><th scope="col">級別</th>
<th scope="col">全国勝率</th><th scope="col">当地勝率</th>
<th scope="col">モーター<small>2連対率</small></th><th scope="col">平均ST</th>
</tr></thead>
<tbody>${body}</tbody>
</table>
</div>
<footer class="board-footer">${esc(date)}${dl}${series}　　モーター：2連対率　　―：データなし
平均ST・Fは公式出走表の値ではなく、直近60走／過去180日の出走から当システムが算出した参考値です。</footer>
${nav}
</section>`)
}
