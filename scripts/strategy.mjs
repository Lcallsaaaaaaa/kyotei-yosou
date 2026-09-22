// 買い目の条件と、共通で使う取得処理。
//
// ★なぜ切り出すか
//   picks.mjs（人が見る配信用）と auto-bet.mjs（自動判定）が同じ条件で動く必要がある。
//   条件を2箇所に書くと、片方だけ直して食い違う。実際にこの案件では
//   「確率×想定オッズ下限」の近似を片方に残したまま検証を進め、
//   実行不可能な186%という数字を出してしまった。条件は1箇所に置く。
//
// ═══ 2026-08-23 全面見直し。選ぶ順序が逆だった ═══
//
// ★誤り：「オッズが高くなりそうな候補」を先に選んでいた
//   確率が高い艇は必ずオッズが安い、と思い込み、あえて確率の低い帯
//   （単勝30〜40%／複勝40〜60%）を狙っていた。これが的中率を落としていた。
//   実際には**確率70%でも1.8倍以上つくレースが247本ある**。
//
// ★正しい順序：確率が高い候補を作ってから、オッズで選ぶ
//   単勝 従来 的中28.1%/回収149.8%/月7/8  →  新 的中51.6%/回収171.4%/月8/8
//   複勝 従来 的中44.1%/回収177.4%/月7/8  →  新 的中72.2%/回収147.3%/月8/8
//   的中率・回収率・安定性・本数のすべてが改善した。
//
// ★なぜ極端な乖離を狙ってはいけないか（実測）
//   モデルと市場の本命が食い違った6,274レースで、乖離の大きさ別に測ると：
//     乖離1〜2倍 モデル39.8% vs 市場27.3%（モデルの勝ち）
//     乖離2〜4倍 モデル34.7% vs 市場28.8%（モデルの勝ち）
//     乖離4〜8倍 モデル27.2% vs 市場33.3%（**市場の勝ち**）
//   市場が「この艇は無い」と強く言うときは、市場が正しい。
//   狙うべきは「モデルが強く推し、市場もそこそこ評価しているが、まだ足りない」場面。
//
// ★回収率は必ず payouts.amount（実払戻）で計算する
//   確定オッズ×100 は返還のあったレースでズレる。実測で合計1.021%過大だった。
//
// ═══ 条件（歩進検証 2026-01〜08・36,171レース・実払戻ベース） ═══

// ═══ 2026-08-23 夕 足切りを「固定倍率」から「買い目ごとの損益分岐」に変えた ═══
//
// ★なぜ変えたか
//   固定2.5倍は、確率52%の買い目にも確率90%の買い目にも同じ線を引いていた。
//   確率90%なら1.12倍で元が取れるのに2.5倍を要求し、
//   確率52%なら1.93倍必要なのに2.5倍で一括りにしていた。
//   買い目ごとに必要な倍率は違う。**必要倍率 = 1 ÷ 確率**（損益分岐）。
//   モデルの較正は良好（予測57.19%対実際57.09%）なので、この式は根拠がある。
//
// ★確率だけでは絶対に100%を超えない（実測・オッズ条件なし）
//   単勝 確率50%以上→回収92.5% ／ 70%以上→93.9% ／ 85%以上→95.5%
//   複勝 確率70%以上→94.5% ／ 85%以上→95.6% ／ 93%以上→96.8%
//   的中率をいくら上げても控除率25%を超えられない。
//   **優位はオッズの足切りからしか出ない。** 的中率は「必要倍率」を決める材料。
//
// ★最終判断は買う本人
//   画面に出る倍率は締切2〜3分前の目安。投票は締切間際に集中するので確定とはズレる。
//   システムの仕事は「この買い目は◯倍以下なら買うな」を正しく出すこと。
//   その場のオッズを見て買うか決めるのは人間の仕事。

/** ★bets の bet_type → payouts の bet_type
 *  高的中モード(fuku90)は買う舟券としては普通の複勝。払戻の引き当ては fukusho を使う。
 *  ここを間違えると「買ったのに払戻が見つからない＝全部はずれ」になる。 */
export const payoutType = (t) => (t === 'fuku90' ? 'fukusho' : t)

/** 買い目に必要な最低オッズ。1÷確率（損益分岐）に余裕を掛ける */
export const minOddsFor = (p, margin) => (1 / p) * margin

