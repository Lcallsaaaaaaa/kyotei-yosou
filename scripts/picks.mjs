// 1日の配信内容を作る。無料（3連複）と有料（単勝）。
//
//   node scripts/picks.mjs                今日ぶん（朝に流す。候補一覧を出す）
//   node scripts/picks.mjs --live         今から15分以内に締切のレースだけ、実オッズ付きで判定
//   node scripts/picks.mjs --free         無料ぶんだけ
//   node scripts/picks.mjs --paid         有料ぶんだけ
//
// ═══ 2026-08-21 全面見直し。それまでの数字は誤っていた ═══
//
// ★誤り1：オッズは締切15分前より前は数字として意味が無い
//   単勝オッズの Σ(1/オッズ) を測ると、確定は1.36（控除率25%＝正常）だが
//   締切20〜29分前は2.71、45〜60分前は4.07。**プールが形成されていない。**
//   朝に取ったオッズでレースを選んでも、ノイズを選んでいるだけ。
//   → 朝は候補を出すだけにし、オッズ判定は読者が締切直前に行う。
//
// ★誤り2：「期待値順で選ぶと186%」は実行不可能な数字だった
//   確定オッズで並べ替えていた。確定オッズは買う時点では分からない。
//   締切2分前の実測オッズで並べ替えると **99.1%（負ける確率57.7%）**。
//   締切2分前でも順位相関は0.784、1番人気が確定と一致するのは70%しかない。
//   単勝プールは薄く、締切間際の資金で順位が入れ替わる。
//   → 並べ替えは確率のみで行う。オッズは足切りにだけ使う。
//
// ★誤り3：確率上限を「成績を下げるから外すべき」と判断したのは逆だった
//   確定オッズで測ると上限なしの方が良く見える（163.7% vs 155.7%）。
//   しかし上限が無いと候補が1日75本に膨れ、高オッズ艇の割合が6%まで薄まる。
//   → 上限は必要。最終的に40%とした（誤り4を参照）。
//
// ★疑って測り直したが、問題が無かったもの
//   ・進入コースは使っていない（枠番のみ）。締切後に決まるものは入っていない。
//   ・風速・波高はKファイル（レース時の記録）由来なので漏れを疑ったが、
//     31項目すべて外して学習し直しても回収163.1%（元163.7%）。優位の原因ではない。
//   ・モデルの較正は良好：本命の平均予測57.19%に対し実際57.09%。
//   ・市場側も正常：全艇を買うと回収68.7%（控除率どおり）。
//     1レース1着も35,497/35,521で整合。
//
// ★誤り4：「確率順に候補20本」では高オッズ艇が1本も残らない
//   確率で並べると1〜2倍の本命ばかりが上位に来る。候補母集団の33%が2倍未満で、
//   4倍以上に届くのは13%しかない。実際、候補上位20本のうち4倍以上は231日で57本だけ。
//   さらに変動データ63レースに外れ値（1番人気の比が最大38倍）があり、
//   それを引いた時だけ本命が「6倍に見える」ため回収117.5%という幻の数字が出ていた。
//   → 朝の候補は**確率が高い順ではなく、オッズが高くなりそうな順**で選ぶ。
//     朝に使える指標は「1着確率が低め（30〜40%）」と「全国勝率が低い」。
//     1号艇を外すのは誤り（1号艇の30〜60%×4倍以上は630本・回収166.7%で最大の母集団）。
//
// ★歩進検証（8ヶ月・35,665レース・月ごとに学習し直し）で確定した条件
//   1着確率30〜40% ／ 全国勝率6.05以下 ／ 締切2分前に単勝4倍以上 ／ 1日3本まで
//     候補14.6本/日 → 買2.05本/日（398点・194日）／的中28.6%／**確定オッズ基準 回収156.3%**
//     月別8/8が100%超（115.9〜214.6%）／前半137.0%・後半175.6%
//     上位10本の高配当を除いても130.9%／ブートストラップ90%区間[136.1%, 176.6%]・100%割れ0.00%
//     オッズ閾値は完全に単調（3倍125.7% → 4倍143.4% → 5倍161.7% → 7倍229.3%）
//   実運用の見積り：締切2分前に4倍以上に見えた艇の11%は確定で4倍を割る（実測278本）。
//     その分は3〜4倍帯の成績(111.6%)になるので 0.89×156.3 + 0.11×111.6 ＝ **約151%**
//   ※目減りの根拠は8/20の63レース分のみ。ここが最も弱い。1週間ぶん貯まれば精度が上がる。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
// ★条件は strategy.mjs に一本化してある。ここに数字を書き直さないこと。
//   auto-bet.mjs（自動判定）と同じ条件で動く必要がある。
import { MIN_P, MAX_P, MAX_WR, MARGIN, MAX_BUY, CAND as CAND_N, ODDS_VALID_MINS, freePicks, runPredict, minOddsFor } from './strategy.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const p2 = (n) => String(n).padStart(2, '0')
const DATE = flag('date', (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` })())
const LIVE = argv.includes('--live')
const ONLY = argv.includes('--free') ? 'free' : argv.includes('--paid') ? 'paid' : 'both'

const CAND = Number(flag('cand', CAND_N))

const NOTE_PAID = [
  '★ 買い方（この順番を守ってください）',
  '   1. 下の候補について、締切12分前〜2分前にオッズを確認する',
  `   2. 買い目ごとの必要倍率＝(1÷1着確率)×${MARGIN} 以上なら買う。下回れば買わない`,
  `   3. 1日${MAX_BUY}本買えたら、その日は終わり`,
  '',
  '★ なぜオッズ確認が要るのか',
  '   優位性はオッズとの乖離から生まれます。確率だけで買うと回収83〜91%で負けます。',
  '   単勝プールは薄く、締切間際に大きく動きます。締切2分前でも1番人気が',
  '   確定と一致するのは70%しかありません。だから「今のオッズ」で判断してください。',
  '',
  '★ 買えない日があります',
  '   実測で1日平均2.05本、6日に1日は1本も買えません。それが正常です。',
  '   条件を満たさないのに買うと負けます。',
  '',
  '★ 短期では必ず負ける時期があります',
  '   的中率は約29%です。7割は外れます。3本とも外れる日が普通にあります。',
  '   回収率の想定は約151%ですが、100点（約2ヶ月）でようやく形が見えます。',
  '   少額で数回試して勝てるものではありません。',
]


// ---------- 単勝オッズ ----------
// ★プールが形成されているかを Σ(1/オッズ) で検算してから返す。
//   1.25〜1.45 の外なら、まだ数字になっていないので採用しない。
async function tanshoOdds(races) {
  const ymd = DATE.replace(/-/g, '')
  const out = new Map()
  for (let i = 0; i < races.length; i += 5) {
    await Promise.all(races.slice(i, i + 5).map(async (x) => {
      try {
        const h = await (await fetch(`https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${x.race_no}&jcd=${p2(x.jcd)}&hd=${ymd}`,
          { signal: AbortSignal.timeout(20_000) })).text()
        const v = [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
        if (v.length !== 12) return
        const o = v.slice(0, 6).map(Number)
        if (o.some((n) => !Number.isFinite(n) || n <= 0)) return
        const sum = o.reduce((a, n) => a + 1 / n, 0)
        if (sum < 1.25 || sum > 1.45) return    // プール未形成。使わない
        out.set(x.race_id, new Map(o.map((n, k) => [String(k + 1), n])))
      } catch {}
    }))
    await new Promise((r) => setTimeout(r, 150))
  }
  return out
}

// ---------- 締切時刻 ----------
async function deadlines(jcds) {
  const ymd = DATE.replace(/-/g, '')
  const m = new Map()
  for (const j of jcds) {
    try {
      const h = await (await fetch(`https://www.boatrace.jp/owpc/pc/race/raceindex?jcd=${p2(j)}&hd=${ymd}`,
        { signal: AbortSignal.timeout(20_000) })).text()
      m.set(j, [...h.matchAll(/(\d{1,2}:\d{2})/g)].map((x) => x[1]).slice(0, 12))
    } catch { m.set(j, []) }
    await new Promise((r) => setTimeout(r, 250))
  }
  return m
}

