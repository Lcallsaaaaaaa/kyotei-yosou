// 毎日1回これを回す。前日分の取り込みから健全性チェックまで一括。
//
//   node scripts/daily.mjs                前日分を取り込んで監査
//   node scripts/daily.mjs --date 2026-08-18
//   node scripts/daily.mjs --programs-only  当日の番組表だけ（朝の予想用）
//
// 監査でFAILが出たら終了コード1。**その日は予想を出さないこと。**

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const programsOnly = argv.includes('--programs-only')

/**
 * ⚠️ toISOString() はUTCに変換するので使わないこと。
 * 日本時間(UTC+9)の朝9時より前に実行すると日付が1日前にずれる。
 * 朝6時の定期タスクがまさにその時間帯なので、必ずローカル日付で計算する。
 */
const p2 = (n) => String(n).padStart(2, '0')
const ymdLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

const d = new Date()
if (!flag('date')) d.setDate(d.getDate() - (programsOnly ? 0 : 1))
const date = flag('date') ?? ymdLocal(d)

const run = (label, args) => {
  console.log(`\n──── ${label} ────`)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n✗ ${label} が失敗しました (exit ${r.status})`)
    process.exit(r.status ?? 1)
  }
}

console.log(`=== 日次更新  対象日 ${date}${programsOnly ? '（番組表のみ）' : ''} ===`)

const dl = ['scripts/download.mjs', date, date]
if (programsOnly) dl.push('--kind', 'B')
run('1/4 ダウンロード', dl)
run('2/4 展開', ['scripts/extract.mjs'])
run('3/4 DB投入', ['scripts/build.mjs', '--since', date])

// 番組表だけの日は結果が無いので監査は直近の確定分に対して行う
console.log(`\n──── 4/4 データ監査 ────`)
const audit = spawnSync(process.execPath, ['scripts/audit.mjs', '--days', '7'], { cwd: ROOT, stdio: 'inherit' })
if (audit.status !== 0) {
  console.error('\n🔴 監査でFAILが出ました。**この状態で予想を出さないこと。**')
  console.error('   パーサの桁ズレか、ダウンロードの欠損を疑ってください。')
  console.error('   詳細は データ基盤.md の「ハマりどころ」を参照。')
  process.exit(1)
}
console.log('\n✅ 日次更新と監査、すべて正常。')
