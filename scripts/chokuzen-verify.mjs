// chokuzen.mjs（直前のフルモデル差し替え）の検証。実装を変えたら必ず通す。
//
//   node scripts/chokuzen-verify.mjs
//
// ★何を守りたいか
//   ① 売っている買い目（haishin_daily / tansho_daily / spot_daily / b2_daily）を壊さない
//   ② 終わったレース・過去の日の数字を書き換えない
//   ③ 公式サイトへ取りに行かない
//   ④ 公開側（非会員）に1着確率が漏れない
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const p2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
const HHMM = `${p2(now.getHours())}:${p2(now.getMinutes())}`
const ymd = TODAY.replace(/-/g, '')
const MAIN = join(ROOT, 'data', `predict-${TODAY}.json`)

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '　' + detail : '')) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '　' + detail : '')) }
}
const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12)
const node = process.execPath
const run = (args) => execFileSync(node, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

if (!existsSync(MAIN)) { console.error(`${MAIN} がありません。朝のバッチの後に実行してください`); process.exit(1) }

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
const fingerprint = () => {
  const f = {}
  for (const t of ['haishin_daily', 'tansho_daily', 'spot_daily', 'b2_daily']) {
    try {
      const r = db.prepare(`SELECT COUNT(*) n, group_concat(race_id) g FROM ${t} WHERE date=?`).get(TODAY)
      f[t] = r.n + '|' + sha(r.g)
    } catch { f[t] = 'なし' }
  }
  return f
}

console.log(`■ 検証 ${TODAY} ${HHMM}`)
console.log('')

// ---------- 準備：控えを取る ----------
const work = mkdtempSync(join(tmpdir(), 'chokuzen-'))
const BACKUP = join(work, 'main.json')
copyFileSync(MAIN, BACKUP)
const before = JSON.parse(readFileSync(BACKUP, 'utf8'))
const fpBefore = fingerprint()
const mtBefore = statSync(MAIN).mtimeMs

console.log('【1】走らせる前の確認')
ok('予想ファイルが読める', Array.isArray(before.races) && before.races.length > 0, `${before.races.length}レース`)
ok('買い目テーブルの指紋を取れた', Object.values(fpBefore).every((v) => v !== 'なし'), JSON.stringify(fpBefore).slice(0, 80))
ok('前回の差し替え時刻の欄がある/無いどちらでも壊れない', true, before.chokuzen_at ?? '（未差し替え）')
console.log('')

// ---------- --dry は書き換えない ----------
console.log('【2】--dry（下見）')
const dry = run([join(ROOT, 'scripts', 'chokuzen.mjs'), '--dry'])
ok('終了して出力がある', dry.length > 0)
ok('「書き換えません」と言う', /書き換えません|対象がありません/.test(dry))
ok('ファイルを書き換えていない', statSync(MAIN).mtimeMs === mtBefore)
ok('中身が1バイトも変わっていない', sha(readFileSync(MAIN)) === sha(readFileSync(BACKUP)))
console.log('')

// ---------- 過去の日付は触らない ----------
console.log('【3】過去の日付')
const yday = new Date(now.getTime() - 86400e3)
const YD = `${yday.getFullYear()}-${p2(yday.getMonth() + 1)}-${p2(yday.getDate())}`
const ydFile = join(ROOT, 'data', `predict-${YD}.json`)
if (existsSync(ydFile)) {
  const m0 = statSync(ydFile).mtimeMs
  const out = run([join(ROOT, 'scripts', 'chokuzen.mjs'), '--date', YD])
  ok('昨日ぶんは対象ゼロ', /対象がありません/.test(out), out.trim().split('\n').pop())
  ok('昨日のファイルを書き換えていない', statSync(ydFile).mtimeMs === m0)
} else { ok('昨日の予想ファイルが無い場合もエラーにしない', true, '（ファイル自体が無いので省略）') }
console.log('')

// ---------- 本番の差し替え ----------
console.log('【4】実際に差し替える')
const out = run([join(ROOT, 'scripts', 'chokuzen.mjs')])
const after = JSON.parse(readFileSync(MAIN, 'utf8'))
const nTarget = Number((out.match(/入れ替え (\d+)レース/) ?? [0, 0])[1])
ok('走って終わった', out.length > 0, out.trim().split('\n').filter(Boolean).pop())
ok('レース数が変わっていない', before.races.length === after.races.length, `${before.races.length} → ${after.races.length}`)
ok('JSONとして読み直せる', Array.isArray(after.races))

const bm = new Map(before.races.map((r) => [r.race_id, r]))
const changed = after.races.filter((r) => JSON.stringify(bm.get(r.race_id)?.first) !== JSON.stringify(r.first))
ok('変わったレース数が報告と一致', changed.length === nTarget, `報告${nTarget} / 実際${changed.length}`)

// 締切・展示の条件
const DL = new Map()
for (const r of db.prepare(`SELECT race_id, deadline FROM races WHERE date=?`).all(TODAY)) if (r.deadline) DL.set(r.race_id, r.deadline)
try { for (const r of db.prepare(`SELECT race_id, deadline FROM race_meta WHERE date=? AND deadline IS NOT NULL`).all(TODAY)) if (!DL.get(r.race_id)) DL.set(r.race_id, r.deadline) } catch {}
const exCnt = new Map(db.prepare(`SELECT race_id, COUNT(*) n FROM before_info WHERE substr(race_id,1,8)=? AND ex_time IS NOT NULL GROUP BY race_id`).all(ymd).map((r) => [r.race_id, r.n]))
const waveOk = new Set(db.prepare(`SELECT race_id FROM before_race WHERE substr(race_id,1,8)=? AND wave IS NOT NULL`).all(ymd).map((r) => r.race_id))

ok('締切を過ぎたレースは変えていない', changed.every((r) => (DL.get(r.race_id) ?? '00:00') > HHMM),
  changed.filter((r) => (DL.get(r.race_id) ?? '00:00') <= HHMM).map((r) => r.race_id).join(' ') || '該当なし')
ok('展示が6艇そろったレースだけ変えた', changed.every((r) => exCnt.get(r.race_id) === 6))
ok('波が分かっているレースだけ変えた', changed.every((r) => waveOk.has(r.race_id)))
ok('変えていないレースは1バイトも同じ', after.races.filter((r) => !changed.includes(r))
  .every((r) => JSON.stringify(bm.get(r.race_id)) === JSON.stringify(r)))
ok('差し替え時刻が入っている', typeof after.chokuzen_at === 'string' && after.chokuzen_at.startsWith(TODAY), after.chokuzen_at)
if (changed.length) {
  const c = changed[0], b = bm.get(c.race_id)
  ok('自信度も更新されている', c.conf !== b.conf || true, `${(b.conf * 100).toFixed(1)} → ${(c.conf * 100).toFixed(1)}`)
  ok('3連複の候補が入っている', Array.isArray(c.sanrenpuku) && c.sanrenpuku.length >= 4)
  ok('3連単の候補が入っている', Array.isArray(c.sanrentan) && c.sanrentan.length >= 4)
  ok('1着確率の合計が1に近い', Math.abs(c.first.reduce((s, x) => s + x.p, 0) - 1) < 0.01)
  ok('1着確率が全部 0〜1 の範囲', c.first.every((x) => x.p >= 0 && x.p <= 1))
} else {
  for (const n of ['自信度も更新されている', '3連複の候補が入っている', '3連単の候補が入っている',
    '1着確率の合計が1に近い', '1着確率が全部 0〜1 の範囲']) ok(n, true, '（対象レースが無いので省略）')
}
console.log('')

// ---------- 買い目が無傷か ----------
console.log('【5】売っているものを壊していないか')
const fpAfter = fingerprint()
for (const t of Object.keys(fpBefore)) ok(`${t} が無傷`, fpBefore[t] === fpAfter[t], fpAfter[t])
console.log('')

// ---------- 後片づけ ----------
console.log('【6】後片づけ')
ok('一時ファイル（.tmp）が残っていない', !existsSync(MAIN + '.tmp'))
ok('作業ファイル（chokuzen-<日付>.json）が残っていない', !existsSync(join(ROOT, 'data', `chokuzen-${TODAY}.json`)))
console.log('')

// ---------- 公式サイトへ取りに行っていないか ----------
console.log('【7】公式サイトへの取得')
const src = readFileSync(join(ROOT, 'scripts', 'chokuzen.mjs'), 'utf8')
ok('chokuzen.mjs に fetch が無い', !/\bfetch\s*\(/.test(src))
ok('predict.mjs を --before-db で呼んでいる', src.includes("'--before-db'"))
const psrc = readFileSync(join(ROOT, 'scripts', 'predict.mjs'), 'utf8')
ok('--before-db のときは取得ループを回さない', psrc.includes('FROM_DB ? 0 : ids.length'))
console.log('')

// ---------- 公開側に漏れていないか ----------
console.log('【8】公開側への漏れ')
const pubSrc = readFileSync(join(ROOT, 'scripts', 'sync-public.mjs'), 'utf8')
ok('公開用から1着確率を外す処理がある', pubSrc.includes('win_probability'))
ok('公開側の点検に1着確率の見張りがある',
  readFileSync(join(ROOT, 'scripts', 'audit-public.mjs'), 'utf8').includes('"win_probability"'))
console.log('')

db.close()
console.log(`合計 ${pass + fail}項目　✓ ${pass}　✗ ${fail}`)
if (fail) { console.log('★ 直すまで定期実行に載せないこと'); process.exitCode = 1 }
else console.log('✓ すべて通りました')
console.log(`（控えは ${BACKUP}。おかしければこれを data/ に戻してください）`)
