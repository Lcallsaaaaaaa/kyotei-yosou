// 試し読み（登録なしで見られる毎日1レース）の決め方と見張りを確かめる。
//
//   node scripts/test-taster.mjs
//
// ★なぜこれが要るか（2026-10-10）
//   ここを間違えると、どちらかの事故になる。
//   ①開き直すたびに別のレースが出る → 未登録の人に**何本も見えてしまう**（「毎日1レース」が崩れる）
//   ②公開側に予想物が漏れる → 月500円の中身や全部の無料枠がタダで見えてしまう
//   どちらも画面を見ただけでは気づけない。数字と条件で押さえる。
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pickTaster, assertTaster, chooseTaster, canPin, tasterDoc, TASTER_FIELDS, TASTER_TARGET } from './taster.mjs'

let ok = 0, ng = 0
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✓ ${name}`) }
  else { ng++; console.log(`  ✗ ${name}${extra ? '　' + extra : ''}`) }
}
const throws = (name, fn, must) => {
  try { fn(); t(name, false, '例外が出ませんでした') }
  catch (e) { t(name, must ? e.message.includes(must) : true, `出た文言: ${e.message}`) }
}
const nothrow = (name, fn) => {
  try { fn(); t(name, true) } catch (e) { t(name, false, e.message) }
}

const DIR = mkdtempSync(join(tmpdir(), 'taster-'))
const F = () => join(DIR, `p-${Math.random().toString(36).slice(2)}.json`)
const pick = (id, deadline, extra = {}) => ({ race_id: id, jcd: 1, venue: '桐生', race_no: 1,
  deadline, closed: false, lane: 1, racer: 'テスト', win_probability: 0.86, hit: null, payout: null, ...extra })

console.log('\n■ 1. 選び方（15:00にいちばん近い締切・毎回同じ答え）')
{
  const xs = [pick('A', '10:30'), pick('B', '14:50'), pick('C', '20:10')]
  t('15:00にいちばん近いものを選ぶ', chooseTaster(xs)?.race_id === 'B')
  t('並び順を変えても同じ答え', chooseTaster(xs.slice().reverse())?.race_id === 'B')
  t('もう一度呼んでも同じ答え', chooseTaster(xs)?.race_id === 'B')
  t('15:00より後でも近ければ選ぶ', chooseTaster([pick('A', '12:00'), pick('B', '15:10')])?.race_id === 'B')
  t('ちょうど15:00があればそれ', chooseTaster([pick('A', '14:59'), pick('B', '15:00')])?.race_id === 'B')
  t('同じ距離なら race_id の小さいほう',
    chooseTaster([pick('Z', '15:10'), pick('A', '14:50')])?.race_id === 'A')
  t('同じ距離・逆順でも同じ答え',
    chooseTaster([pick('A', '14:50'), pick('Z', '15:10')])?.race_id === 'A')
  t('締切が無いものは後回し', chooseTaster([pick('A', null), pick('B', '20:00')])?.race_id === 'B')
  t('締切が壊れていても落ちない', chooseTaster([pick('A', 'あ'), pick('B', '15:00')])?.race_id === 'B')
  t('25:00 のような値は無効として扱う', chooseTaster([pick('A', '25:00'), pick('B', '09:00')])?.race_id === 'B')
  t('1本だけならそれ', chooseTaster([pick('A', '08:00')])?.race_id === 'A')
  t('空なら null', chooseTaster([]) === null)
  t('undefined でも null', chooseTaster(undefined) === null)
  t('TASTER_TARGET は15:00', TASTER_TARGET === 900)
}

console.log('\n■ 2. 固定（いちど決めたら動かさない。ここが「毎日1レース」の要）')
{
  const f = F()
  const day1 = [pick('R1', '10:00'), pick('R2', '15:00'), pick('R3', '19:00')]
  const first = pickTaster(f, '2026-10-10', day1)
  t('1回目は15:00のもの', first?.race_id === 'R2')
  t('印がファイルに残る', JSON.parse(readFileSync(f, 'utf8'))['2026-10-10'] === 'R2')
  // ★本番で起きること：予想ファイルが作り直されて並びも中身も変わる
  const day1b = [pick('R9', '15:01'), pick('R2', '15:00'), pick('R5', '14:59')]
  t('中身が変わっても同じレースを返す', pickTaster(f, '2026-10-10', day1b)?.race_id === 'R2')
  const day1c = [pick('R5', '14:59'), pick('R9', '15:01')]   // R2 が無料枠から外れた
  t('決めたレースが消えたら、その日は出さない（選び直さない）',
    pickTaster(f, '2026-10-10', day1c) === null)
  t('消えても印は残る（復活したら同じものに戻る）',
    JSON.parse(readFileSync(f, 'utf8'))['2026-10-10'] === 'R2')
  t('復活したら同じものを返す', pickTaster(f, '2026-10-10', day1b)?.race_id === 'R2')
  t('別の日は別に決まる', pickTaster(f, '2026-10-11', [pick('X1', '15:00')])?.race_id === 'X1')
  t('前の日の印は残っている', JSON.parse(readFileSync(f, 'utf8'))['2026-10-10'] === 'R2')
  // 10回開き直しても1本のまま
  const seen = new Set()
  for (let i = 0; i < 10; i++) {
    const shuffled = day1b.slice().sort(() => Math.random() - 0.5)
    seen.add(pickTaster(f, '2026-10-10', shuffled)?.race_id)
  }
  t('10回呼んでも出るのは1レースだけ', seen.size === 1 && seen.has('R2'), `出たもの: ${[...seen]}`)
}

console.log('\n■ 3. その日まだ無いとき')
{
  const f = F()
  t('無料枠が空なら null', pickTaster(f, '2026-10-12', []) === null)
  t('空のときは印を書かない（翌朝ちゃんと決められる）', (() => {
    try { return !('2026-10-12' in JSON.parse(readFileSync(f, 'utf8'))) } catch { return true }
  })())
  t('そのあと出てきたら決まる', pickTaster(f, '2026-10-12', [pick('Y1', '15:00')])?.race_id === 'Y1')
}

console.log('\n■ 4. 壊れた印ファイル')
{
  const f1 = F(); writeFileSync(f1, 'これはJSONではない')
  t('JSONでなければ作り直す', pickTaster(f1, '2026-10-10', [pick('A', '15:00')])?.race_id === 'A')
  const f2 = F(); writeFileSync(f2, '[1,2,3]')
  t('配列が入っていても作り直す', pickTaster(f2, '2026-10-10', [pick('A', '15:00')])?.race_id === 'A')
  const f3 = F(); writeFileSync(f3, 'null')
  t('null が入っていても作り直す', pickTaster(f3, '2026-10-10', [pick('A', '15:00')])?.race_id === 'A')
}

console.log('\n■ 5. 書けないときは出さない（固定できないなら見せない）')
{
  const sub = join(DIR, 'nodir')
  t('置き場が無ければ null を返す（落ちない）',
    pickTaster(join(sub, 'deep', 'x.json'), '2026-10-10', [pick('A', '15:00')], { log: () => {} }) === null)
}

console.log('\n■ 6. 古い印の片づけ')
{
  const f = F()
  writeFileSync(f, JSON.stringify({ '2026-01-01': 'OLD', '2026-10-09': 'YDAY' }))
  pickTaster(f, '2026-10-10', [pick('A', '15:00')], { keepDays: 60 })
  const j = JSON.parse(readFileSync(f, 'utf8'))
  t('60日より古い印は消える', !('2026-01-01' in j))
  t('前日の印は残る', j['2026-10-09'] === 'YDAY')
  t('きょうの印が入る', j['2026-10-10'] === 'A')
}

console.log('\n■ 6.5 まだ一部しか出ていないうちに決めない（朝の終わったレースで1日が終わるのを防ぐ）')
{
  const morning = [pick('M1', '08:35')]
  const withPM = [pick('M1', '08:35'), pick('P1', '15:02')]
  t('朝の1本だけ・深夜なら決めない', canPin(morning, 2 * 60) === false)
  t('朝の1本だけ・朝6時でも決めない', canPin(morning, 6 * 60) === false)
  t('午後の枠が入っていれば深夜でも決める', canPin(withPM, 2 * 60) === true)
  t('ちょうど14:00の枠があれば決める', canPin([pick('A', '14:00')], 0) === true)
  t('13:59だけなら午前中は決めない', canPin([pick('A', '13:59')], 9 * 60) === false)
  t('午後の枠が無い日でも、昼を過ぎたら決める', canPin(morning, 12 * 60) === true)
  t('空なら決めない', canPin([], 20 * 60) === false)
  // 実際の流れ：深夜に1本だけ → 朝に全部そろう
  const f = F()
  t('深夜の部分的な一覧では出さない',
    pickTaster(f, '2026-10-13', morning, { nowMin: 2 * 60 }) === null)
  t('そのとき印も書かない', (() => {
    try { return !('2026-10-13' in JSON.parse(readFileSync(f, 'utf8'))) } catch { return true }
  })())
  t('そろってから決まる（朝の08:35ではなく15:02）',
    pickTaster(f, '2026-10-13', withPM, { nowMin: 7 * 60 })?.race_id === 'P1')
}

console.log('\n■ 7. 見張り（公開側に漏らさない）')
{
  const good = tasterDoc('2026-10-10', pick('A', '15:00'), 12)
  nothrow('ふつうの1本は通る', () => assertTaster('taster/2026-10-10', good))
  nothrow('pick が null でも通る（その日まだ無い）', () => assertTaster('taster/x', tasterDoc('2026-10-10', null, 0)))
  throws('pick が無ければ止める', () => assertTaster('taster/x', { date: '2026-10-10' }), 'pick が無い')
  throws('配列（複数本）は止める', () => assertTaster('taster/x', { date: 'd', pick: [pick('A', '15:00')] }), '1本だけ')
  throws('prediction が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: pick('A', '15:00'), prediction: { a: 1 } }), '"prediction":')
  throws('picks が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: pick('A', '15:00'), picks: { plan2: [] } }), '"picks":')
  throws('tenkai が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: pick('A', '15:00'), tenkai: { a: 1 } }), '"tenkai":{')
  throws('3連単の買い目が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: pick('A', '15:00'), trifecta: [1, 2] }), '"trifecta":[')
  throws('3連複の買い目が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: pick('A', '15:00'), trio: [1, 2] }), '"trio":[')
  throws('2連単の買い目が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: pick('A', '15:00'), exacta: [1, 2] }), '"exacta":[')
  throws('honmei が混ざったら止める',
    () => assertTaster('taster/x', { date: 'd', pick: { ...pick('A', '15:00'), honmei: 1 } }), '"honmei"')
  throws('知らない項目が pick にあれば止める',
    () => assertTaster('taster/x', { date: 'd', pick: { ...pick('A', '15:00'), top2_probability: 0.9 } }), 'top2_probability')
  throws('race_id が無ければ止める',
    () => assertTaster('taster/x', { date: 'd', pick: { lane: 1, racer: 'あ' } }), 'race_id')
  throws('pick が数字なら止める', () => assertTaster('taster/x', { date: 'd', pick: 5 }), '壊れている')
  throws('obj が null なら止める', () => assertTaster('taster/x', null))
  t('許す項目は11個', TASTER_FIELDS.size === 11, `いまは${TASTER_FIELDS.size}個`)
  t('win_probability は許す（1本だけ見せるのが目的）', TASTER_FIELDS.has('win_probability'))
  t('top2_probability は許さない', !TASTER_FIELDS.has('top2_probability'))
}

console.log('\n■ 8. 本番の書類の形')
{
  const d = tasterDoc('2026-10-10', pick('A', '15:00'), 12)
  t('date が入る', d.date === '2026-10-10')
  t('total が入る（「きょうは12本」と誘うため）', d.total === 12)
  t('pick は配列ではない', !Array.isArray(d.pick) && typeof d.pick === 'object')
  t('pick が null のとき total は0', tasterDoc('d', null).total === 0)
  const s = JSON.stringify(d)
  t('書類に入っている race_id は1つだけ', (s.match(/"race_id"/g) ?? []).length === 1)
}

rmSync(DIR, { recursive: true, force: true })
console.log(`\n${ng ? '✗' : '✓'} ${ok + ng}件中 ${ok}件が通りました${ng ? `・${ng}件が落ちました` : ''}`)
process.exit(ng ? 1 : 0)
void mkdirSync; void chmodSync
