// 1日常駐して、候補レースの締切前に自動でオッズを見て「買い／見送り」を記録する。
// 単勝と複勝の両方を扱う。
//
//   node scripts/auto-bet.mjs --date 2026-08-22
//   node scripts/auto-bet.mjs --only fukusho     複勝だけ
//   node scripts/auto-bet.mjs --dry              候補を作って表示するだけ
//
// ★なぜ常駐が要るか
//   判定に使えるオッズは締切15分前以降にしか出ない（それ以前はプール未形成で
//   Σ(1/オッズ)が2.7〜4.1になり数字として意味が無い）。
//   候補は1日30本前後あり、締切は朝から夜まで散らばる。人が叩き続けるのは続かない。
//
// ★記録するもの
//   買った／見送った の判定と、その時点で見えていたオッズを bets テーブルに残す。
//   翌日 results.mjs が払戻と突き合わせて成績を出す。
//   **見送りも記録する。**買ったものだけ残すと「都合よく選んだ」記録になり、
//   後から検証できない。
//
// ★これは自動購入ではない
//   舟券は買わない。判定と記録だけを行う。購入は人が行う。
//
// ★8/22に踏んだ罠（再発防止）
//   途中で再起動すると候補を選び直すことになる。締切が過ぎたレースが新たに
//   入り込んで「判定できず」が量産され、逆に判定待ちだったレースが候補から
//   落ちて取りこぼす。実際に福岡6R・7Rを落とした。
//   → すでに記録がある日は、その候補をそのまま引き継ぐ。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {mkdirSync, writeFileSync } from 'node:fs'
import * as S from './strategy.mjs'
import { loadCalib, shouldBuy } from './calib.mjs'
import { notifyBuy } from './notify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const p2 = (n) => String(n).padStart(2, '0')
const DATE = flag('date', (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` })())
const YMD = DATE.replace(/-/g, '')
const DRY = argv.includes('--dry')
// ★条件を変えた日だけ使う。既存の候補を引き継がず選び直す。
//   判定済み（買い／見送り／取り逃し）の記録は残したまま、pendingだけ入れ替わる。
const RESELECT = argv.includes('--reselect')
const ONLY = flag('only', null)

// ---------- 券種ごとの設定 ----------
// 条件の根拠は strategy.mjs に書いてある。ここに数字を直接書かないこと。

const TYPES = [
  { key: 'tansho', label: '単勝', margin: S.MARGIN, maxBuy: S.MAX_BUY, cand: S.CAND,
    // ★2026-08-31: 本命1艇 → 全6艇。1レースで複数該当したら全部買う。
    //   1艇に絞ると回収が9〜21pt下がる（実測）。実際に条件を満たすのは見張りの9.1%。
    picks: (x) => (S.ALL_LANES ? (x.first ?? []) : (x.first ? [x.first[0]] : [])),
    minP: S.MIN_P, maxP: S.MAX_P, maxWR: S.MAX_WR,
    odds: (races) => S.tanshoOdds(YMD, races),
    note: `必要倍率=(1÷1着確率)×${S.MARGIN} / 1日${S.MAX_BUY}本まで` },
  { key: 'fukusho', label: '複勝', margin: S.FUKU.margin, maxBuy: S.FUKU.maxBuy, cand: S.FUKU.cand,
    pick: (x) => x.top2?.[0], minP: S.FUKU.minP, maxP: S.FUKU.maxP, maxWR: S.FUKU.maxWR,
    odds: (races) => S.fukushoOdds(YMD, races),
    note: `必要倍率=(1÷2着以内確率)×${S.FUKU.margin} / 1日${S.FUKU.maxBuy}本まで` },
  // ★高的中モード。買う舟券は普通の複勝だが、選び方が違うので別枠で記録する。
  //   混ぜると両方薄まる（併用で検証したら 的中60.3→63.5%、回収188.5→183.0%）。
  { key: 'fuku90', label: '複勝・高的中', maxBuy: S.FUKU90.maxBuy, cand: S.FUKU90.cand,
    pick: (x) => x.top2?.[0], minP: S.FUKU90.minP, maxP: 1.01, maxWR: 99,
    fixedOdds: S.FUKU90.minOdds,                       // 損益分岐ではなく固定の下限
    venueNG: new Set(S.FUKU90.badVenues),
    odds: (races) => S.fukushoOdds(YMD, races),
    note: `2着以内確率${S.FUKU90.minP * 100}%以上 / 複勝下限${S.FUKU90.minOdds}倍以上 / 1日${S.FUKU90.maxBuy}本まで` },
].filter((t) => !ONLY || t.key === ONLY)

mkdirSync(join(ROOT, 'logs'), { recursive: true })
// ★生存記録。画面はこのファイルの更新時刻で「動いているか」を判断する。
//   以前は status.mjs から PowerShell でプロセス一覧を取っていたが、
//   spawn経由だと引数の二重引用符が壊れて必ず失敗し、常に「停止中」と出ていた。
//   1回1.8秒かかるうえ壊れやすいので、自分で書く方式に変えた。
const beat = () => { try { writeFileSync(join(ROOT, 'logs', 'hb-auto-bet.txt'), new Date().toISOString()) } catch {} }
beat()
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
db.exec(`CREATE TABLE IF NOT EXISTS bets (
  race_id TEXT NOT NULL, lane INTEGER NOT NULL, bet_type TEXT NOT NULL DEFAULT 'tansho',
  date TEXT NOT NULL, venue TEXT, race_no INTEGER, deadline TEXT, racer TEXT,
  p REAL, win_rate REAL, odds_seen REAL, mins_before INTEGER, decision TEXT, checked_at TEXT,
  PRIMARY KEY (race_id, lane, bet_type))`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_bets_date ON bets(date)`)

// ★確率の校正表。モデルは自信過剰（0.8と言って実際71.5%）なので、
//   そのまま必要倍率を出すと低すぎて買いすぎる。歩進検証の実績に引き直す。
//   これを入れると余裕1.3で回収 141.95% → 165.58%（実測）。
const CAL = S.USE_CALIB ? loadCalib(db, 'wi1') : null
if (CAL) console.log(`確率の校正表 ${CAL.size}升を読み込み`)

const log = (s) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${s}`)
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

log(`${DATE} の候補を作成中...`)
// ★当日のキャッシュがあればそのまま使う（12時間）。
//   直前情報（--nobefore）を使わなくなったので、当日の予想は
//   「その日より前の履歴＋当日の番組表」だけで決まり、1日を通して変わらない。
//   毎回計算し直すと、再起動のたびに数分間の判定空白ができる。
//   実際 8/23 に再起動後の再計算中、常滑2R・江戸川1Rの判定時刻を過ぎた。
const pred = await S.runPredict(ROOT, DATE, 720)
const WR = S.winRates(db, YMD)
const DL = await S.deadlines(YMD, [...new Set(pred.races.map((x) => x.jcd))])
const withDL = new Map(pred.races.map((x) => {
  const dl = DL.get(x.jcd)?.[x.race_no - 1] ?? null
  return [x.race_id, { ...x, dl, mins: dl ? toMin(dl) : null }]
}))

const ins = db.prepare(`INSERT OR REPLACE INTO bets
  (race_id,lane,bet_type,date,venue,race_no,deadline,racer,p,win_rate,odds_seen,mins_before,decision,checked_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const getDec = db.prepare(`SELECT decision FROM bets WHERE race_id=? AND lane=? AND bet_type=?`)
const bought = (k) => db.prepare(`SELECT COUNT(*) n FROM bets WHERE date=? AND bet_type=? AND decision='buy'`).get(DATE, k).n

// ---------- 券種ごとに候補を確定させる ----------
const nowM = nowMin()
for (const T of TYPES) {
  if (RESELECT) {
    const del = db.prepare(`DELETE FROM bets WHERE date=? AND bet_type=? AND decision='pending'`).run(DATE, T.key)
    if (del.changes) log(`${T.label}: 未判定の候補 ${del.changes}本を破棄して選び直します（判定済みは残します）`)
  }
  const existing = db.prepare(`SELECT race_id,lane,deadline,racer,p,win_rate,venue,race_no
    FROM bets WHERE date=? AND bet_type=?`).all(DATE, T.key)
  if (existing.length && !RESELECT) {
    log(`${T.label}: 既存の候補 ${existing.length}本を引き継ぎます（選び直しません）`)
    T.cands = existing.map((e) => ({
      x: withDL.get(e.race_id) ?? { race_id: e.race_id, jcd: Number(e.race_id.slice(9, 11)), venue: e.venue, race_no: e.race_no },
      lane: e.lane, name: e.racer, p: e.p, wr: e.win_rate, dl: e.deadline, mins: toMin(e.deadline),
    })).sort((a, b) => a.mins - b.mins)
    continue
  }
  T.cands = [...withDL.values()]
    .flatMap((x) => {
      if (!x.dl) return []
      // picks があれば複数艇、無ければ従来どおり1艇
      const fs = T.picks ? T.picks(x) : (T.pick(x) ? [T.pick(x)] : [])
      return fs.map((f) => ({ x, lane: f.lane, name: f.name, p: f.p,
        wr: WR.get(x.race_id + '|' + f.lane), dl: x.dl, mins: x.mins }))
    })
    .filter((c) => c && c.p >= T.minP && c.p < T.maxP && c.mins >= nowM
      && !(T.venueNG && T.venueNG.has(c.x.jcd)))
    // ★確率が高い順。
    //   2026-08-23まで「勝率が低い順＝オッズが高くなりやすい順」にしていたが、
    //   これは的中率を捨てて高配当を拾う並べ方で、実際に的中しなかった。
    //   確率順に上位T.cand本へ絞り、そこから必要倍率(1÷確率×余裕)を通ったものを
    //   締切が早い順に上限まで買う（歩進検証で確認した手順）。
    .sort((a, b) => b.p - a.p)
    .slice(0, T.cand)
    .sort((a, b) => a.mins - b.mins)
  log(`${T.label}: 候補 ${T.cands.length}本（${T.note}）`)
  for (const c of T.cands)
    log(`   ${c.dl} ${c.x.venue}${c.x.race_no}R ${c.lane}号艇 ${c.name} 確率${(c.p * 100).toFixed(0)}% 勝率${c.wr == null ? '-' : c.wr.toFixed(2)}`)
  for (const c of T.cands) {
    const cur = getDec.get(c.x.race_id, c.lane, T.key)
    if (cur && cur.decision !== 'pending') continue
    ins.run(c.x.race_id, c.lane, T.key, DATE, c.x.venue, c.x.race_no, c.dl, c.name, c.p, c.wr, null, null, 'pending', null)
  }
}
if (DRY) { log('--dry のため判定は行いません'); db.close(); process.exit(0) }

log(`\n締切${S.CHECK_FROM}分前〜${S.CHECK_UNTIL}分前に判定します。（Ctrl+Cで終了）`)
for (;;) {
  const n = nowMin()
  let anyPending = false
  let soonest = Infinity        // 一番近い締切まで何分か（周回間隔の決定に使う）

  for (const T of TYPES) {
    // ★毎周DBから読む。メモリに抱えると、画面の「予想」ボタンで足した候補を拾えない。
    const pending = db.prepare(`SELECT race_id,lane,deadline,racer,p,win_rate,venue,race_no
      FROM bets WHERE date=? AND bet_type=? AND decision='pending'`).all(DATE, T.key)
      .map((e) => ({
        x: withDL.get(e.race_id) ?? { race_id: e.race_id, jcd: Number(e.race_id.slice(9, 11)), venue: e.venue, race_no: e.race_no },
        lane: e.lane, name: e.racer, p: e.p, wr: e.win_rate, dl: e.deadline, mins: toMin(e.deadline),
      })).sort((a, b) => a.mins - b.mins)
    if (!pending.length) continue
    anyPending = true
    for (const c of pending) { const m = c.mins - n; if (m >= 0 && m < soonest) soonest = m }

    // 締切を過ぎたものは閉じる
    for (const c of pending.filter((c) => c.mins - n < 0)) {
      db.prepare(`UPDATE bets SET decision='missed', checked_at=? WHERE race_id=? AND lane=? AND bet_type=?`)
        .run(new Date().toTimeString().slice(0, 8), c.x.race_id, c.lane, T.key)
      log(`  [${T.label}] ${c.x.venue}${c.x.race_no}R 締切を過ぎました → 判定できず`)
    }
    // 上限に達したら残りを閉じる
    if (bought(T.key) >= T.maxBuy) {
      for (const c of pending.filter((c) => c.mins - n >= 0))
        db.prepare(`UPDATE bets SET decision='capped', checked_at=? WHERE race_id=? AND lane=? AND bet_type=?`)
          .run(new Date().toTimeString().slice(0, 8), c.x.race_id, c.lane, T.key)
      log(`  [${T.label}] 本日${T.maxBuy}本に達しました。残りは見送ります`)
      continue
    }

    const due = pending.filter((c) => { const m = c.mins - n; return m >= S.CHECK_UNTIL && m <= S.CHECK_FROM })
    if (!due.length) continue
    const od = await T.odds(due.map((c) => c.x))
    for (const c of due) {
      if (bought(T.key) >= T.maxBuy) break
      const o = od.get(c.x.race_id)?.odds.get(c.lane) ?? null
      // ★プール未形成なら結論を出さず、次の周回で取り直す。
      //   1回の失敗で見送りにすると、取れたはずの買い目を落とす。
      if (o == null && c.mins - nowMin() > S.CHECK_UNTIL) {
        log(`  [${T.label}] ${c.x.venue}${c.x.race_no}R オッズ未形成 → 後で取り直す`); continue
      }
      // ★必要倍率は買い目ごとに違う（1÷確率×余裕）。固定倍率ではない。
      // ★必要倍率は買い目ごとに違う（1÷確率×余裕）。固定倍率ではない。
      //   単勝は確率を校正してから計算する（自信過剰の補正）。
      let need, pUsed = c.p
      if (T.fixedOdds != null) { need = T.fixedOdds }
      else if (CAL && T.key === 'tansho' && o != null) {
        const r = shouldBuy(CAL, c.p, o, T.margin)
        need = r.need; pUsed = r.p
      } else { need = S.minOddsFor(c.p, T.margin) }
      const decision = o == null ? 'no_odds' : o >= need ? 'buy' : 'skip'
      db.prepare(`UPDATE bets SET odds_seen=?, mins_before=?, decision=?, checked_at=? WHERE race_id=? AND lane=? AND bet_type=?`)
        .run(o, c.mins - nowMin(), decision, new Date().toTimeString().slice(0, 8), c.x.race_id, c.lane, T.key)
      const mark = decision === 'buy' ? `★ 買い（${o.toFixed(1)}倍）`
        : decision === 'skip' ? `見送り（${o.toFixed(1)}倍 < 必要${need.toFixed(2)}倍）` : 'オッズ未形成 → 見送り'
      const pTxt = pUsed !== c.p ? `確率${(c.p * 100).toFixed(0)}%→校正${(pUsed * 100).toFixed(0)}%` : `確率${(c.p * 100).toFixed(0)}%`
      log(`  [${T.label}] ${c.dl} ${c.x.venue}${c.x.race_no}R ${c.lane}号艇 ${c.name} ${pTxt}  ${mark}`)
      if (decision === 'buy') {
        // ★通知は買い目が出たら必ず鳴らす。
        //   2026-08-31に「校正後の確率35%以上」で絞ったが、これは完全な誤り。
        //   必要倍率の判定は「市場が低く見ている艇」を拾う仕組みなので、
        //   買いになるのは確率の低い高オッズ艇ばかり。実際その日の買い目2本
        //   （校正後6%と16%）が両方とも通知されなかった。
        //   絞るなら確率ではなく本数（余裕を上げる）で絞ること。
        {
        const unit = T.key === 'tansho' ? `単勝 ${o.toFixed(1)}倍（必要${need.toFixed(2)}倍）` : `複勝 ${o.toFixed(1)}倍以上（必要${need.toFixed(2)}倍）`
        notifyBuy(`${c.x.venue}${c.x.race_no}R 締切${c.dl}\n${c.lane}号艇 ${c.name}\n${unit}（確率${(c.p * 100).toFixed(0)}%）\n\n${T.label} 本日${bought(T.key)}本目${T.maxBuy >= 999 ? '' : `／上限${T.maxBuy}本`}`,
          `${T.label}の買い目`).then((s) => log(`  → 通知: ${s.join(' / ')}`))
        }
      }
    }
  }
  // ★pendingが無くなっても終了しない。画面の「予想」ボタンで候補が足される。
  //   その日の最終レースの締切を過ぎたら終わる。
  const last = db.prepare(`SELECT MAX(deadline) d FROM bets WHERE date=?`).get(DATE)?.d
  if (!anyPending && (!last || toMin(last) < nowMin() - 30)) { log('本日の全レースが終了しました'); break }
  // ★判定窓は締切2〜3分前しかない。近いときは速く回さないと窓を跨いでしまう。
  //   （12分前判定をやめた理由は strategy.mjs の CHECK_FROM を参照）
  beat()
  await sleep(!anyPending ? 180_000 : soonest <= 6 ? 15_000 : soonest <= 20 ? 60_000 : 120_000)
}

for (const r of db.prepare(`SELECT bet_type, decision, COUNT(*) n FROM bets WHERE date=? GROUP BY 1,2`).all(DATE))
  log(`本日 ${r.bet_type} ${r.decision}=${r.n}`)
db.close()
