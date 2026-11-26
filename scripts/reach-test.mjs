// boatrace.jp が「ここ」から取れるかを確かめるだけの小さな試験。
//
//   node scripts/reach-test.mjs          結果を画面に出す
//   node scripts/reach-test.mjs --serve  HTTPで結果を返す（Renderで動かすとき）
//
// ★なぜ要るか（2026-11-26）
//   予想を作る工場をノートPCから Render へ移す前に、**これだけは先に確かめる**。
//   家庭の回線からは通っているが、データセンターのIPからだと弾かれることがある。
//   別件（navigationarts）で「HTTP 200を返しながら中身はチャレンジHTML」という
//   遮断に当たっている。ここが通らなければ移行そのものが成立しないので、
//   コードを移す前に、ここだけを1本の小さなサービスで試す。
//
// ★「200だから取れている」と判断しないこと
//   このサイトも、存在しないパスに404ではなく200でSPAのHTMLを返す。
//   11/13に /api/paid/check/2026-12 が200を返すのを見て「箱はある」と誤判断しかけた。
//   だから**中身の形**まで見る。番組表なら選手名が6人ぶん、オッズなら数字が12個。
import { createServer } from 'node:http'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const jst = () => new Date(Date.now() + 9 * 3600e3)
const ymd = () => jst().toISOString().slice(0, 10).replace(/-/g, '')

/** 1本取って、中身の形まで見る */
async function probe(label, url, check) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25_000) })
    const body = await r.text()
    const ms = Date.now() - t0
    const v = check(body)
    return {
      label, url, status: r.status, ms, bytes: body.length,
      ok: r.ok && v.ok, detail: v.detail,
      // ★遮断されているときの手がかり。200でも中身が違えばここに出る。
      hint: r.ok && !v.ok
        ? (/cloudflare|challenge|captcha|Just a moment/i.test(body) ? '遮断ページの疑い'
          : body.length < 2000 ? '本文が短すぎる' : '形が違う')
        : null,
    }
  } catch (e) {
    return { label, url, status: 0, ms: Date.now() - t0, bytes: 0, ok: false, detail: e.message.slice(0, 80), hint: '接続できない' }
  }
}

// ★試す場は「今日ほんとうに開催している場」から選ぶ（2026-11-26）。
//   最初 jcd=01（桐生）を決め打ちにしたら、3本とも同じ13,505バイトが返り、
//   「形が違う＝遮断」と判定しかけた。中身は「データがありません」で、
//   **その場が今日やっていないだけ**だった。遮断と無開催を取り違えてはいけない。
//   開催予定は公式のトップから拾う（DBに頼らない。Renderには最初DBが無い）。
async function todayVenues() {
  const d = ymd()
  try {
    const r = await fetch(`https://www.boatrace.jp/owpc/pc/race/index?hd=${d}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25_000) })
    const h = await r.text()
    const jcds = [...new Set([...h.matchAll(/jcd=(\d{2})/g)].map((m) => m[1]))]
    return jcds.filter((j) => j !== '00')
  } catch { return [] }
}

export async function runAll() {
  const d = ymd()
  const venues = await todayVenues()
  // 開催が拾えないときは、無開催なのか遮断なのか切り分けられない。そのまま返す。
  if (!venues.length) {
    return {
      at: jst().toISOString().slice(0, 19).replace('T', ' '), allOk: false,
      results: [{ label: '本日の開催一覧', url: `https://www.boatrace.jp/owpc/pc/race/index?hd=${d}`,
        status: 0, ms: 0, bytes: 0, ok: false,
        detail: '開催場を1つも拾えませんでした', hint: '遮断か、今日は全場休みか' }],
    }
  }
  const jcd = venues[0]
  const tests = [
    // ① 出走表：選手名が6人ぶん並ぶ
    ['番組表（出走表）', `https://www.boatrace.jp/owpc/pc/race/racelist?rno=1&jcd=${jcd}&hd=${d}`,
      (b) => {
        // ★選手の登番（toban）で数える。見た目のクラス名は変わりうるが、
        //   登番へのリンクは出走表に必ず要る。
        //   11/26、is-fs16 で拾おうとして0件になり「遮断」と誤判定しかけた。
        const tobans = new Set([...b.matchAll(/toban=(\d{4})/g)].map((m) => m[1]))
        return { ok: tobans.size >= 6, detail: `選手 ${tobans.size}人ぶん（6以上で正常）` }
      }],
    // ② 単勝・複勝オッズ：oddsPoint が12個
    ['オッズ（単勝・複勝）', `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=1&jcd=${jcd}&hd=${d}`,
      (b) => {
        const n = [...b.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].length
        return { ok: n === 12, detail: `oddsPoint ${n}個（12で正常）` }
      }],
    // ③ 直前情報：展示タイムの表
    ['直前情報', `https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=1&jcd=${jcd}&hd=${d}`,
      (b) => ({ ok: /is-fs11|展示/.test(b) && b.length > 20000, detail: `${b.length}バイト` })],
    // ④ 公式の番組表ファイル（毎日の取り込み元）
    ['番組表ファイル（Bファイル）', `https://www1.mbrace.or.jp/od2/B/${d.slice(0, 6)}/b${d.slice(2)}.lzh`,
      (b) => ({ ok: b.length > 10000, detail: `${b.length}バイト（1万超で正常）` })],
  ]
  const out = []
  for (const [label, url, check] of tests) {
    out.push(await probe(label, url, check))
    await new Promise((s) => setTimeout(s, 600))   // 連打しない
  }
  return { at: jst().toISOString().slice(0, 19).replace('T', ' '), results: out, allOk: out.every((x) => x.ok) }
}

function render(r) {
  const lines = [`=== boatrace.jp への到達性 ${r.at} ===`, '']
  for (const x of r.results) {
    lines.push(`${x.ok ? '✓' : '✗'} ${x.label}`)
    lines.push(`    HTTP ${x.status}　${x.bytes.toLocaleString()}バイト　${x.ms}ms`)
    lines.push(`    ${x.detail}${x.hint ? `　★${x.hint}` : ''}`)
  }
  lines.push('', r.allOk ? '→ すべて取れています。移行して問題ありません。'
    : '→ ★取れないものがあります。この場所からは移行できません。')
  return lines.join('\n')
}

if (process.argv.includes('--serve')) {
  // Render で動かすとき。/ を叩くと結果が返る。
  const port = Number(process.env.PORT ?? 10000)
  createServer(async (req, res) => {
    const r = await runAll()
    const json = req.url?.includes('json')
    res.writeHead(r.allOk ? 200 : 503, { 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8' })
    res.end(json ? JSON.stringify(r, null, 2) : render(r))
  }).listen(port, () => console.log(`到達性の試験を :${port} で待ち受け`))
} else {
  const r = await runAll()
  console.log(render(r))
  process.exit(r.allOk ? 0 : 1)
}
