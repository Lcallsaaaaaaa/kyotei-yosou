// 「いま何をすべきか」を決めるだけ。副作用なし＝機械で確かめられる。
//
// ★なぜ切り出したか（2026-10-22）
//   ensure-day.mjs に**判断と実行を混ぜていた**ので、確かめる手段が `--dry` の目視しか
//   なかった。その結果、4つの不備が本番まで素通りし、10/22はその日の予想が丸ごと出なかった。
//
//     ① `build.mjs` を範囲指定せずに呼び、4年ぶん2,300ファイルを毎回作り直して
//        60分の制限に当たり ETIMEDOUT（`--since` を付ければ3.4秒）
//     ② 番組表の経路に**回数の上限が無く**、30分ごとに60分の無駄骨を永久に繰り返した
//     ③ ensure-day.sh が `exit 0` で失敗を握りつぶし、タスクは毎回「成功」と記録
//     ④ `grade` の数秒間は重い処理が1本も見えず、`derive` が二重に走りうる
//
//   ①②④は「どんな指示を出すか」の問題なので、ここに純粋関数として置けば試験できる。
//   ③は .sh 側（`exit $?`）で直した。
//
// ★使い方
//   import { decideProgram, decideHeavy, decideLight, sinceDate } from './ensure-plan.mjs'
//   試験: node scripts/test-ensure-plan.mjs

/** 組み立ての範囲。これより古いファイルは触らない */
export const SINCE_DAYS = 14

/**
 * 重い処理（特徴量→予想・40分かかる）を次に試すまで、何分あけるか。
 *
 * ★「何回かで打ち切る」をやめた（2026-10-22）。
 *   上限で止める設計は、**失敗が続いたらその日の商品を捨てる**のと同じだった。
 *   かといって30分ごとに40分の処理を投げ続けると機械が焼ける。
 *   そこで「止めない。ただし間隔を広げる」。1日中あきらめずに、しかし薄く試す。
 *     1回目の失敗後 → 30分後に再挑戦
 *     2回目        → 60分後
 *     3回目        → 2時間後
 *     4回目以降    → 4時間後（深夜まで試し続ける）
 */
export function heavyWaitMin(tries) {
  return [30, 60, 120, 240][Math.min(tries, 3)] ?? 240
}

/** 番組表の取り込みは軽い（--since で3秒）ので、毎回でも試してよい。上限は設けない。 */
export function progWaitMin() { return 0 }

const p2 = (n) => String(n).padStart(2, '0')

