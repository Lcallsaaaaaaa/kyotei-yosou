// 舟券の条件の「回収率」を名乗るときは、必ずここを通す。
//
//   import { claim, report } from './claim.mjs'
//   report(claim(db, { margin: 1.3 }))
//   node scripts/claim.mjs --margin 1.3 --minp 0
//
// ★なぜこれがあるか（2026-08-31）
//   確定オッズで出した回収率を、そのまま運用の根拠にする誤りを**3回**やった。
//     1回目 「オッズ2.5〜3.5倍で146%」→ 締切前では64.2%
//     2回目 「単勝 余裕1.3・全6艇・校正ありで172.7%」→ 締切前では87.1%
//     3回目 配信の絞りを市場の確定オッズで決めた（朝には取れない情報だった）
//   2回目は、2026-08-23に「単勝の条件は実行不能」と一度結論していたのに、
//   判定を作り直したあと確定オッズの数字で運用に載せた。
//   「気をつける」では止まらなかったので、**片方だけの数字を出せない作り**にする。
//
// ★この関数は必ず2つ返す
//   executable … 締切前オッズ（健全な記録だけ）で判定。**これだけが実際にできること**
//   reference  … 確定オッズで判定。測るときの上限であって、運用の根拠にはならない
//   片方だけを取り出して表に載せないこと。report() は必ず両方出す。
//
// ★足りないときは「言えない」と返す
//   標本が薄いのに数字を出すと、それがまた根拠として一人歩きする。
//   締切前オッズのある日数・本数がしきい値を割ったら verdict='まだ言えない' になる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { loadCalib, calibrate } from './calib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** これを下回るあいだは結論を出さない */
export const MIN_DAYS = 30
export const MIN_BETS = 1000

/**
 * 読み込みは重い（odds_tan 120万行など）ので、条件を変えて何度も測るときは
 * これを1回だけ呼んで ctx を使い回す。
 */
