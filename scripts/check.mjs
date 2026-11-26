// 「直した」と言う前に必ず通す関門。
//
//   node scripts/check.mjs          全部やる
//   node scripts/check.mjs --fast   静的な確認と試験だけ（実行は省く）
//
// ★なぜ要るか（2026-10-24）
//   3日で16件の不備を本番へ出した。内訳は4種類で、どれも機械で止められるものだった。
//     ・コードを実際に動かさずに「直した」と報告  6件
//     ・数字を見直さずに出した                   2件
//     ・診断中に本番を壊した                     4件
//     ・仮説を結論として話した                   2件
//   とくに1つ目が多い。`node --check` は**構文しか見ない**ので、
//   「宣言前参照」のように**構文は通るが実行すると落ちる**ものを素通りさせる。
//   実際に 2026-10-24、WALチェックを did の宣言より前に置いて本番へ出しかけた。
//
// ★ここでやること
//   ① 全 .mjs の構文
//   ② 全 test-*.mjs を走らせる
//   ③ 主要スクリプトを --dry で**実際に起動**する（宣言前参照・import漏れはここで出る）
//   ④ 過去に踏んだ罠の静的検査（下の TRAPS）
//
// ★罠を足すとき
//   本番で何か踏んだら、必ずここに1行足す。同じ失敗を二度通さないため。
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const S = join(ROOT, 'scripts')
const FAST = process.argv.includes('--fast')
let ok = 0, ng = 0
const pass = (m) => { ok++; console.log(`  ✓ ${m}`) }
const fail = (m, d = '') => { ng++; console.log(`  ✗ ${m}${d ? '\n      ' + d : ''}`) }
const read = (f) => { try { return readFileSync(join(S, f), 'utf8') } catch { return '' } }

