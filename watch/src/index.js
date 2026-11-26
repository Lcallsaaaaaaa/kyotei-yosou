// サイトが止まっていないかを、PCの外から見る。
//
// 見るのは2つだけ。
//   ① データの最終更新（meta.updated_at）が古すぎないか
//   ② 出ている日付の最後が「今日」か（朝のバッチが動いたか）
// どちらも公開データを読むだけなので、鍵も要らないし、何も壊せない。
//
// ★中身は通知に書かない
//   ntfy のトピック名が唯一の合言葉なので、万一もれても困らない文面にする。
//   「止まっている」ことだけ伝えて、詳しくは自分で画面を見る。
//
// ★覚えておく仕組みを持たない
//   KV を使えば「1回だけ知らせる」ができるが、その分だけ権限と部品が増える。
//   止まっているあいだ30分おきに鳴るのは、この用途ではむしろ正しい。
//   うるさければスマホ側でトピックをミュートできる。

const JST = 9 * 3600e3

/** 日本時間のいまを返す */
const jstNow = () => new Date(Date.now() + JST)
const ymd = (d) => d.toISOString().slice(0, 10)

async function check(env) {
  const site = env.SITE
  const staleMin = Number(env.STALE_MIN ?? 45)
  const now = jstNow()
  const hour = now.getUTCHours()          // JSTへずらした上でのUTC時＝日本時間の時
  const today = ymd(now)
  const out = { at: now.toISOString().slice(0, 16).replace('T', ' '), problems: [] }

  let meta = null
  try {
    const res = await fetch(`${site}/data/meta.json`, { cf: { cacheTtl: 0 }, cache: 'no-store' })
    if (!res.ok) { out.problems.push(`サイトのデータが読めません（${res.status}）`); return out }
    meta = await res.json()
  } catch (e) {
    out.problems.push(`サイトにつながりません（${e.name}）`)
    return out
  }

  // ① 最終更新
  const t = meta.updated_at ? Date.parse(meta.updated_at.replace(' ', 'T') + '+09:00') : NaN
  out.updated_at = meta.updated_at ?? null
  if (Number.isNaN(t)) out.problems.push('最終更新の時刻が読めません')
  else {
    const min = Math.round((Date.now() - t) / 60000)
    out.stale_min = min
    if (min > staleMin) out.problems.push(`データの更新が ${min}分 止まっています`)
  }

  // ② 今日のぶんが出ているか（朝のバッチが動いたか）。9時を過ぎてから見る。
  const last = Array.isArray(meta.dates) ? meta.dates[meta.dates.length - 1] : null
  out.last_date = last
  if (hour >= 9 && last && last < today) out.problems.push(`今日（${today}）のデータがまだ出ていません`)

  return out
}

async function push(env, text) {
  if (!env.NTFY_TOPIC) return 'NTFY_TOPIC が未設定'
  const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      // ヘッダは ASCII しか通らないので、日本語の見出しは本文に入れる
      'Title': 'boatrace site is stale',
      'Priority': 'high',
      'Tags': 'warning',
    },
    body: text,
  })
  return res.ok ? '送りました' : `送れません（${res.status}）`
}

export default {
  async scheduled(event, env) {
    const now = jstNow()
    const hour = now.getUTCHours()
    const from = Number(env.FROM_HOUR ?? 8), to = Number(env.TO_HOUR ?? 22)
    if (hour < from || hour >= to) return      // 深夜は黙る
    const r = await check(env)
    if (r.problems.length) {
      await push(env, `ボートレース研究所\n${r.problems.join('\n')}\n（${r.at} 日本時間）`)
    }
  },
  // 手で開いて今の状態を見るため。通知は送らない。
  async fetch(request, env) {
    const r = await check(env)
    return new Response(JSON.stringify(r, null, 1),
      { headers: { 'content-type': 'application/json; charset=utf-8' } })
  },
}