export function load(db, calTable = 'wi1', kind = 'tansho') {
  const FUKU = kind === 'fukusho'
  // ★複勝は「下限オッズ」で判定する。実際の払戻は下限〜上限のどこかで、
  //   どの艇が一緒に来たかで決まる。下限で判定すれば辛め＝安全側に倒れる。
  const oc = FUKU ? 'fukusho_lo' : 'tansho'
  const FIN = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, ${oc} o FROM odds_tan WHERE ${oc} > 0`).iterate())
    FIN.set(r.race_id + '|' + r.lane, r.o)
  const PAY = new Map()
  for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts
      WHERE bet_type=? AND amount IS NOT NULL`).iterate(kind))
    PAY.set(r.race_id + '|' + r.combo, r.amount)
  // ★複勝の当たりは2着以内。1着だけで判定すると的中を半分に見誤る。
  const WIN = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, rank_num FROM entries
      WHERE rank_num BETWEEN 1 AND ${FUKU ? 2 : 1}`).iterate()) {
    let a = WIN.get(r.race_id); if (!a) { a = new Set(); WIN.set(r.race_id, a) }
    a.add(r.lane)
  }
  // ★健全な締切前オッズだけ。ok=1 は odds-live.mjs の snapshotOk が付ける印。
  //   これを外すと壊れた板（6艇そろわない・同値・1.0倍張り付き）が混ざる。実際に混ざった。
  const LIVE = new Map()
  for (const r of db.prepare(`SELECT race_id, lane, ${oc} o, mins_before FROM odds_live
      WHERE ok = 1 AND ${oc} > 0 ORDER BY mins_before DESC`).iterate())
    LIVE.set(r.race_id + '|' + r.lane, r.o)     // 締切に近いほうで上書き
  const CAL = loadCalib(db, calTable)

  const rows = []
  for (const f of readdirSync(join(ROOT, 'data')).filter((x) => /^predict-\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    const j = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'))
    for (const r of (j.races ?? [])) {
      const win = WIN.get(r.race_id); if (!win || !win.size) continue
      // ★確率の出どころを券種で変える。単勝=1着の確率(first)、複勝=2着以内の確率(top2)。
      //   ここを取り違えると必要倍率が丸ごとずれる。
      for (const b of ((FUKU ? r.top2 : r.first) ?? [])) {
        const k = r.race_id + '|' + b.lane
        const fin = FIN.get(k), lv = LIVE.get(k)
        if (!(fin > 0) || !(lv > 0)) continue
        rows.push({ id: r.race_id, lane: b.lane, p: b.p, fin, live: lv,
          y: win.has(b.lane) ? 1 : 0, day: r.race_id.slice(0, 8) })
      }
    }
  }
  return { rows, PAY, CAL, kind }
}

/**
 * @param ctx load() の戻り値（または開いた DatabaseSync を渡せばここで読む）
 * @param opt { margin, minp, maxOdds }
 * @returns { executable, reference, verdict, why }
 */
export function claim(ctx, opt = {}) {
  if (!ctx.rows) ctx = load(ctx, opt.calTable ?? 'wi1', opt.kind ?? 'tansho')
  const { rows, PAY, CAL, kind } = ctx
  // ★校正表(wi1)は「1着の確率 × 単勝オッズ」で作ってある。
  //   複勝の2着以内の確率に当てると意味がずれるので、複勝では校正しない。
  //   複勝用の校正表を作るのは別の作業。
  const cal = kind === 'fukusho' ? (c, p) => p : calibrate
  const margin = opt.margin ?? 1.3
  const minp = opt.minp ?? 0
  // ★オッズの上限。高オッズほど締切前の表示が当てにならない（20〜50倍で確定0.688倍）。
  //   当たる側に寄せたいときはここを絞る。
  const maxOdds = opt.maxOdds ?? Infinity
  const run = (useLive) => {
    let n = 0, hit = 0, ret = 0
    const rr = [], per = new Map(), gains = []
    for (const r of rows) {
      const o = useLive ? r.live : r.fin
      const p = cal(CAL, r.p, o)
      if (p < minp || o > maxOdds || o < (1 / p) * margin) continue
      n++; rr.push(r.fin / r.live)
      const g = r.y === 1 ? (PAY.get(r.id + '|' + r.lane) ?? r.fin * 100) : 0
      if (r.y === 1) { hit++; gains.push(g) }
      ret += g
      let a = per.get(r.day); if (!a) { a = { n: 0, g: 0 }; per.set(r.day, a) }
      a.n++; a.g += g
    }
    rr.sort((a, b) => a - b)
    gains.sort((a, b) => b - a)
    // ★いちばん大きい払戻を1本抜いたときの回収率。
    //   複勝で「回収286%」と出た条件が、実は68本中1本の12,900円だけだった（2026-08-31）。
    //   一発で作られた数字を「優位」と読まないための歯止め。
    const roi = n ? ret / (n * 100) * 100 : 0
    const roiX1 = n > 1 && gains.length ? (ret - gains[0]) / ((n - 1) * 100) * 100 : roi
    return { bets: n, hits: hit, hitRate: n ? hit / n * 100 : 0, roi, roiX1,
      topShare: ret > 0 && gains.length ? gains[0] / ret * 100 : 0,
      pl: ret - n * 100, days: per.size, posDays: [...per.values()].filter((a) => a.g > a.n * 100).length,
      drift: rr.length ? rr[Math.floor(rr.length / 2)] : null }
  }
  const executable = run(true), reference = run(false)
  const days = new Set(rows.map((r) => r.day)).size
  let verdict = 'まだ言えない', why = ''
  if (days < MIN_DAYS) why = `健全な締切前オッズが ${days}日ぶんしかない（${MIN_DAYS}日必要）`
  else if (executable.bets < MIN_BETS) why = `買い目が ${executable.bets}本しかない（${MIN_BETS}本必要）`
  else { verdict = executable.roi >= 100 ? 'プラス' : 'マイナス'; why = `${days}日 / ${executable.bets}本で判定` }
  return { executable, reference, verdict, why, days, candidates: rows.length, margin, minp, maxOdds }
}

/** 条件を並べて比べる。読み込みは1回だけ。 */
export function sweep(db, list, kind = 'tansho') {
  const ctx = load(db, 'wi1', kind)
  console.log(`【${kind === 'fukusho' ? '複勝（2着以内）' : '単勝'}】候補 ${ctx.rows.length.toLocaleString()}本 / ${new Set(ctx.rows.map((r) => r.day)).size}日`)
  console.log('※ 左が実際にできること。右の確定オッズは参考で、単独では引用しない。\n')
  console.log('  条件                    ┃ 締切前オッズ（実行できる）                     ┃ 確定(参考)')
  console.log('                          ┃  本数  1日  的中率  回収率 最大1本抜 最大の比 ﾌﾟﾗｽの日 ｽﾞﾚ┃  回収率')
  for (const o of list) {
    const c = claim(ctx, o)
    const e = c.executable, f = c.reference
    const nm = `確率${(o.minp * 100).toFixed(0)}%以上` + (o.maxOdds && o.maxOdds < 999 ? ` オッズ${o.maxOdds}倍以下` : '') +
      (o.margin !== 1.3 ? ` 余裕${o.margin}` : '')
    console.log(`  ${nm.padEnd(23)} ┃${String(e.bets).padStart(6)}${(e.bets / Math.max(c.days, 1)).toFixed(1).padStart(6)}` +
      `${e.hitRate.toFixed(1).padStart(7)}%${e.roi.toFixed(1).padStart(7)}%${e.roiX1.toFixed(1).padStart(9)}%` +
      `${e.topShare.toFixed(0).padStart(8)}% ${String(e.posDays + '/' + e.days).padStart(6)}` +
      `${e.drift == null ? '    -' : e.drift.toFixed(2).padStart(5)}┃${f.roi.toFixed(1).padStart(8)}%`)
  }
  console.log('\n  最大1本抜 = いちばん大きい払戻を1本抜いたときの回収率。ここが100%を割るなら一発で作られた数字。')
  console.log('  最大の比  = 払戻の総額に占める、いちばん大きい1本の割合。')
  console.log('  ｽﾞﾚ      = 買うと決めた分の「確定÷締切前」の中央値。1.0に近いほど締切前の表示が当てになる。')
  console.log(`  ⚠ ${new Set(ctx.rows.map((r) => r.day)).size}日ぶんしかない。${MIN_DAYS}日/${MIN_BETS}本に届くまでは結論にしない。`)
}

export function report(c) {
  const f = (a, nm) => `  ${nm.padEnd(30)} ${String(a.bets).padStart(6)}本 ` +
    `的中${a.hitRate.toFixed(2).padStart(6)}% 回収${a.roi.toFixed(1).padStart(7)}% ` +
    `損益${((a.pl > 0 ? '+' : '') + a.pl.toLocaleString()).padStart(9)} プラスの日 ${a.posDays}/${a.days}`
  console.log(`余裕${c.margin} / 確率の足切り${(c.minp * 100).toFixed(0)}%　候補${c.candidates.toLocaleString()}本 / ${c.days}日\n`)
  console.log(f(c.executable, '締切前オッズ（実際にできること）'))
  console.log(f(c.reference, '確定オッズ（参考・実行不能）'))
  const e = c.executable
  console.log(`\n  いちばん大きい払戻を1本抜くと 回収${e.roiX1.toFixed(1)}%（その1本が払戻の${e.topShare.toFixed(0)}%）` +
    (e.roiX1 < 100 && e.roi >= 100 ? '　← 一発で作られた数字。優位ではない' : ''))
  if (c.executable.drift != null)
    console.log(`\n  買うと決めた分の 確定÷締切前 の中央値 ${c.executable.drift.toFixed(3)}` +
      `${c.executable.drift < 0.9 ? '　← 1を大きく割る＝高く出ている艇を選んで、締切までに落ちている' : ''}`)
  console.log(`\n  判定: ${c.verdict}（${c.why}）`)
  if (c.verdict === 'まだ言えない')
    console.log('  ⚠ この数字を運用の根拠にしないこと。とくに「確定オッズ」の行を単独で引用しないこと。')
}

// ⚠ import.meta.url は日本語パスを%エンコードするので、文字列を組み立てて比べると一致しない。
//   pathToFileURL を通すこと（これで一度、何も出力されずに黙って終わった）。
const { pathToFileURL } = await import('node:url')
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? Number(argv[i + 1]) : d }
  const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
  db.exec('PRAGMA busy_timeout = 300000')
  const KIND = argv.includes('--fuku') ? 'fukusho' : 'tansho'
  if (argv.includes('--sweep')) {
    // 「当たる側に寄せる」方向を並べて比べる
    sweep(db, [
      { minp: 0, margin: 1.3 },
      { minp: 0.20, margin: 1.3 }, { minp: 0.30, margin: 1.3 },
      { minp: 0.40, margin: 1.3 }, { minp: 0.50, margin: 1.3 }, { minp: 0.60, margin: 1.3 },
      { minp: 0, margin: 1.3, maxOdds: 3 }, { minp: 0, margin: 1.3, maxOdds: 5 },
      { minp: 0, margin: 1.3, maxOdds: 8 },
      { minp: 0.30, margin: 1.3, maxOdds: 5 }, { minp: 0.40, margin: 1.3, maxOdds: 5 },
      { minp: 0.30, margin: 1.0, maxOdds: 5 }, { minp: 0.40, margin: 1.0, maxOdds: 5 },
      { minp: 0.50, margin: 1.0, maxOdds: 5 },
    ], KIND)
  } else {
    report(claim(db, { margin: flag('margin', 1.3), minp: flag('minp', 0), maxOdds: flag('maxodds', Infinity), kind: KIND }))
  }
  db.close()
}
