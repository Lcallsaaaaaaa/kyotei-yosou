// 公式の競走成績(K)・番組表(B) LZHファイルを日付範囲で取得する。
//
//   node scripts/download.mjs                 直近365日ぶん
//   node scripts/download.mjs 2025-08-18 2026-08-17
//   node scripts/download.mjs --kind K        Kのみ（既定は K と B の両方）
//
// 既に落としてあるファイルは飛ばすので、途中で止めても再実行すれば続きから進む。

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data', 'raw')

const BASE = 'http://www1.mbrace.or.jp/od2'
const DELAY_MS = 800 // 公式サーバーへの負荷を抑える。詰めないこと。
const MAX_RETRY = 3

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** kind='K' → .../K/202608/k260816.lzh */
function urlFor(kind, date) {
  const yy = pad(date.getFullYear() % 100)
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const yyyymm = `${date.getFullYear()}${mm}`
  const name = `${kind.toLowerCase()}${yy}${mm}${dd}.lzh`
  return { url: `${BASE}/${kind}/${yyyymm}/${name}`, name }
}

// ★「中身が入っている」かどうかまで見る。
//   その日のうちに取りに行くと、公式は
//     「データは、この場の全レース終了後に登録されます。」
//   とだけ書いた小さなファイルを返す。サイズ>0 では通ってしまい、
//   以後ずっと「既存」と判断されて二度と取り直されない。
//   2026-08-23 に発覚：8/20・8/21 の結果が丸ごとDBから欠けていた
//   （K260820 が 1,332バイト。正常は約170,000バイト）。
//   1レース分でも入っていれば数万バイトになるので、20KBを下限にする。
const MIN_BYTES = 20_000
async function exists(p) {
  try {
    const s = await stat(p)
    return s.size >= MIN_BYTES
  } catch {
    return false
  }
}

async function fetchOne(kind, date) {
  const { url, name } = urlFor(kind, date)
  const dir = join(RAW, kind)
  const dest = join(dir, name)

  if (await exists(dest)) return { name, status: 'skip' }

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      // 開催が無い日はファイル自体が存在しない。404 は異常ではない。
      if (res.status === 404) return { name, status: 'none' }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) return { name, status: 'none' }
      // ★中身が空の「登録されます」ファイルは保存しない。
      //   保存してしまうと以後ずっと既存扱いになり、二度と取り直されない。
      //   圧縮後でも実データがあれば数万バイトになる。
      if (buf.length < 5_000) return { name, status: 'pending', bytes: buf.length }

      await mkdir(dir, { recursive: true })
      await writeFile(dest, buf)
      return { name, status: 'ok', bytes: buf.length }
    } catch (err) {
      if (attempt === MAX_RETRY) return { name, status: 'fail', error: String(err.message ?? err) }
      await sleep(DELAY_MS * attempt * 2)
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((a) => !a.startsWith('--'))
  const kindFlag = argv.indexOf('--kind')
  const kinds = kindFlag > -1 ? [argv[kindFlag + 1].toUpperCase()] : ['K', 'B']

  let to = args[1] ? new Date(args[1]) : new Date()
  let from
  if (args[0]) {
    from = new Date(args[0])
  } else {
    from = new Date(to)
    from.setDate(from.getDate() - 364)
  }
  // 時刻成分を落として日付だけで回す
  from.setHours(0, 0, 0, 0)
  to.setHours(0, 0, 0, 0)
  return { from, to, kinds }
}

async function main() {
  const { from, to, kinds } = parseArgs(process.argv)
  const days = Math.floor((to - from) / 86_400_000) + 1
  if (days <= 0) {
    console.error('日付範囲が不正です（from > to）')
    process.exit(1)
  }

  console.log(`対象: ${ymd(from)} 〜 ${ymd(to)}  (${days}日)  種別: ${kinds.join(', ')}`)
  console.log(`保存先: ${RAW}`)
  console.log(`推定リクエスト数: ${days * kinds.length}  推定所要: 約${Math.ceil((days * kinds.length * DELAY_MS) / 60_000)}分\n`)

  const tally = { ok: 0, skip: 0, none: 0, fail: 0 , pending: 0 }
  const failures = []
  let done = 0
  const total = days * kinds.length

  for (let i = 0; i < days; i++) {
    const date = new Date(from)
    date.setDate(date.getDate() + i)

    for (const kind of kinds) {
      const r = await fetchOne(kind, date)
      tally[r.status]++
      done++
      if (r.status === 'fail') failures.push(`${r.name}: ${r.error}`)

      if (done % 25 === 0 || done === total) {
        const pct = ((done / total) * 100).toFixed(1)
        console.log(
          `[${pct}%] ${done}/${total}  取得${tally.ok} 既存${tally.skip} 開催無${tally.none} 未登録${tally.pending ?? 0} 失敗${tally.fail}  (${ymd(date)})`
        )
      }
      // skip の時は通信していないので待たない
      if (r.status !== 'skip') await sleep(DELAY_MS)
    }
  }

  console.log(`\n完了: 取得${tally.ok} / 既存${tally.skip} / 開催無${tally.none} / 未登録${tally.pending} / 失敗${tally.fail}`)
  if (tally.pending) {
    console.log('※ 未登録＝公式がまだ結果を出していない日。保存していないので、翌日以降に')
    console.log('  もう一度走らせれば取得されます。放置すると監査の「日次カバレッジ」がFAILします。')
  }
  if (failures.length) {
    console.log('\n失敗一覧（再実行すれば続きから取得します）:')
    for (const f of failures.slice(0, 20)) console.log('  ' + f)
    if (failures.length > 20) console.log(`  ...他 ${failures.length - 20} 件`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