// ---------- 単勝 ----------
//   足切り：確定オッズ ≥ (1÷1着確率) × 2.0 ／ 1日3本まで ／ 締切が早い順
//     573点（226日・1日2.54本）／的中35.8%／回収193.9%
//     月別8/8（141〜278%）／前半189.1%・後半198.8%
//     上位3本除外→185.3%／上位10本除外→171.2%（最高21.6倍）
//     ブート90%区間[173.3%, 214.8%]・100%割れ0.00%
//     単調：×1.0 106.9% → ×1.5 148.0% → ×1.8 177.7% → ×2.0 193.9% → ×2.5 254.1%
//   ※×1.5（148.0%）と×1.8（177.7%）も5検定を通っている。本数を増やしたいなら下げてよい。
//     ×2.5は254.1%だが1日1.87本まで減り、5検定は未実施。
// ★2026-08-31 全面変更（本人承認）
//   ① 対象を本命1艇 → **全6艇** に広げた
//   ② 確率を **校正**してから必要倍率を計算する（calib.mjs）
//   ③ 余裕を 2.0 → **1.3** に下げた
//   ④ 1日の上限を撤廃
//   歩進検証（45,273レース・2025-11〜2026-08・実際の払戻ベース）:
//     1日46.6本／的中15.74%／平均払戻1,052円／**回収165.58%**／9ヶ月すべて100%超
//   旧条件（本命1艇・余裕2.0・校正なし）は 1日3本・回収193.9% と出ていたが、
//   本数が少なく1日の利益は+847円。新条件は+4,221円で5倍。
//   ⚠ 1レースで複数該当したら**全部買う**。1艇に絞ると回収が9〜21pt下がる（実測）。
export const MARGIN = 1.3            // 損益分岐に対する余裕（校正後の確率に掛ける）
export const USE_CALIB = true        // 確率を校正してから判定するか
export const ALL_LANES = true        // 本命1艇でなく全6艇を対象にするか
export const MIN_P = 0               // 確率の下限は設けない（足切りは倍率側で効く）
export const MAX_P = 1.01
export const MAX_WR = 99             // 全国勝率での足切りはしない
export const MAX_BUY = 999           // 上限なし（2026-08-31に3本から変更）
// ★候補は絶対に絞らないこと（実測）
//   「確率上位K本だけを候補にして早い順に買う」は壊滅する。
//   高確率のレースはほぼ全部オッズが安く、足切りを通るのは確率帯の下のほう。
//   絞るのは足切りを通ったあとだけ。それが MAX_BUY。
export const CAND = 999              // 実質無制限

// ★オッズが信用できるのは締切15分前以降だけ
//   Σ(1/オッズ) の実測：確定1.36 ／ 1〜13分前1.35 ／ 20〜29分前2.71 ／ 45〜60分前4.07。
export const ODDS_VALID_MINS = 15
// ★何分前に判定するか＝**締切2〜3分前**
//   締切前オッズが確定と±10%以内に収まる割合の実測：
//     0分前19.1% ／ 2分前13.3% ／ 10分前10.4% ／ 20分前11.1%。
//   投票の大半が締切間際に入るので、**遅く見るほど確定に近い**。
//   以前は買う時間を確保するため12分前に見ていたが、それは確定とほぼ別物だった。
export const CHECK_FROM = 3
export const CHECK_UNTIL = 2
export const CHECK_AT = CHECK_FROM   // 旧名（互換）

const p2 = (n) => String(n).padStart(2, '0')