// ---------- ④ 過去に踏んだ罠 ----------
const TRAPS = [
  {
    name: '.sh が exit 0 で失敗を握りつぶしていないか（2026-10-22）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.sh'))) {
        const t = read(f).trimEnd()
        if (/\nexit 0$/.test(t)) bad.push(f)
      }
      // results.sh は各工程が独立で、1本失敗しても他を流す作り（意図的）
      return bad.filter((f) => f !== 'results.sh')
    },
    why: 'タスクの結果が常に0になり、失敗に気づけない。exit $? にする',
  },
  {
    name: 'build.mjs を範囲指定なしで呼んでいないか（2026-10-22）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => /\.(sh|mjs)$/.test(x))) {
        if (f === 'build.mjs' || f === 'check.mjs' || f.startsWith('test-')) continue
        for (const line of read(f).split('\n')) {
          if (!/scripts.build\.mjs/.test(line)) continue
          if (/^\s*(\/\/|#|rem )/i.test(line)) continue
          if (/--since/.test(line)) continue
          bad.push(`${f}: ${line.trim().slice(0, 70)}`)
        }
      }
      // catchup.sh(15:00)だけが全期間の作り直しを担当する。
      // ★night2.sh は 2026-11-13 に除外をやめた。
      //   「全期間の作り直しが役目」という設計だったが、搭載7.8GBでは終わらず、
      //   11/07 を最後に一度も完走していなかった（ログが step 1/9 で止まる）。
      //   全期間は catchup(15:00) が担うので、night2 は --since で足りる。
      return bad.filter((x) => !/^catchup\.sh/.test(x))
    },
    why: '4年ぶん2,300ファイルを毎回作り直して60分を超える。--since を付ける',
  },
  {
    // ⚠ この罠は 2026-10-24 に**向きを直した**。
    //   当初は「UTC+9時間で作るな」としていたが、それは**私の誤り**だった。
    //   `Date.now()` は機械のタイムゾーンに影響されないので、
    //   `new Date(Date.now()+9*3600e3).toISOString().slice(0,10)` は全時間帯で正しい（実測済み）。
    //   本当に危ないのは **+9時間を足さない素の toISOString** で、
    //   JSTの深夜0〜9時に前日と判定される。
    name: '素の toISOString で「今日」を作っていないか（深夜に前日になる）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.mjs'))) {
        if (f === 'check.mjs') continue
        for (const line of read(f).split('\n')) {
          if (/^\s*(\/\/|\*)/.test(line)) continue
          // ⚠ 厳密に「引数なしの new Date()」だけを見る（2026-10-24に緩くして誤検知を5件出した）。
          //   `jst().toISOString()` は +9時間済み、`d.toISOString()` や
          //   `new Date(x).toISOString()` は渡された日時の整形なので、どれも正しい。
          //   **誤検知が出る関門は読まれなくなる**ので、確実なものだけを拾う。
          if (!/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(line)) continue
          bad.push(`${f}: ${line.trim().slice(0, 70)}`)
        }
      }
      return bad
    },
    why: '素の toISOString はUTCの日付。JSTの深夜0〜9時に前日になる。+9時間してから使う',
  },
  {
    name: '状態ファイルの JSON.parse で BOM を落としているか（2026-10-20）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.mjs'))) {
        const t = read(f)
        if (!/JSON\.parse\(\s*readFileSync\(\s*STATE/.test(t)) continue
        if (!/\\uFEFF|﻿/.test(t)) bad.push(f)
      }
      return bad
    },
    why: 'PowerShell の Out-File -Encoding utf8 はBOM付き。回数の記録が黙って0に戻る',
  },
  {
    // ★2026-10-25：b2.mjs が「database is locked」で即落ちした。
    //   `BEGIN`（遅延）で始めて読み→書きへ昇格すると、SQLiteは安全に再試行できないので
    //   **busy_timeout を無視して即 SQLITE_BUSY を返す**。5分の待ちを設定しても効かない。
    //   `BEGIN IMMEDIATE` なら書き込みロックを最初に取るので、busy_timeout が効く。
    //   常駐5本がDBを読んでいる昼間に書くものは、必ず IMMEDIATE にすること。
    // ★2026-10-31：この罠を「昼間に走る6本」の手書き一覧で見ていたため、
    //   **常駐の odds-live が漏れていた**。実際に 11:37 に遅延BEGINで詰まり、
    //   ROLLBACK せずに catch {} で抜けたので以降の BEGIN が全部失敗し、
    //   2時間ぶんの締切前オッズが丸ごと欠けた（取り返しがつかない）。
    //   一覧方式は「足し忘れ」が必ず起きる。許す側を挙げる形に変えた。
    //   新しく書いたものは、何もしなければここで落ちる。
    name: '昼間に書くものが BEGIN IMMEDIATE になっているか（2026-10-25／10-31改）',
    check() {
      // 夜間・オフラインでしか走らない重い処理だけ、遅延BEGINを許す。
      // ここに足すときは「常駐が読んでいる時間帯には絶対に走らない」ことを確かめること。
      // ⚠ 2026-11-12：この一覧に build.mjs / model5.mjs / retrain-gate.mjs を
      //   入れていたのは**間違い**だった。夜専用ではない。
      //     build.mjs      … ensure-day（06:30〜22:30・30分毎）が毎回呼ぶ
      //     model5/retrain-gate … boatrace-retrain が 09:00 に呼ぶ
      //   11/12 01:36、当日の番組表を作ろうとした build.mjs が
      //   `database is locked` で **0ファイル処理** に終わり、番組表ができなかった。
      //   番組表が無いと予想も配信も作れず、odds-live も10分おきに落ち続ける。
      //   「夜しか走らない」と思い込む前に、呼び出し元を全部たどること。
      const nightOnly = new Set([
        'archive-tables.mjs', 'biyori-flat.mjs', 'biyori.mjs', 'bt-build.mjs',
        'fan.mjs', 'gbdt.mjs', 'gbdt3.mjs', 'model4.mjs', 'model6.mjs',
        'odds-backfill.mjs', 'odds2.mjs', 'patterns.mjs', 'racefeat.mjs', 'record3.mjs',
        'walk-v2.mjs', 'walk.mjs', 'walk2.mjs', 'walkD.mjs',
      ])
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.mjs'))) {
        if (f === 'check.mjs' || nightOnly.has(f)) continue
        if (/exec\('BEGIN'\)/.test(read(f))) bad.push(f)
      }
      return bad
    },
    why: '遅延BEGINは busy_timeout が効かず即 database is locked。BEGIN IMMEDIATE にする',
  },
  {
    // ★2026-10-31：odds-live が `} catch {}` で BEGIN したまま抜け、以降
    //   「transaction within a transaction」で全部失敗し続けた。
    //   鼓動は打ち続けるので、画面は緑のまま2時間記録が止まった。
    name: 'BEGIN する所の catch が ROLLBACK しているか（2026-10-31）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.mjs'))) {
        if (f === 'check.mjs') continue
        const t = read(f)
        if (!/exec\('BEGIN( IMMEDIATE)?'\)/.test(t)) continue
        // ★中身の無い catch を探し、そこから遡って一番近い `try {` までの範囲に
        //   BEGIN が入っていたら咎める。ALTER TABLE の
        //   `try { ... } catch {}` を巻き込まないため、範囲で見る。
        for (const m of t.matchAll(/\}\s*catch\s*(\([^)]*\))?\s*\{\s*\}/g)) {
          const open = t.lastIndexOf('try {', m.index)
          if (open < 0) continue
          const span = t.slice(open, m.index)
          if (/exec\('BEGIN( IMMEDIATE)?'\)/.test(span)) {
            bad.push(`${f}:${t.slice(0, m.index).split('\n').length}行`)
          }
        }
      }
      return bad
    },
    why: 'BEGIN したまま例外で抜けると次の BEGIN が必ず失敗する。catch で ROLLBACK してから続ける',
  },
  {
    // ★2026-10-28：同じ日に2回やった。`node --check` は構文しか見ないので、
    //   「使っているのに import していない」は**実行するまで分からない**。
    //   chokuzen.mjs で statSync、predict.mjs で renameSync/unlinkSync を入れ忘れた。
    //   重い本番スクリプトは起動確認に入れられないので、静的に拾う。
    name: 'node:fs の関数を import し忘れていないか（2026-10-28）',
    check() {
      const FNS = ['readFileSync', 'writeFileSync', 'existsSync', 'renameSync', 'unlinkSync',
        'statSync', 'mkdirSync', 'readdirSync', 'appendFileSync', 'rmSync', 'copyFileSync', 'utimesSync']
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.mjs'))) {
        if (f === 'check.mjs') continue
        const t = read(f)
        const m = /import\s*\{([^}]*)\}\s*from\s*'node:fs'/.exec(t)
        if (!m) continue                       // fs を名前付きで読んでいないものは対象外
        const imported = m[1].split(',').map((s) => s.trim())
        const body = t.slice(m.index + m[0].length)
        for (const fn of FNS) {
          if (imported.includes(fn)) continue
          // `fs.renameSync(` のような名前空間経由は対象外
          if (new RegExp(`(^|[^.\\w])${fn}\\s*\\(`).test(body)) bad.push(`${f}: ${fn}`)
        }
      }
      return bad
    },
    why: 'import し忘れは node --check を通るが実行時に落ちる。import 文に足す',
  },
  {
    name: '重い処理の判定を heavy.mjs に集約しているか（2026-10-20）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.mjs'))) {
        if (f === 'heavy.mjs' || f === 'check.mjs') continue
        const t = read(f)
        if (/Win32_Process[\s\S]{0,200}derive\|addbefore/.test(t)) bad.push(f)
      }
      return bad
    },
    why: '判定を写すと片方だけ直して食い違う。heavyRunning() を使う',
  },
  {
    name: '常駐の鼓動を見張りが見ているか（2026-10-31）',
    check() {
      const bad = []
      const wd = read('watchdog.ps1')
      // 1周ごとに鼓動を打つ常駐と、その鼓動ファイル
      for (const [f, hb] of [
        ['odds-live.mjs', 'hb-odds-live.txt'],
        ['auto-bet.mjs', 'hb-auto-bet.txt'],
        ['before.mjs', 'hb-before.txt'],
      ]) {
        if (!read(f).includes(hb)) bad.push(`${f} が ${hb} を書いていない`)
        else if (!wd.includes(hb)) bad.push(`watchdog.ps1 が ${hb} を見ていない`)
      }
      return bad
    },
    why: '居るのに黙った常駐はプロセスの有無では拾えない。鼓動の古さで落として立て直す',
  },
  {
    name: '.ps1 が BOM付きUTF-8か（2026-08-23）',
    check() {
      const bad = []
      for (const f of readdirSync(S).filter((x) => x.endsWith('.ps1'))) {
        const b = readFileSync(join(S, f))
        if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) bad.push(f)
      }
      return bad
    },
    why: 'PowerShell 5.1 はBOM無しの .ps1 を CP932 で読む。日本語が壊れて解析に失敗し、見張りが黙って止まる',
  },
]

