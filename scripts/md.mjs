// 記事（Markdown）を読み込んで、画面に出せる形（HTML）にする小さな変換。外部の部品は使わない。
//
// 記事の置き場所：競艇予想/content/
//   news/*.md       ニュース（自動生成は scripts/news.mjs が auto- で始まる名前で書く。人やGPTが書いたものもここへ）
//   venues/NN.md    場の攻略記事の「人が書く部分」（NN＝場コード2けた。例 05.md＝多摩川）
//
// ファイルの頭に次の形で情報を書く（無くてもよい）：
//   ---
//   title: 記事の題名
//   date: 2026-09-23
//   tags: 優勝戦, SG
//   venue: 5
//   ---
// 本文で使える書き方：# 見出し（##・###）／段落／- 箇条書き／1. 番号付き／**太字**／[文字](URL)／| 表 |／> 引用／---（区切り線）
// ⚠ HTML をそのまま書いても表示しない（安全のため文字として出す）。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function inline(s) {
  let t = esc(s)
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  // リンクは http(s) と サイト内だけ許す。
  // ★サイト内は「/about」の形。前は「#/」しか通しておらず（URLがハッシュだった頃の名残）、
  //   /about などが変換されず [お問い合わせ](/about) と生のまま画面に出ていた（2026-09-26に発見）。
  //   「//」で始まるものは外部サイトなので通さない。
  t = t.replace(/\[([^\]]+)\]\(((?:https?:\/\/|#\/|\/(?!\/))[^)\s]+)\)/g, (m, a, u) =>
    `<a href="${u}"${u.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${a}</a>`)
  return t
}
export function mdToHtml(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) { i++; continue }
    const h = l.match(/^(#{1,3})\s+(.*)$/)
    // ページの題が h1 なので、本文の見出しは h2 から始める。
    // # も ## も h2、### が h3。h1 のつぎが h3 だと段が飛んで、読み上げにも検索にも良くない。
    if (h) { const n = Math.min(4, Math.max(2, h[1].length)); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); continue
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''))
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`); continue
    }
    if (/^\s*>/.test(l)) {
      const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue
    }
    if (/^\s*\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++])
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
      const [head, ...rest] = body
      out.push(`<div class="scroll"><table><thead><tr>${cells(head).map((c) => `<th class="l">${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rest.map((r) => `<tr>${cells(r).map((c) => `<td class="l">${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|\s*>|\s*\||---+\s*$)/.test(lines[i])) p.push(lines[i++])
    out.push(`<p>${p.map(inline).join('<br>')}</p>`)
  }
  return out.join('\n')
}
export function parseDoc(text) {
  const m = String(text).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const meta = {}
  if (m) for (const line of m[1].split('\n')) { const k = line.match(/^(\w+):\s*(.*)$/); if (k) meta[k[1]] = k[2].trim() }
  const body = m ? m[2] : String(text)
  const title = meta.title ?? body.match(/^#\s+(.*)$/m)?.[1] ?? '（題名なし）'
  const plain = body.replace(/^#.*$/gm, '').replace(/[*|>#\-\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
  return { meta: { ...meta, title, tags: meta.tags ? meta.tags.split(/[,、]/).map((s) => s.trim()).filter(Boolean) : [],
    venue: meta.venue ? Number(meta.venue) : null }, html: mdToHtml(body), summary: plain.slice(0, 120) }
}
export function loadDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ file: f, slug: f.replace(/\.md$/, ''), ...parseDoc(readFileSync(join(dir, f), 'utf8')) }))
}