// ---------- 複勝 ----------
//   足切り：複勝オッズ下限 ≥ (1÷2着以内確率) × 1.3 ／ 1日4本まで ／ 締切が早い順
//     693点（226日・1日3.07本）／的中60.3%／回収188.5%／平均確定2.43倍
//     月別8/8（148〜263%）／前半195.2%・後半181.8%
//     上位10本除外→159.3%
//     ブート90%区間[166.6%, 217.2%]・100%割れ0.00%
//     単調：×1.0 127.7% → ×1.2 175.4% → ×1.3 188.5% → ×1.5 234.3%
//   ※×1.5（355点・234.3%・月8/8）も5検定を通るが**採用しない**。
//     上位3本を除くと234.3%→189.1%まで落ちる（96.8倍の1本に依存）。
//     ×1.3は188.5%→167.7%で、こちらのほうが頑丈。
//
// ★なぜ「下限」で判定するか
//   複勝オッズは幅表示。実測109,553件で払戻が下限〜上限に収まるのが99.0%、
//   下限ちょうどが61.3%、下回るのは1.0%。**下限は実質の保証値**。
//
// ★プール形成の検算は Σ(1/下限)
//   2着以内＝2枠なので単勝(1.36)とは基準が違う。実測は中央3.111。
// ---------- 複勝・高的中モード ----------
//   「当たる回数を最優先したい」ための別枠。損益分岐方式とは選び方が違う。
//
//   条件：2着以内確率94%以上 ／ 複勝オッズ下限1.1倍以上 ／ 荒れやすい4場を除く
//     165点（107日・1日1.54本）／**的中91.5%**／回収127.2%
//     月別8/8（112〜146%）／前半123.0%・後半131.3%
//     上位3本除外→120.2%／上位10本除外→110.4%
//     **最高配当4.5倍＝大穴に一切依存しない**（他の条件には無い性質）
//     ブート90%区間[119.8%, 134.8%]・100%割れ0.00%
//
// ★確率を上げるだけでは100%を超えない（実測）
//   確率90%以上→回収96.4%(月0/8) ／94%以上→98.0%(月1/8) ／97%以上→98.9%(月4/8)。
//   的中94.9%でも回収98.9%。**オッズの足切りを足して初めて超える。**
//
// ★風速・波高は使わない
//   荒れると的中率は確かに落ちる（穏やか91.0% / 荒れ87.1%・後半4ヶ月で検証）。
//   だが**風速・波高はKファイル（結果）から入る値で、買う時点では手元に無い**。
//   実測でも場フィルタだけで十分だった（場のみ 的中91.5%・月8/8 ／ 風波込み 91.3%・月7/8）。
//
// ★除外する場は「弱い補正」として扱うこと
//   前半4ヶ月で悪い場を選び後半4ヶ月で試したところ、効果は残るが+0.5ptしかない。
//   しかも前半で選ばれたのは 17,16,13,1 で、下の 17,16,13,7 と1つズレた。
//   **中心の効果は「確率94%以上×下限1.1倍」の側**（フィルタ無しでも的中90.9%）。
export const FUKU90 = {
  minP: 0.94,                 // 2着以内確率の下限
  minOdds: 1.1,               // 複勝オッズ下限の足切り（損益分岐1.064倍に対し余裕1.03）
  badVenues: [17, 16, 13, 7], // 宮島・児島・尼崎・蒲郡
  maxBuy: 2,                  // 1日2本まで（実測1.54本/日）
  cand: 999,
}