/** 地方時で N 日前の日付。⚠ toISOString は使わない（この機械はJSTなので9時間ずれる） */
export function sinceDate(now, days = SINCE_DAYS) {
  const d = new Date(now.getTime() - days * 24 * 3600e3)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** 地方時の YYYY-MM-DD */
export function localDate(now) {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
}

/**
 * 番組表をどうするか。
 * @param {{programs:number|null, tries:number, date:string, since:string}} s
 * @returns {{run:boolean, reason:string, argv:string[][], cap?:boolean}}
 */
export function decideProgram(s) {
  if (s.programs == null) return { run: false, reason: 'DBが読めません', argv: [] }
  if (s.programs > 0) return { run: false, reason: '番組表 OK', argv: [] }
  // ★上限は設けない。`--since` を付けてから3秒で終わるので、何度試しても害が無い。
  //   公式サイトが落ちている日は、復旧するまで30分おきに試し続けるのが正しい。
  return {
    run: true,
    reason: `番組表がありません（${(s.tries ?? 0) + 1}回目）`,
    argv: [
      ['scripts/download.mjs', s.date, s.date],
      ['scripts/extract.mjs'],
      // ⚠ --since を必ず付ける。付けないと全期間を作り直して60分を超える。
      ['scripts/build.mjs', '--since', s.since, '--no-analyze'],
    ],
  }
}

/**
 * 特徴量→予想（重い）をどうするか。
 * @param {{hasProgram:boolean, hasPredict:boolean, heavyRunning:boolean, tries:number, date:string}} s
 */
export function decideHeavy(s) {
  if (!s.hasProgram) return { run: false, reason: '番組表が無いと先へ進めません', argv: [] }
  if (s.hasPredict) return { run: false, reason: '予想ファイル OK', argv: [] }
  if (s.heavyRunning) return { run: false, reason: '重い処理が走っています。次の回にまわします', argv: [] }
  // ★止めない。間隔をあけるだけ（上の heavyWaitMin を参照）。
  const tries = s.tries ?? 0
  if (tries > 0 && s.lastAt) {
    const waited = Math.floor((s.now - s.lastAt) / 60000)
    const need = heavyWaitMin(tries - 1)
    if (waited < need) {
      return { run: false, wait: true, argv: [],
        reason: `予想がありません。${tries}回失敗したので、あと${need - waited}分あけてから試します` }
    }
  }
  return {
    run: true,
    reason: `予想がありません（${(s.tries ?? 0) + 1}回目）`,
    argv: [
      // ⚠ グレード判定は無料枠より先。races.grade が空だと高確率帯の較正が壊れる
      //   （2026-08-19〜09-05で前向き実測が96.3%→84.0%に落ちた）。
      ['scripts/grade.mjs', '--apply'],
      ['scripts/derive.mjs'],
      ['scripts/addbefore.mjs'],
      ['scripts/predict.mjs', '--date', s.date, '--trio', '--json', '--nobefore',
        '--out', `data/predict-${s.date}.json`],
    ],
  }
}

/**
 * 記事と有料の文面をどうするか。
 *
 * ★なぜ要るか（2026-10-29）
 *   これらは `morning.sh` の中にあり、morning は**毎朝死んでいる**
 *   （再起動が1日2〜3回・空きRAM 0.2GB）。その結果
 *     ・ニュース記事が 10/23 から5日間止まった
 *     ・有料会員の文面が 10/23 以降ほぼ空（10/27は0KB）
 *   どちらも直す係の対象外で、誰も直していなかった。
 *   10/28に見張りには足したが**復旧を足していなかった**ので、翌朝また止まった。
 *   morning が死ぬ前提で、こちらが作り直す。
 *
 * @param {{hasPredict:boolean, newsLatest:string|null, postBytes:number,
 *          venueAgeDays:number, done:string[], date:string}} s
 */
export function decideContent(s) {
  const out = []
  if (!s.hasPredict) return out          // 予想が無いと記事も文面も作れない

  // ★記事より予想が先（2026-11-14 本人の指示）。
  //   11/14、配信は02:56にできていたのに無料枠とB2がまだ無い12時台に、
  //   復旧がニュース記事も並行して作ろうとしていた。
  //   搭載7.8GBのこの機械では、記事づくりが締切前のオッズ取得と食い合う。
  //   締切を過ぎたレースは haishin/tansho/spot が記録を拒むので、
  //   **配信で取りこぼした1レースは二度と戻らない**。記事は明日でも書ける。
  //   当日の商品（配信・無料枠・B2・企画枠）が揃うまで記事に進まない。
  //   ⚠ 「見送る」と言うのは**実際にやることがあるとき**だけ。
  //     もう揃っているのに毎回「見送ります」と出すと、ログが嘘くさくなる。
  const gate = (reason) => {
    const items = build(s)
    return items.some((x) => x.run) ? [{ name: '記事と文面', run: false, reason, argv: [] }] : items
  }
  if (s.productsPending) return gate('は予想が揃ってからにします（予想が先）')
  // ★記事を作る時間帯を午前中に寄せる（2026-11-14 本人の指示）。
  //   レースは10:15頃から20:45頃まで。その間は常駐（オッズ記録・買い目判定・
  //   直前情報）に機械を使わせる。記事は締切のない仕事なので後ろに回せる。
  //   全レースが終わった夜は、その日の取りこぼしを拾えるように開けておく。
  //   （午前だけに限ると、午前が沈黙した日はその日の記事が永久に欠ける）
  const hm = s.hm ?? '00:00'
  const inMorning = hm < '12:00'
  const afterRaces = hm >= '21:30'
  if (!inMorning && !afterRaces) return gate(`はレース中なので見送ります（${hm}・午前か21:30以降に作ります）`)

  return build(s)
}

/** 記事3本それぞれを作るかどうか。時間帯や優先順位はこの外で見る。 */
function build(s) {
  const out = []
  const done = s.done ?? []

  // ① ニュース記事（当日ぶん）
  if (s.newsLatest === s.date) out.push({ name: 'ニュース記事', run: false, reason: `OK（最新 ${s.newsLatest}）`, argv: [] })
  else if (done.includes('ニュース記事')) out.push({ name: 'ニュース記事', run: false, reason: 'もう流したので繰り返しません', argv: [] })
  else out.push({ name: 'ニュース記事', run: true, reason: `がありません（最新 ${s.newsLatest ?? 'なし'}）`, argv: ['scripts/news.mjs'] })

  // ② 朝の配信文（＝有料会員の展開解説＋X投稿＋有料の買い目）
  //    ⚠ 中身で見ること。0バイトのファイルが置かれていても「ある」ことにしない。
  if (s.postBytes > 500) out.push({ name: '朝の配信文', run: false, reason: `OK（${Math.round(s.postBytes / 1024)}KB）`, argv: [] })
  else if (done.includes('朝の配信文')) out.push({ name: '朝の配信文', run: false, reason: 'もう流したので繰り返しません', argv: [] })
  else out.push({ name: '朝の配信文', run: true, reason: `がありません（${s.postBytes}バイト）`, argv: ['__morning_post__'] })

  // ③ 場別攻略（24場を1日1場ずつ回す。2日以上どれも動いていなければ止まっている）
  if (s.venueAgeDays < 2) out.push({ name: '場別攻略記事', run: false, reason: `OK（${Math.floor(s.venueAgeDays)}日前）`, argv: [] })
  else if (done.includes('場別攻略記事')) out.push({ name: '場別攻略記事', run: false, reason: 'もう流したので繰り返しません', argv: [] })
  else out.push({ name: '場別攻略記事', run: true, reason: `が${Math.floor(s.venueAgeDays)}日止まっています`, argv: ['scripts/venue-article.mjs'] })

  return out
}

/**
 * 昨日の結果の取り込みと採点をどうするか。
 *
 * ★なぜ要るか（2026-10-30）
 *   これは `night.sh`（05:00）だけがやっていた。そして night は毎朝死んでいる
 *   （4日で再起動11回・空きRAM 0.26GB）。実際に10/29の公式結果が入っていなかった。
 *   このサイトは「外れた日も含む実績をそのまま公開」が売りなので、
 *   **採点が止まると商品の根拠が止まる**。morning と同じく、死ぬ前提で拾う。
 *
 * ⚠ 当日ではなく**昨日**を対象にすること。結果は翌日に確定する。
 *
 * @param {{racesLatest:string|null, yesterday:string, done:string[]}} s
 */
export function decideResults(s) {
  if (s.racesLatest && s.racesLatest >= s.yesterday) {
    return { run: false, reason: `OK（結果は ${s.racesLatest} まで）`, argv: [] }
  }
  if ((s.done ?? []).includes('昨日の結果')) {
    return { run: false, reason: 'もう流したので繰り返しません', argv: [] }
  }
  return {
    run: true,
    reason: `がありません（結果は ${s.racesLatest ?? 'なし'} まで。昨日=${s.yesterday}）`,
    argv: [
      ['scripts/daily.mjs', '--date', s.yesterday],       // 取り込み（build は --since 付き）
      ['scripts/grade.mjs', '--apply'],                   // 企画枠と較正に要る
      ['scripts/haishin.mjs', '--fill', '--date', s.yesterday, '--recheck'],
      ['scripts/tansho.mjs', '--fill', '--date', s.yesterday, '--recheck'],
      ['scripts/b2.mjs', '--fill', '--date', s.yesterday],
    ],
  }
}

/**
 * その工程が失敗したとき、後ろを止めてよいか。
 *
 * ★2026-10-22の停止の真因はここ。
 *   復旧の連結を `A && B && C` で書いていたので、**addbefore がメモリ不足で落ちた瞬間に
 *   予想・配信・無料枠・B2・企画枠が全部道連れ**になり、その日の商品が丸ごと出なかった。
 *   ところが予想は `--nobefore` で呼んでいる＝**直前情報を使っていない**。
 *   止める必要が無いもので全部止めていた。
 *
 *   「止まらない仕組み」とは、**商品に要るものだけを必須にして、
 *   飾りの失敗で商品を落とさない**こと。
 *
 *   必須 : build（番組表が無いと何も作れない）／derive（特徴量が無いと予想できない）
 *          predict（これが商品の素）
 *   任意 : grade（無いと企画枠の判別と較正が甘くなるが、予想自体は出せる）
 *          addbefore（`--nobefore` の予想では使わない）
 */
export function isRequired(script) {
  return !/addbefore\.mjs|grade\.mjs/.test(script)
}

/**
 * 配信・無料枠・B2・企画枠をどうするか。
 * @param {{hasPredict:boolean, counts:object, gradeDay:boolean, done:string[], date:string}} s
 * @returns {Array<{name:string, run:boolean, reason:string, argv:string[]}>}
 */
export function decideLight(s) {
  const out = []
  if (!s.hasPredict) return out
  const done = s.done ?? []
  const items = [
    ['配信', ['scripts/haishin.mjs', '--date', s.date]],
    ['無料枠', ['scripts/tansho.mjs', '--date', s.date]],
    ['B2判定', ['scripts/b2.mjs', '--date', s.date]],
  ]
  for (const [name, argv] of items) {
    const n = s.counts?.[name]
    if (n == null) { out.push({ name, run: false, reason: '読めません。この回は見送ります', argv: [] }); continue }
    if (n > 0) { out.push({ name, run: false, reason: `OK（${n}）`, argv: [] }); continue }
    // ★0件が正解の日がある（B2は1日平均0.85本）。一度流したら繰り返さない。
    if (done.includes(name)) { out.push({ name, run: false, reason: '0件（もう流したので繰り返しません）', argv: [] }); continue }
    out.push({ name, run: true, reason: 'ありません', argv })
  }
  const spot = s.counts?.['企画枠']
  if (spot == null) out.push({ name: '企画枠', run: false, reason: '読めません。この回は見送ります', argv: [] })
  else if (spot > 0) out.push({ name: '企画枠', run: false, reason: `OK（${spot}レース）`, argv: [] })
  else if (done.includes('企画枠')) out.push({ name: '企画枠', run: false, reason: '0件（もう流したので繰り返しません）', argv: [] })
  else if (!s.gradeDay) out.push({ name: '企画枠', run: false, reason: 'なし（今日は格上の開催がありません）', argv: [] })
  else out.push({ name: '企画枠', run: true, reason: 'ありません（格上の開催がある日なのに）', argv: ['scripts/spot.mjs', '--date', s.date, '--auto'] })
  return out
}