const main = async () => {
  console.log(`予想を作成中（${DATE}${LIVE ? ' / 直前判定' : ''}）...`)
  const r = await runPredict(ROOT, DATE, LIVE ? 0 : 20)
  const DL = await deadlines([...new Set(r.races.map((x) => x.jcd))])
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const withDL = r.races.map((x) => {
    const dl = DL.get(x.jcd)?.[x.race_no - 1] ?? null
    const mins = dl ? Number(dl.slice(0, 2)) * 60 + Number(dl.slice(3)) : null
    return { ...x, dl, mins, until: mins == null ? null : mins - nowMin }
  }).filter((x) => x.dl)

  // ---------- 無料：3連複3点 ----------
  if (ONLY !== 'paid' && !LIVE) {
    const free = freePicks(withDL)
    console.log(`\n${'='.repeat(62)}\n【無料配信】${DATE}　3連複 厳選2レース\n${'='.repeat(62)}`)
    for (const x of free) {
      console.log(`\n■ ${x.venue} ${x.race_no}R（締切 ${x.dl}）`)
      console.log(`   3連複3点: ${x.trio.map((t) => t.combo).join(' / ')}`)
      // ★展開の見せ方。これは買い目ではない（下の注意書きとセットで出すこと）
      if (x.flow) console.log(`   展開なら : ${x.flow.text}（この2点で${(x.flow.p * 100).toFixed(1)}%）`)
      console.log(`   的中確率: ${(x.conf * 100).toFixed(1)}%`)
      console.log(`   1着予想 : ${x.first.slice(0, 3).map((f) => `${f.lane}号艇 ${f.name}(${(f.p * 100).toFixed(0)}%)`).join(' / ')}`)
    }
    console.log(`\n※ 3連複3点の実測は 的中54.1% / 回収78.8%（8ヶ月35,668レース・月別8ヶ月とも100%未満）。`)
    console.log(`   よく当たりますが、買い続ければ確実に負けます。無料でお試しください。`)
  }

  // ---------- 有料：単勝 ----------
  if (ONLY !== 'free') {
    // 全国勝率は番組表から引く（朝の時点で分かる）
    const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
    const WR = new Map()
    for (const r of db.prepare(`SELECT race_id, lane, win_rate_nat FROM programs WHERE substr(race_id,1,8)=?`)
      .all(DATE.replace(/-/g, ''))) WR.set(r.race_id + '|' + r.lane, r.win_rate_nat)
    db.close()

    const cand = withDL
      .map((x) => {
        const f = x.first[0]; if (!f) return null
        return { x, lane: String(f.lane), name: f.name, p: f.p, wr: WR.get(x.race_id + '|' + f.lane) }
      })
      .filter((c) => c && c.p >= MIN_P && c.p < MAX_P)
      .sort((a, b) => b.p - a.p)     // ★確率が高い順。2026-08-23に「勝率が低い順」から変更。
                                     //   オッズ順で並べてはいけないのは変わらない（下の誤り2・誤り4）

    if (LIVE) {
      // 締切が近いものだけ、実オッズで買う／見送りを判定する
      const near = cand.filter((c) => c.x.until != null && c.x.until >= 0 && c.x.until <= ODDS_VALID_MINS)
      console.log(`\n${'='.repeat(62)}\n【直前判定】${DATE} ${now.toTimeString().slice(0, 5)} 時点\n${'='.repeat(62)}`)
      if (!near.length) { console.log(`\n締切${ODDS_VALID_MINS}分以内で条件を満たすレースはありません。`); return }
      const od = await tanshoOdds(near.map((c) => c.x))
      for (const c of near) {
        const o = od.get(c.x.race_id)?.get(c.lane)
        const judge = o == null ? 'オッズ未形成 → 見送り'
          : o >= minOddsFor(c.p, MARGIN) ? `★ 買い（${o.toFixed(1)}倍 ≥ 必要${minOddsFor(c.p, MARGIN).toFixed(2)}倍）` : `見送り（${o.toFixed(1)}倍 < 必要${minOddsFor(c.p, MARGIN).toFixed(2)}倍）`
        console.log(`  ${c.x.dl}（あと${c.x.until}分）  ${c.x.venue}${c.x.race_no}R  ${c.lane}号艇 ${c.name}  確率${(c.p * 100).toFixed(0)}%  ${judge}`)
      }
      return
    }

    console.log(`\n${'='.repeat(62)}\n【有料配信】${DATE}　単勝　候補${Math.min(CAND, cand.length)}レース\n${'='.repeat(62)}`)
    console.log(`
条件：締切2〜3分前の単勝オッズ ≥ (1÷1着確率)×${MARGIN}　1日${MAX_BUY}本まで`)
    console.log(`実測：回収148.0%／的中37.5%／1日3.00本（8ヶ月234日・月別8/8・実払戻・締切順）`)
    console.log(`　　　締切前判断の目減りを引いた想定は 約151%\n`)
    if (!cand.length) console.log('   本日は条件を満たすレースなし')
    const show = [...cand.slice(0, CAND)].sort((a, b) => a.x.mins - b.x.mins)
    for (const c of show) {
      console.log(`  ${c.x.dl}  ${(c.x.venue + c.x.race_no + 'R').padEnd(9)}  ${c.lane}号艇 ${c.name.padEnd(6)}  1着確率${(c.p * 100).toFixed(0)}%  全国勝率${c.wr.toFixed(2)}`)
    }
    console.log(`\n${'─'.repeat(62)}`)
    for (const l of NOTE_PAID) console.log(l)
    console.log('')
    console.log('※ 拡連複・2連複は配信しません。')
    console.log('   確定オッズ基準では100%を超えますが、締切前オッズで判断して成立するかを')
    console.log('   検証できておらず、買えば負ける可能性があるためです。')
    console.log('※ 締切直前の判定はこれで出せます： node scripts/picks.mjs --live')
  }
}
main().catch((e) => { console.error('失敗:', e.message); process.exit(1) })