console.log('=== ① 構文 ===')
{
  const files = readdirSync(S).filter((f) => f.endsWith('.mjs'))
  const bad = []
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', join(S, f)], { stdio: 'pipe' }) }
    catch (e) { bad.push(f) }
  }
  bad.length ? fail(`構文エラー ${bad.length}本`, bad.join(', ')) : pass(`${files.length}本すべて構文OK`)
}

console.log('\n=== ② 試験 ===')
if (FAST) console.log('  （--fast なので省略。本番へ出す前は --fast なしで通すこと）')
else {
  for (const f of readdirSync(S).filter((x) => /^test-.*\.mjs$/.test(x))) {
    const t0 = Date.now()
    try {
      const out = execFileSync(process.execPath, [join(S, f)], { encoding: 'utf8', timeout: 600000, cwd: ROOT })
      const last = out.trim().split('\n').filter(Boolean).pop() ?? ''
      // ⚠ 行頭に正規表現リテラルを置かないこと。前行の末尾と繋がって除算に解釈される。
      const good = /失敗 0|すべて|✓/.test(last)
      const sec = Math.round((Date.now() - t0) / 1000)
      if (good) pass(`${f}  ${last.slice(0, 44)}  ${sec}秒`)
      else fail(`${f}  ${last.slice(0, 60)}`)
    } catch (e) {
      // ★時間切れと本当の失敗を混ぜないこと。混ぜると「失敗3件」の中身が読めなくなる。
      const sec = Math.round((Date.now() - t0) / 1000)
      if (e.signal === 'SIGTERM' || /ETIMEDOUT|timed out/i.test(String(e.message))) {
        fail(`${f} が時間切れ（${sec}秒）`, '本当に落ちたのか遅いだけかは単体で確かめる')
      } else {
        fail(f, String(e.stdout ?? e.message).trim().split('\n').slice(-2).join(' / ').slice(0, 140))
      }
    }
  }
}

