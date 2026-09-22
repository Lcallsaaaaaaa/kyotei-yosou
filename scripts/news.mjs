// ニュース記事をデータから自動で書く。content/news/ に Markdown で置く（公開は sync-public.mjs）。
//
//   node scripts/news.mjs                 今日のぶん（前日の結果と今日の開催）
//   node scripts/news.mjs --date 2026-09-23
//
// ★決まり（2026-09-23）
//   ・**データにある事実だけで書く。** 選手の調子・コメント・予想の根拠など、データに無いことは書かない。
//     AIに自由に書かせないのは、ありもしない話が混ざるのを防ぐため（数字も名前もDBの値をそのまま使う）。
//   ・同じ記事を二度作らない（ファイル名が同じなら上書き＝同じ内容になるだけ）。
//   ・予想の実績は外れも含めてそのまま書く。有料の買い目（2点プランの組番）は書かない。
//   ・人やGPTが書いた記事も content/news/ に置けば一緒に並ぶ（ファイル名は auto- 以外で）。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { apiRoute } from './api.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'content', 'news')
mkdirSync(OUT, { recursive: true })
const argv = process.argv.slice(2)
const i = argv.indexOf('--date')
const jst = () => new Date(Date.now() + 9 * 3600e3)
const D = i > -1 ? argv[i + 1] : jst().toISOString().slice(0, 10)
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const Y = addDays(D, -1)
const md = (d) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`
const yen = (v) => (v == null ? '―' : Number(v).toLocaleString() + '円')
const pct = (v) => (v == null ? '―' : v.toFixed(1) + '%')
const call = (p) => { let b = null, c = 0; apiRoute(new URL(p, 'http://x'), { writeHead: (x) => { c = x }, end: (x) => { b = x } }); return c === 200 ? JSON.parse(b) : null }
const made = []
function write(slug, meta, body) {
  const head = ['---', `title: ${meta.title}`, `date: ${meta.date}`, meta.tags?.length ? `tags: ${meta.tags.join(', ')}` : null, meta.venue ? `venue: ${meta.venue}` : null, '---', ''].filter((x) => x != null)
  writeFileSync(join(OUT, `${slug}.md`), head.join('\n') + body.trim() + '\n')
  made.push(slug)
}
const raceLink = (r) => `[${r.venue}${r.race_no}R](#/race/${r.race_id})`

// ---------- 1. 前日の優勝戦 ----------
{
  const y = call('/api/v1/analysis?kind=yusho')
  const list = (y?.races ?? []).filter((r) => r.date === Y && r.winner)
  if (list.length) {
    const big = list.filter((r) => ['SG', 'G1', 'G2'].includes(r.grade))
    const lead = big[0] ?? list[0]
    const title = big.length
      ? `【${lead.grade}】${lead.venue}「${lead.series}」は${lead.winner.name}選手が優勝（${md(Y)}の優勝戦まとめ）`
      : `${md(Y)}の優勝戦まとめ（${list.length}場）`
    const rows = list.map((r) => `| ${r.venue} | ${r.grade} | ${r.series ?? ''} | [${r.winner.name}](#/racer/${r.winner.racer_id})（${r.winner.lane}号艇） | ${r.kimarite ?? ''} | ${r.order} | ${yen(r.trifecta_payout)} |`)
    write(`auto-${Y}-yusho`, { title, date: D, tags: ['優勝戦', ...new Set(list.map((r) => r.grade))] },
      `${md(Y)}は${list.length}場で優勝戦が行われました。\n\n| 場 | グレード | 開催 | 優勝 | 決まり手 | 着順 | 3連単 |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n` +
      `逃げで決まったのは${list.filter((r) => r.kimarite === '逃げ').length}場でした。`)
  }
}

// ---------- 2. 前日の高配当 ----------
{
  const j = call(`/api/v1/races?date=${Y}`)
  const done = (j?.races ?? []).filter((r) => r.result?.trifecta_payout)
  if (done.length >= 10) {
    const top = [...done].sort((a, b) => b.result.trifecta_payout - a.result.trifecta_payout).slice(0, 5)
    const man = done.filter((r) => r.result.trifecta_payout >= 10000).length
    const nige = done.filter((r) => r.result.order.startsWith('1-')).length
    write(`auto-${Y}-haito`, { title: `${md(Y)}の高配当ランキング 最高は${top[0].venue}${top[0].race_no}Rの3連単${yen(top[0].result.trifecta_payout)}`, date: D, tags: ['高配当', '万舟'] },
      `${md(Y)}は全国で${done.length}レースが決着し、3連単1万円以上の万舟は${man}本（${pct(man / done.length * 100)}）でした。` +
      `1号艇が1着になったのは${nige}レース（${pct(nige / done.length * 100)}）です。\n\n## 3連単の高配当 上位5レース\n\n| 順位 | レース | 着順 | 決まり手 | 3連単 |\n|---|---|---|---|---|\n` +
      top.map((r, k) => `| ${k + 1} | ${raceLink(r)} | ${r.result.order} | ${r.result.kimarite ?? ''} | ${yen(r.result.trifecta_payout)} |`).join('\n'))
  }
}

// ---------- 3. 今日の開催 ----------
{
  const j = call(`/api/v1/races?date=${D}`)
  if (j?.status === 'ok') {
    const venues = new Map()
    for (const r of j.races) { if (!venues.has(r.jcd)) venues.set(r.jcd, r) }
    const vs = [...venues.values()]
    const graded = vs.filter((r) => r.grade && r.grade !== '一般')
    const first = vs.filter((r) => r.day_no === 1), last = vs.filter((r) => r.series_days && r.day_no === r.series_days)
    const f = call(`/api/v1/features?date=${D}`)
    const g = (f?.gachigachi?.races ?? []).slice(0, 3)
    const a = (f?.ana?.races ?? []).slice(0, 3)
    const body = [
      `${md(D)}は全国${vs.length}場で${j.races.length}レースが行われます。`,
      graded.length ? `\n## グレード開催\n\n${graded.map((r) => `- **${r.venue}**（${r.grade}）${r.series ?? ''}　${r.day_no}日目`).join('\n')}` : '',
      first.length ? `\n## 今日が初日\n\n${first.map((r) => `- ${r.venue}　${r.series ?? ''}`).join('\n')}` : '',
      last.length ? `\n## 今日が最終日（優勝戦）\n\n${last.map((r) => `- ${r.venue}　${r.series ?? ''}`).join('\n')}` : '',
      g.length ? `\n## AIが堅いと見るレース\n\n${g.map((r) => `- ${raceLink(r)}（締切${r.deadline}）　${r.favorite.lane}号艇の1着確率 ${pct(r.favorite.win_probability)}`).join('\n')}` : '',
      a.length ? `\n## AIが荒れそうと見るレース\n\n${a.map((r) => `- ${raceLink(r)}（締切${r.deadline}）　本命でも1着確率 ${pct(r.favorite.win_probability)}`).join('\n')}` : '',
      '\n1着確率は当サイトのAIの予想で、的中を約束するものではありません。',
    ].filter(Boolean).join('\n')
    write(`auto-${D}-today`, { title: `${md(D)}の開催 ${vs.length}場${graded.length ? '・' + graded.map((r) => `${r.venue}${r.grade}`).join('・') : ''}`, date: D, tags: ['本日の開催'] }, body)
  }
}

// ---------- 4. 7日以内に始まるグレード開催の見どころ（開催ごとに1回） ----------
{
  const s = call(`/api/v1/schedule?from=${D}&to=${addDays(D, 7)}`)
  for (const m of (s?.meetings ?? []).filter((x) => ['SG', 'G1', 'G2'].includes(x.grade) && x.start_date > D)) {
    const slug = `auto-preview-${m.jcd}-${m.start_date}`
    const M = call(`/api/v1/meeting?jcd=${m.jcd}&start=${m.start_date}`)?.meeting
    if (!M?.racers?.length) continue
    const top = M.racers.filter((r) => r.win_rate != null).slice(0, 8)
    const a1 = M.racers.filter((r) => r.class === 'A1').length
    const v = call(`/api/v1/venue?jcd=${m.jcd}`)?.venue
    write(slug, { title: `【${m.grade}】${m.venue}「${m.title}」${md(m.start_date)}開幕 出場予定${M.racers.length}人`, date: D, tags: [m.grade, '開催予告', m.venue], venue: m.jcd },
      `${md(m.start_date)}から${md(m.end_date)}まで（${m.days}日間）、${m.venue}で${m.grade}「${m.title}」が行われます。` +
      `出場予定は${M.racers.length}人で、うちA1級は${a1}人です。\n\n## 勝率上位の出場予定選手\n\n| 選手 | 級別 | 支部 | 勝率 |\n|---|---|---|---|\n` +
      top.map((r) => `| [${r.name}](#/racer/${r.racer_id}) | ${r.class ?? ''} | ${r.branch ?? ''} | ${r.win_rate?.toFixed(2) ?? ''} |`).join('\n') +
      (v ? `\n\n## ${m.venue}の傾向（直近1年）\n\n- 1コースの1着率 ${pct(v.by_course[0]?.win_rate)}\n- 3連単の平均配当 ${yen(v.trifecta.avg_payout)}・万舟率 ${pct(v.trifecta.over_10000_rate)}\n\n詳しくは[${m.venue}の攻略ページ](#/venue/${m.jcd})へ。` : '') +
      '\n\n出場予定は公式のあっせん情報によるもので、欠場などで変わることがあります。')
  }
}

// ---------- 5. 前日の予想実績（外れも含めてそのまま） ----------
{
  const r = call('/api/v1/results?days=3')
  const d = (r?.daily ?? []).find((x) => x.date === Y)
  if (d && (d.plan2 || d.free_win)) {
    const line = (k, name) => (d[k] ? `- **${name}**：${d[k].races}レース中 ${d[k].hits}本的中（的中率 ${pct(d[k].hit_rate)}・回収率 ${pct(d[k].return_rate)}）` : null)
    write(`auto-${Y}-jisseki`, { title: `${md(Y)}の予想の結果`, date: D, tags: ['予想実績'] },
      [`${md(Y)}に締切前に出した予想の結果です。外れたものも含めて集計しています。\n`,
        line('free_win', '無料予想（単勝1点）'), line('plan2', '3連複2点プラン'), line('trio4', '3連複4点'),
        `\n回収率は100%を下回ることが多く、買い続けると資金は減ります。これまでの実績は[実績ページ](#/results)にあります。`].filter(Boolean).join('\n'))
  }
}

console.log(`${D}：${made.length}本 → content/news/ ${made.join(' ')}`)
