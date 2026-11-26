// 直す係の「判断」を機械で確かめる。
//
//   node scripts/test-ensure-plan.mjs
//
// ★ここにある試験は、2026-10-22に本番で起きた事故から作った。
//   その日は夜間バッチが全部死に、直す係が10:00と11:30に動いたが、
//   どちらも60分かけて失敗し「成功」と記録して、その日の予想が丸ごと出なかった。
//   原因は4つとも「どんな指示を出すか」の間違いで、目視(--dry)では見つけられなかった。
import { decideProgram, decideHeavy, decideLight, decideContent, decideResults, sinceDate, localDate, isRequired, heavyWaitMin }
  from './ensure-plan.mjs'

let ok = 0, ng = 0
const t = (name, cond, extra = '') => {
  if (cond) { ok++ } else { ng++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}
const has = (argv, flag) => argv.some((a) => a.includes(flag))
const find = (argv, script) => argv.find((a) => a[0].includes(script))

console.log('=== 直す係の判断 ===')

// ---------- 事故①：build を範囲指定せずに呼んでいた ----------
{
  const d = decideProgram({ programs: 0, tries: 0, date: '2026-10-22', since: '2026-10-08' })
  t('番組表が0件なら作りに行く', d.run === true)
  const build = find(d.argv, 'build.mjs')
  t('組み立てを呼ぶ', !!build)
  // ★これが事故①。--since が無いと4年ぶんを作り直して60分の制限に当たる。
  t('組み立てには必ず --since を付ける', build && build.includes('--since'), JSON.stringify(build))
  t('--since の値が渡っている', build && build[build.indexOf('--since') + 1] === '2026-10-08')
  t('ANALYZE は飛ばす', build && build.includes('--no-analyze'))
  t('download は当日だけ', find(d.argv, 'download.mjs')?.slice(1).join(',') === '2026-10-22,2026-10-22')
  t('順番は download→extract→build', d.argv.map((a) => a[0]).join('|')
    === 'scripts/download.mjs|scripts/extract.mjs|scripts/build.mjs')
}

// ---------- 事故②：止まる設計をやめた（番組表は何度でも試す） ----------
{
  // ★「何回かで打ち切る」は、失敗が続いたらその日の商品を捨てるのと同じだった。
  //   番組表の取り込みは --since を付けてから3秒で終わるので、止める理由が無い。
  //   公式サイトが落ちている日は、復旧するまで30分おきに試し続けるのが正しい。
  for (const i of [0, 1, 3, 10, 99]) {
    const d = decideProgram({ programs: 0, tries: i, date: '2026-10-22', since: '2026-10-08' })
    t(`番組表は${i}回失敗しても試し続ける`, d.run === true)
    t(`${i}回目も --since を付ける`, d.argv.some((a) => a.includes('--since')))
  }
}
{
  const okp = decideProgram({ programs: 1008, tries: 0, date: '2026-10-22', since: '2026-10-08' })
  t('番組表があれば何もしない', okp.run === false && okp.argv.length === 0)
  const unknown = decideProgram({ programs: null, tries: 0, date: '2026-10-22', since: '2026-10-08' })
  t('DBが読めないときは走らない（0件と混ぜない）', unknown.run === false && !unknown.cap)
}

// ---------- 重い処理 ----------
{
  const no = decideHeavy({ hasProgram: false, hasPredict: false, heavyRunning: false, tries: 0, date: '2026-10-22' })
  t('番組表が無ければ重い処理へ進まない', no.run === false)

  const busy = decideHeavy({ hasProgram: true, hasPredict: false, heavyRunning: true, tries: 0, date: '2026-10-22' })
  t('重い処理が走っていたら見送る', busy.run === false && !busy.cap)

  const go = decideHeavy({ hasProgram: true, hasPredict: false, heavyRunning: false, tries: 0, date: '2026-10-22' })
  t('条件が揃えば走る', go.run === true)
  const names = go.argv.map((a) => a[0])
  t('グレード判定が特徴量より先', names.indexOf('scripts/grade.mjs') < names.indexOf('scripts/derive.mjs'))
  t('特徴量→直前情報→予想の順', names.join('|')
    === 'scripts/grade.mjs|scripts/derive.mjs|scripts/addbefore.mjs|scripts/predict.mjs')
  const pr = find(go.argv, 'predict.mjs')
  t('予想は当日を指定', pr.includes('2026-10-22'))
  t('予想の出力先が当日のファイル', pr.includes('data/predict-2026-10-22.json'))

  const done = decideHeavy({ hasProgram: true, hasPredict: true, heavyRunning: false, tries: 0, date: '2026-10-22' })
  t('予想があれば走らない', done.run === false)
}

// ---------- 止まらないが焼かない：間隔をあけて試し続ける ----------
{
  const NOW = Date.UTC(2026, 9, 22, 5, 0, 0)
  const mk = (tries, minsAgo) => decideHeavy({
    hasProgram: true, hasPredict: false, heavyRunning: false,
    tries, lastAt: NOW - minsAgo * 60000, now: NOW, date: '2026-10-22',
  })
  t('1回失敗・10分後はまだ待つ', mk(1, 10).run === false && mk(1, 10).wait === true, mk(1, 10).reason)
  t('1回失敗・30分後は試す', mk(1, 30).run === true)
  t('2回失敗・40分後はまだ待つ', mk(2, 40).run === false)
  t('2回失敗・60分後は試す', mk(2, 60).run === true)
  t('3回失敗・2時間後は試す', mk(3, 120).run === true)
  // ★何回失敗しても「もうやらない」にはならない。間隔が広がるだけ。
  t('10回失敗でも4時間あけば試す', mk(10, 240).run === true)
  t('100回失敗でも諦めない', mk(100, 600).run === true)
  t('待ち時間は30→60→120→240分', [0, 1, 2, 3, 9].map(heavyWaitMin).join(',') === '30,60,120,240,240')
  // 初回（まだ一度も試していない）は待たない
  t('初回は即試す', decideHeavy({ hasProgram: true, hasPredict: false, heavyRunning: false,
    tries: 0, lastAt: null, now: NOW, date: '2026-10-22' }).run === true)
}

// ---------- 配信・無料枠・B2・企画枠 ----------
{
  const base = { hasPredict: true, gradeDay: false, done: [], date: '2026-10-22' }
  const all0 = decideLight({ ...base, counts: { 配信: 0, 無料枠: 0, B2判定: 0, 企画枠: 0 } })
  const run = all0.filter((x) => x.run).map((x) => x.name)
  t('0件の配信・無料枠・B2は作りに行く', run.join(',') === '配信,無料枠,B2判定', run.join(','))
  t('格上が無い日は企画枠を作らない', all0.find((x) => x.name === '企画枠').run === false)

  const g = decideLight({ ...base, gradeDay: true, counts: { 配信: 1, 無料枠: 1, B2判定: 1, 企画枠: 0 } })
  t('格上の日に企画枠が0なら作る', g.find((x) => x.name === '企画枠').run === true)

  // ★0件が正解の日がある（B2は1日平均0.85本）。鳴り続けないこと。
  const again = decideLight({ ...base, done: ['B2判定'], counts: { 配信: 1, 無料枠: 1, B2判定: 0, 企画枠: 0 } })
  t('一度流したB2は繰り返さない', again.find((x) => x.name === 'B2判定').run === false)

  const unknown = decideLight({ ...base, counts: { 配信: null, 無料枠: 1, B2判定: 1, 企画枠: 1 } })
  t('読めない項目は走らない（0件と混ぜない）', unknown.find((x) => x.name === '配信').run === false)

  const noPred = decideLight({ ...base, hasPredict: false, counts: { 配信: 0, 無料枠: 0, B2判定: 0, 企画枠: 0 } })
  t('予想が無ければ軽い処理も走らない', noPred.length === 0)

  const allOk = decideLight({ ...base, counts: { 配信: 17, 無料枠: 23, B2判定: 2, 企画枠: 12 } })
  t('全部あれば何も走らない', allOk.every((x) => !x.run))
}

// ---------- 事故⑤：任意の工程の失敗で商品ごと止まっていた ----------
{
  // ★2026-10-22：addbefore がメモリ不足で落ちただけで、予想・配信・無料枠・B2・企画枠が
  //   全部道連れになり、その日の商品が丸ごと出なかった。
  //   予想は --nobefore で呼ぶので直前情報は使っていない＝止める理由が無かった。
  t('直前情報は任意（落ちても止めない）', isRequired('scripts/addbefore.mjs') === false)
  t('グレード判定は任意（落ちても予想は出せる）', isRequired('scripts/grade.mjs') === false)
  t('特徴量は必須', isRequired('scripts/derive.mjs') === true)
  t('予想は必須', isRequired('scripts/predict.mjs') === true)
  t('組み立ては必須', isRequired('scripts/build.mjs') === true)
  t('配信は必須', isRequired('scripts/haishin.mjs') === true)
  // 商品に直結するものを「任意」に落とさないこと
  for (const s of ['scripts/derive.mjs', 'scripts/predict.mjs', 'scripts/build.mjs',
    'scripts/download.mjs', 'scripts/tansho.mjs']) {
    t(`${s} を任意にしない`, isRequired(s) === true)
  }
}

// ---------- 昨日の結果と採点（2026-10-30） ----------
{
  const Y = '2026-10-29'
  const ok1 = decideResults({ racesLatest: '2026-10-29', yesterday: Y, done: [] })
  t('昨日ぶんが入っていれば何もしない', ok1.run === false)
  const ok2 = decideResults({ racesLatest: '2026-10-30', yesterday: Y, done: [] })
  t('今日ぶんまで入っていても何もしない', ok2.run === false)
  const ng = decideResults({ racesLatest: '2026-10-28', yesterday: Y, done: [] })
  t('昨日ぶんが無ければ取り込む', ng.run === true)
  const names = ng.argv.map((a) => a[0])
  t('取り込みが採点より先', names.indexOf('scripts/daily.mjs') === 0, names.join('|'))
  t('グレード判定が採点より先', names.indexOf('scripts/grade.mjs') < names.indexOf('scripts/haishin.mjs'))
  t('配信・無料枠・B2の3つを採点する',
    ['haishin', 'tansho', 'b2'].every((k) => names.some((n) => n.includes(k))), names.join('|'))
  // ★当日ではなく昨日を対象にすること。結果は翌日に確定する。
  t('採点の対象は昨日', ng.argv.filter((a) => a.includes('--fill')).every((a) => a.includes(Y)))
  t('一度流したら繰り返さない',
    decideResults({ racesLatest: '2026-10-28', yesterday: Y, done: ['昨日の結果'] }).run === false)
  t('結果が1件も無くても取り込む', decideResults({ racesLatest: null, yesterday: Y, done: [] }).run === true)
}

// ---------- 記事と有料の文面（2026-10-29） ----------
{
  const base = { hasPredict: true, newsLatest: '2026-10-30', postBytes: 16000, venueAgeDays: 0, done: [], date: '2026-10-30' }
  t('揃っていれば何も走らない', decideContent(base).every((x) => !x.run))
  t('予想が無ければ記事も作らない', decideContent({ ...base, hasPredict: false }).length === 0)
  const old = decideContent({ ...base, newsLatest: '2026-10-25' })
  t('ニュースが古ければ作る', old.find((x) => x.name === 'ニュース記事').run === true)

  // ★予想が先・記事は後（2026-11-14 本人の指示）
  //   11/14、無料枠とB2がまだ無い12時台に、復旧がニュースも並行して作ろうとしていた。
  //   締切を過ぎたレースは記録を拒むので、配信の取りこぼしは二度と戻らない。記事は明日でも書ける。
  const pend = decideContent({ ...base, newsLatest: '2026-10-25', productsPending: true })
  t('★ 商品が揃っていなければ記事に進まない', pend.every((x) => !x.run))
  t('　 見送った理由を出す', /予想が揃ってから/.test(pend[0]?.reason ?? ''))
  t('　 商品が揃えば記事に進む',
    decideContent({ ...base, newsLatest: '2026-10-25', productsPending: false })
      .find((x) => x.name === 'ニュース記事')?.run === true)

  // ★記事はレース中に作らない（午前か、全レース後の21:30以降）
  const mk = (hm) => decideContent({ ...base, newsLatest: '2026-10-25', hm })
  t('★ 午前（09:00）は作る', mk('09:00').find((x) => x.name === 'ニュース記事')?.run === true)
  t('★ レース中（12:00）は見送る', mk('12:00').every((x) => !x.run))
  t('★ レース中（15:30）は見送る', mk('15:30').every((x) => !x.run))
  t('★ レース中（21:29）は見送る', mk('21:29').every((x) => !x.run))
  t('★ 全レース後（21:30）は作る', mk('21:30').find((x) => x.name === 'ニュース記事')?.run === true)
  t('★ 深夜（02:00）は作る', mk('02:00').find((x) => x.name === 'ニュース記事')?.run === true)
  t('　 見送りの理由に時刻を出す', /レース中/.test(mk('15:30')[0]?.reason ?? ''))
  t('　 揃っていれば時間帯に関係なく何も走らない',
    decideContent({ ...base, hm: '15:30' }).every((x) => !x.run))
  // ★0バイトのファイルが置かれていても「ある」ことにしない（10/27は0KBだった）
  const empty = decideContent({ ...base, postBytes: 0 })
  t('朝の配信文が0バイトなら作り直す', empty.find((x) => x.name === '朝の配信文').run === true)
  t('朝の配信文が500バイト未満も作り直す',
    decideContent({ ...base, postBytes: 400 }).find((x) => x.name === '朝の配信文').run === true)
  t('場別攻略が2日止まれば動かす',
    decideContent({ ...base, venueAgeDays: 2.5 }).find((x) => x.name === '場別攻略記事').run === true)
  t('場別攻略が1日前なら触らない',
    decideContent({ ...base, venueAgeDays: 1 }).find((x) => x.name === '場別攻略記事').run === false)
}

// ---------- 日付（UTCずれの再発防止） ----------
{
  // ⚠ 素の toISOString().slice(0,10) はUTCの日付なので、JSTの深夜0〜9時に前日になる。
  //   （「UTC+9時間だと15時以降が翌日」は2026-10-20に書いた私の誤り。実測で否定済み）
  const jst15 = new Date(2026, 9, 22, 15, 30, 0)   // 10/22 15:30（地方時）
  t('15:30でも当日のまま', localDate(jst15) === '2026-10-22', localDate(jst15))
  const jst2 = new Date(2026, 9, 22, 2, 10, 0)     // 10/22 02:10
  t('深夜2時でも当日のまま', localDate(jst2) === '2026-10-22', localDate(jst2))
  t('14日前を正しく出す', sinceDate(new Date(2026, 9, 22, 12, 0, 0)) === '2026-10-08',
    sinceDate(new Date(2026, 9, 22, 12, 0, 0)))
  t('月をまたいでも正しい', sinceDate(new Date(2026, 10, 5, 12, 0, 0)) === '2026-10-22',
    sinceDate(new Date(2026, 10, 5, 12, 0, 0)))
  t('年をまたいでも正しい', sinceDate(new Date(2027, 0, 5, 12, 0, 0)) === '2026-12-22',
    sinceDate(new Date(2027, 0, 5, 12, 0, 0)))
}

console.log(`\n通過 ${ok} / 失敗 ${ng}`)
process.exit(ng ? 1 : 0)