console.log('\n=== ③ 実際に起動してみる（--dry）===')
if (FAST) console.log('  （--fast なので省略）')
else {
  // ⚠ ここが肝。`node --check` は構文しか見ないので、宣言前参照や import 漏れは
  //   **実際に起動しないと分からない**。2026-10-24 に実際に踏んだ。
  for (const [label, args] of [
    ['直す係', ['scripts/ensure-day.mjs', '--dry']],
    ['再学習の可否', ['scripts/retrain-needed.mjs', '--why']],
    ['重い処理の判定', ['scripts/heavy.mjs']],
    ['WALの番人', ['scripts/wal.mjs', '--check']],
  ]) {
    try {
      execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 120000, cwd: ROOT })
      pass(`${label} が起動した`)
    } catch (e) {
      const s = String(e.stderr ?? '') + String(e.stdout ?? '')
      // 終了コードだけで落ちたもの（判定結果としての1）は失敗ではない
      if (/ReferenceError|TypeError|SyntaxError|Cannot find|is not defined/.test(s)) {
        fail(`${label} が起動時に落ちた`, s.trim().split('\n').find((l) => /Error|not defined/.test(l))?.slice(0, 120) ?? '')
      } else pass(`${label} が起動した（終了コード ${e.status}）`)
    }
  }
}

console.log('\n=== ④ 過去に踏んだ罠 ===')
for (const t of TRAPS) {
  const bad = t.check()
  bad.length ? fail(t.name, bad.slice(0, 4).join('\n      ') + `\n      → ${t.why}`) : pass(t.name)
}

console.log(`\n通過 ${ok} / 失敗 ${ng}`)
if (ng) console.log('★ 失敗がある状態で「直した」と報告しないこと')
process.exit(ng ? 1 : 0)