export const FUKU = {
  margin: 1.3,                // 損益分岐に対する余裕
  minP: 0, maxP: 1.01,        // 確率の下限は設けない
  maxWR: 99,
  maxBuy: 4,                  // 複勝は4本まで
  cand: 999,
  sumLo: 2.5, sumHi: 3.8,     // Σ(1/下限) の妥当範囲
}
/** 複勝オッズ（下限）を取る。プール未形成なら採用しない */
export async function fukushoOdds(ymd, races, conc = 5) {
  const out = new Map()
  for (let i = 0; i < races.length; i += conc) {
    await Promise.all(races.slice(i, i + conc).map(async (x) => {
      try {
        const h = await (await fetch(
          `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${x.race_no}&jcd=${p2(x.jcd)}&hd=${ymd}`,
          { signal: AbortSignal.timeout(20_000) })).text()
        const v = [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
        if (v.length !== 12) return
        // 後半6つが複勝の「下限-上限」（例 "1.4-2.2"）。下限だけ取る。
        const lo = v.slice(6, 12).map((t) => { const m = t.match(/^([\d.]+)/); return m ? Number(m[1]) : null })
        // ★単勝と同じく 0.0 を除外して検算する。
        //   6艇すべてを要求すると、1つでも0のレースを丸ごと捨ててしまう。
        //   2026-08-23 唐津8Rで実際に判定できなかった。
        const valid = lo.map((n, k) => [k + 1, n]).filter(([, n]) => Number.isFinite(n) && n > 0)
        if (valid.length < 4) return
        const sum = valid.reduce((a, [, n]) => a + 1 / n, 0)
        if (sum < FUKU.sumLo || sum > FUKU.sumHi) return       // プール未形成
        out.set(x.race_id, { odds: new Map(valid), sum })
      } catch {}
    }))
    await new Promise((r) => setTimeout(r, 150))
  }
  return out
}

/** 複勝の候補。predict.mjs の --json が返す top2（2着以内確率）を使う */
export function fukuCandidates(races, wrMap) {
  return races
    .map((x) => {
      const f = x.top2?.[0]; if (!f) return null
      const wr = wrMap.get(x.race_id + '|' + f.lane)
      return { x, lane: f.lane, name: f.name, p: f.p, wr }
    })
    .filter((c) => c && c.p >= FUKU.minP && c.p < FUKU.maxP)
    // ★確率が高い順。オッズの足切りは auto-bet 側（締切前オッズを見てから）で行う。
    .sort((a, b) => b.p - a.p)
}

/** predict.mjs の出力から候補を作る。wrMap は `race_id|lane` → 全国勝率 */
export function candidates(races, wrMap) {
  return races
    .map((x) => {
      const f = x.first?.[0]; if (!f) return null
      const wr = wrMap.get(x.race_id + '|' + f.lane)
      return { x, lane: f.lane, name: f.name, p: f.p, wr }
    })
    .filter((c) => c && c.p >= MIN_P && c.p < MAX_P)
    // ★確率が高い順に並べる。
    //   以前は「勝率が低い順＝オッズが高くなりやすい順」にしていたが、
    //   それは的中率を犠牲にして高配当を拾う並べ方だった。
    //   確率で並べ、必要倍率(1÷確率×余裕)を通ったものから上限まで買う。
    .sort((a, b) => b.p - a.p)
}

/** 単勝オッズを取る。プール未形成なら採用しない（Σ(1/オッズ)で検算） */
export async function tanshoOdds(ymd, races, conc = 5) {
  const out = new Map()
  for (let i = 0; i < races.length; i += conc) {
    await Promise.all(races.slice(i, i + conc).map(async (x) => {
      try {
        const h = await (await fetch(
          `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${x.race_no}&jcd=${p2(x.jcd)}&hd=${ymd}`,
          { signal: AbortSignal.timeout(20_000) })).text()
        const v = [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => m[1].trim())
        if (v.length !== 12) return
        // ★0.0 が混じることがある（その艇のオッズがまだ出ていない／欠場）。
        //   6艇すべてを要求すると、1つでも0のレースを丸ごと捨ててしまう。
        //   2026-08-23 唐津8Rで実際に判定できなかった。
        //   → 0は「その艇は無い」として除外し、残りで検算する。
        const raw = v.slice(0, 6).map(Number)
        const valid = raw.map((n, k) => [k + 1, n]).filter(([, n]) => Number.isFinite(n) && n > 0)
        if (valid.length < 4) return                  // 4艇未満は判断材料が足りない
        const sum = valid.reduce((a, [, n]) => a + 1 / n, 0)
        // ★許容幅は実測に基づく。確定1.36／プール形成済み1.35／未形成2.7〜4.1。
        //   1.25〜1.45は狭すぎた（唐津8Rは1.2496で0.0004足りず弾かれた）。
        //   1.15〜1.60でも未形成（2.7以上）とは明確に分かれる。
        if (sum < 1.15 || sum > 1.60) return           // プール未形成
        out.set(x.race_id, { odds: new Map(valid), sum })
      } catch {}
    }))
    await new Promise((r) => setTimeout(r, 150))
  }
  return out
}

/** 場ごとの12レース分の締切時刻 */
export async function deadlines(ymd, jcds) {
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

/** predict.mjs を回して JSON を受け取る。
 *
 * ★結果をファイルに残して使い回す
 *   predict.mjs は133万行の履歴を積み直すので毎回4〜5分かかる。
 *   朝のバッチは「展開解説」「無料予想」「有料候補」を続けて作るので、
 *   都度回すと15分かかる。1回の結果を共有すれば5分で済む。
 *
 * ★ただし古い結果を使い回してはいけない
 *   既定の有効期限は20分。締切直前に使う auto-bet では maxAgeMin を小さくすること。
 *
 * ★直前情報（展示タイム等）は取らない（--nobefore）
 *   取得は156レース分のページを1件ずつ叩くので**200秒以上**かかる。全体236秒の大半。
 *   そして成績に寄与しない。歩進検証で実測：
 *     展示あり 単勝143.4% / 複勝162.0% ／ 本命的中57.22%
 *     展示なし 単勝145.9% / 複勝174.5% ／ 本命的中57.24%
 *   展示が伝える「機力」は、モーター2連率・当地成績・選手の実力に既に含まれている。
 *   → 200秒かけて成績が変わらないので取らない。
 *   加えて**検証と実運用の条件が揃う**（検証は wh1＝展示なしで測っている）。
 */
export async function runPredict(root, date, maxAgeMin = 20) {
  const fs = await import('node:fs')
  const cache = `${root}/data/predict-${date}.json`
  const lock = `${root}/data/predict-${date}.lock`
  const read = () => {
    try {
      const st = fs.statSync(cache)
      const age = (Date.now() - st.mtimeMs) / 60_000
      if (age <= maxAgeMin) {
        const j = JSON.parse(fs.readFileSync(cache, 'utf8'))
        if (j?.races?.length) return { j, age }
      }
    } catch {}
    return null
  }
  const hit = read()
  if (hit) { console.error(`（${hit.age.toFixed(0)}分前の予想を再利用）`); return hit.j }

  // ★同時に2つ計算させない
  //   8/23に auto-bet と画面の「予想」ボタンが同時に走り、CPUを取り合って
  //   計算が7分以上かかった。その間に常滑2Rの判定時刻を過ぎた。
  //   先客がいれば待ち、その結果を使う。
  for (let i = 0; i < 240; i++) {                    // 最長4分待つ
    let held = false
    try {
      const st = fs.statSync(lock)
      // 10分以上前のロックは、異常終了で残ったものとみなして無視する
      held = (Date.now() - st.mtimeMs) < 10 * 60_000
    } catch {}
    if (!held) break
    if (i === 0) console.error('（別の予想計算が動いています。終わるまで待ちます）')
    await new Promise((r) => setTimeout(r, 1000))
    const again = read()
    if (again) { console.error(`（待機中に出来上がった予想を使います）`); return again.j }
  }
  try { fs.writeFileSync(lock, String(process.pid)) } catch {}
  const { spawn } = await import('node:child_process')
  let j
  try {
    j = await new Promise((resolve, reject) => {
    // ★JSONは標準出力ではなくファイルに書かせる（--out）。
    //   168KBをパイプに流した直後に predict.mjs が process.exit() すると、
    //   Windowsでは書き込み完了前に終了処理が走りプロセスが固まる。
    //   2026-08-23に実際に17分ハングし、その間の判定が全部止まった。
    const p = spawn(process.execPath, ['--max-old-space-size=6144',
      root + '/scripts/predict.mjs', '--date', date, '--trio', '--json', '--nobefore',
      '--out', cache], { cwd: root })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => {
      try {
        const j = JSON.parse(fs.readFileSync(cache, 'utf8'))
        if (j?.races?.length) return resolve(j)
      } catch {}
      reject(new Error(`予想が取得できません（code ${code}）: ${out.slice(-300)}`))
    })
    })
  } catch (e) {
    try { fs.unlinkSync(lock) } catch {}     // 失敗してもロックは必ず外す
    throw e
  }
  // cache は predict.mjs が --out で直接書いている
  try { fs.unlinkSync(lock) } catch {}
  return j
}

/** 全国勝率を番組表から引く */
export function winRates(db, ymd) {
  const m = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, win_rate_nat FROM programs WHERE substr(race_id,1,8)=?`).all(ymd))
    m.set(r.race_id + '|' + r.lane, r.win_rate_nat)
  return m
}

// ---------- 無料配信（3連複3点）の選び方 ----------
// ★実測は 的中54.1% / 回収78.8%（8ヶ月35,668レース・月別8ヶ月とも100%未満）。
//   よく当たるが買い続ければ負ける券種。だから無料の看板に使う。
//   **利益が出ると読める書き方をしてはいけない。**
export const FREE_N = 2          // 1日2本＝週14本
export const FREE_LEAD = 15      // 締切までこれだけ余裕があるものだけ

/** 締切が来ていないレースから、自信の高い順に時間帯を散らして選ぶ */
export function freePicks(withDL, n = FREE_N, lead = FREE_LEAD) {
  const live = withDL.filter((x) => x.until != null && x.until >= lead)
  const out = []
  for (const [lo, hi] of [[0, 14 * 60], [14 * 60, 24 * 60]]) {
    const c = live.filter((x) => x.mins >= lo && x.mins < hi && !out.some((f) => f.race_id === x.race_id))
    if (c.length) out.push(c.sort((a, b) => b.conf - a.conf)[0])
  }
  // 片方の時間帯が終わっていたら残りから補う
  const more = live.filter((x) => !out.some((f) => f.race_id === x.race_id)).sort((a, b) => b.conf - a.conf)
  while (out.length < n && more.length) out.push(more.shift())
  return out.slice(0, n).sort((a, b) => a.mins - b.mins)
}
