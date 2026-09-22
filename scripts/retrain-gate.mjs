// 再学習の合否判定と入れ替え。retrain.sh から呼ぶ。
//
//   node scripts/retrain-gate.mjs --dates     最新の結果日・学習の終わり・補正の終わり
//   node scripts/retrain-gate.mjs --judge     新モデル(pred3_new)の合否。合格=終了コード0／不合格=3
//   node scripts/retrain-gate.mjs --adopt     入れ替え（前のモデルは *.prev.json と pred3_prev に退避）
//   node scripts/retrain-gate.mjs --discard   不合格の新モデルを捨てる
//   node scripts/retrain-gate.mjs --history   これまでの再学習の記録
//
// ★なぜ「合格したときだけ入れ替える」のか
//   学習が壊れても（データの欠け・特徴量の不具合など）エラーにならず、おかしな確率を出す
//   モデルができることがある。それを毎朝の予想に黙って使わないため。
//
// ★判定のしかた（2026-09-14に決めた）
//   新モデルは直近28日を学習に使わず「補正」として残す。そのレースで次を見る。
//   1) 最低ライン（壊れていないか）
//        1着的中 54%以上 ／ 1着logloss 1.25以下 ／ 無料枠 1日8〜35本・較正ずれ−10pt以内
//        配信 1日8〜35R・3連複4点 70%以上
//      参考：2026-09-14時点の実力は 1着的中56.5% ／ logloss 1.20 ／ 無料枠17.8本・−3.0pt ／
//            配信18.7R・3連複80.6%
//   2) 前のモデルとの直接比較（重なるレースが7日以上あるとき）
//        同じレースで 1着logloss が前より悪くない（+0.002まで）／ 1着的中が1pt以上落ちない
//      前のモデルの pred3 は、そのレースを学習に使っていないので公平に比べられる。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// ⚠ import.meta.url は日本語パスを%エンコードするので fileURLToPath を通すこと
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const HOLD_DAYS = 28

db.exec(`CREATE TABLE IF NOT EXISTS model_history (
  run_at TEXT PRIMARY KEY, latest TEXT, train_to TEXT, verdict TEXT, adopted INTEGER DEFAULT 0, detail TEXT)`)

// 日付は 'YYYY-MM-DD' の文字列同士で扱う。UTCの0時として足し引きするので時差の影響を受けない。
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const has = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)

function dates() {
  const L = db.prepare(`SELECT MAX(r.date) d FROM races r JOIN entries e ON e.race_id = r.race_id AND e.rank_num = 1`).get().d
  return { L, from: addDays(L, -(HOLD_DAYS - 1)), to: addDays(L, 1) }
}

if (argv.includes('--dates')) {
  const d = dates()
  console.log(`${d.L} ${d.from} ${d.to}`)
  process.exit(0)
}

if (argv.includes('--history')) {
  for (const r of db.prepare(`SELECT * FROM model_history ORDER BY run_at DESC LIMIT 30`).all()) {
    const x = JSON.parse(r.detail ?? '{}').ch ?? {}
    console.log(`${r.run_at.slice(0, 16).replace('T', ' ')}(UTC)  結果〜${r.latest}  学習〜${r.train_to}  ${r.verdict}` +
      `${r.adopted ? '（入れ替え済み）' : ''}  1着${((x.top1 ?? 0) * 100).toFixed(2)}% logloss${(x.ll1 ?? 0).toFixed(4)}`)
  }
  process.exit(0)
}

if (argv.includes('--discard')) {
  db.exec('DROP TABLE IF EXISTS pred3_new')
  console.log('pred3_new を捨てた')
  process.exit(0)
}

if (argv.includes('--judge')) {
  if (!has('pred3_new')) { console.log('pred3_new が無い（学習に失敗している）'); process.exit(3) }
  const { L, from } = dates()
  const RK = new Map(), DT = new Map()
  for (const r of db.prepare(`SELECT e.race_id, e.lane, e.rank_num, r.date FROM entries e JOIN races r ON r.race_id = e.race_id
     WHERE r.date >= ? AND e.rank_num BETWEEN 1 AND 3`).iterate(from)) {
    let a = RK.get(r.race_id); if (!a) { a = {}; RK.set(r.race_id, a); DT.set(r.race_id, r.date) }
    a[r.rank_num] = r.lane
  }
  const PAY = new Map()
  for (const r of db.prepare(`SELECT p.race_id, p.combo, p.amount FROM payouts p JOIN races r ON r.race_id = p.race_id
     WHERE r.date >= ? AND p.bet_type = 'tansho' AND p.amount IS NOT NULL`).iterate(from))
    PAY.set(r.race_id + '|' + r.combo, r.amount)

  // 3連単120点から、1着確率（艇ごと）と3連複（順不同）を作る
  const load = (tbl, cond) => {
    const M = new Map()
    let cur = null, w = null, t = null
    const flush = () => { if (cur) M.set(cur, { w, t }) }
    for (const r of db.prepare(`SELECT p.race_id, p.combo, p.p FROM ${tbl} p JOIN races r ON r.race_id = p.race_id
       WHERE r.date >= ? ${cond} ORDER BY p.race_id`).iterate(from)) {
      if (r.race_id !== cur) { flush(); cur = r.race_id; w = new Map(); t = new Map() }
      const ls = r.combo.split('-').map(Number)
      w.set(ls[0], (w.get(ls[0]) ?? 0) + r.p)
      const k = [...ls].sort((a, b) => a - b).join('-')
      t.set(k, (t.get(k) ?? 0) + r.p)
    }
    flush()
    return M
  }
  const CH = load('pred3_new', `AND p.split = 'calib'`)
  const CP = has('pred3') ? load('pred3', '') : new Map()

  const stat = (M, ids) => {
    let n = 0, top = 0, ll = 0, tn = 0, tp = 0, th = 0, tr = 0, hn = 0, hf = 0
    const ds = new Set()
    for (const id of ids) {
      const m = M.get(id), rk = RK.get(id)
      if (!m || !rk || rk[3] == null) continue
      n++; ds.add(DT.get(id))
      const b = [...m.w].sort((x, y) => y[1] - x[1])[0]
      if (b[0] === rk[1]) top++
      ll += -Math.log(Math.max(m.w.get(rk[1]) ?? 1e-12, 1e-12))
      if (b[1] >= 0.80) { tn++; tp += b[1]; if (b[0] === rk[1]) { th++; tr += PAY.get(id + '|' + b[0]) ?? 0 } }
      const t4 = [...m.t].sort((x, y) => y[1] - x[1]).slice(0, 4)
      if (t4.reduce((s, x) => s + x[1], 0) >= 0.7645) {
        hn++
        const tf = [rk[1], rk[2], rk[3]].sort((x, y) => x - y).join('-')
        if (t4.some((x) => x[0] === tf)) hf++
      }
    }
    const days = ds.size
    return { n, days, top1: n ? top / n : 0, ll1: n ? ll / n : 99,
      tn, tPerDay: days ? tn / days : 0, tGap: tn ? th / tn - tp / tn : 0, tRoi: tn ? tr / tn : 0,
      hn, hPerDay: days ? hn / days : 0, hFuku: hn ? hf / hn : 0 }
  }

  const holdIds = [...CH.keys()]
  const ch = stat(CH, holdIds)
  const both = holdIds.filter((id) => CP.has(id))
  const chB = stat(CH, both), cpB = stat(CP, both)

  const checks = [
    ['1着的中 54%以上', ch.top1 >= 0.54, (ch.top1 * 100).toFixed(2) + '%'],
    ['1着logloss 1.25以下', ch.ll1 <= 1.25, ch.ll1.toFixed(4)],
    ['無料枠 1日8〜35本', ch.tPerDay >= 8 && ch.tPerDay <= 35, ch.tPerDay.toFixed(1) + '本'],
    ['無料枠 較正ずれ −10pt以内', ch.tn < 50 || ch.tGap >= -0.10, (ch.tGap * 100).toFixed(1) + 'pt'],
    ['配信 1日8〜35R', ch.hPerDay >= 8 && ch.hPerDay <= 35, ch.hPerDay.toFixed(1) + 'R'],
    ['配信 3連複4点 70%以上', ch.hn < 50 || ch.hFuku >= 0.70, (ch.hFuku * 100).toFixed(1) + '%'],
  ]
  const h2h = cpB.days >= 7 ? [
    ['1着logloss が前のモデルより悪くない（+0.002まで）', chB.ll1 <= cpB.ll1 + 0.002, `新${chB.ll1.toFixed(4)} ／ 前${cpB.ll1.toFixed(4)}`],
    ['1着的中が前のモデルから1pt以上落ちない', chB.top1 >= cpB.top1 - 0.01, `新${(chB.top1 * 100).toFixed(2)}% ／ 前${(cpB.top1 * 100).toFixed(2)}%`],
  ] : null

  console.log(`■ 判定に使うレース：新モデルが学習に使っていない直近 ${ch.days}日 ${ch.n}レース（${from}〜${L}）`)
  console.log(`  参考　無料枠 回収${ch.tRoi.toFixed(1)}%（${ch.tn}本）／ 配信 3連複4点${(ch.hFuku * 100).toFixed(1)}%（${ch.hn}R）`)
  for (const [nm, ok, v] of checks) console.log(`  ${ok ? '合格  ' : '不合格'}  ${nm}  ${v}`)
  if (h2h) {
    console.log(`■ 前のモデルと同じレースで比較（${cpB.days}日 ${cpB.n}レース）`)
    for (const [nm, ok, v] of h2h) console.log(`  ${ok ? '合格  ' : '不合格'}  ${nm}  ${v}`)
  } else {
    console.log(`■ 前のモデルと重なるレースが${cpB.days}日しかないので直接比較は省略（最低ラインだけで判定）`)
  }
  const pass = checks.every((c) => c[1]) && (!h2h || h2h.every((c) => c[1]))
  const detail = JSON.stringify({ ch, chB: h2h ? chB : null, cpB: h2h ? cpB : null })
  db.prepare(`INSERT OR REPLACE INTO model_history (run_at, latest, train_to, verdict, adopted, detail) VALUES (?,?,?,?,0,?)`)
    .run(new Date().toISOString(), L, from, pass ? '合格' : '不合格', detail)
  writeFileSync(join(ROOT, 'data', 'retrain-last.json'), detail)
  console.log(pass ? '→ 合格：入れ替える' : '→ 不合格：今のモデルのまま')
  process.exit(pass ? 0 : 3)
}

if (argv.includes('--adopt')) {
  const D = join(ROOT, 'data')
  const swap = (cur, nu, prev) => {
    if (!existsSync(join(D, nu))) return false
    if (existsSync(join(D, prev))) rmSync(join(D, prev))
    if (existsSync(join(D, cur))) renameSync(join(D, cur), join(D, prev))
    renameSync(join(D, nu), join(D, cur))
    return true
  }
  if (!has('pred3_new') || !existsSync(join(D, 'model5.new.json'))) {
    console.log('新モデル（model5.new.json と pred3_new）が揃っていないので入れ替えない')
    process.exit(1)
  }
  const m = swap('model5.json', 'model5.new.json', 'model5.prev.json')
  const f = swap('model5-full.json', 'model5-full.new.json', 'model5-full.prev.json')
  // ⚠ pred3 は閾値（無料枠0.80・配信0.7645）を出す元。モデルと必ず一緒に入れ替える。
  db.exec('BEGIN')
  db.exec('DROP TABLE IF EXISTS pred3_prev')
  if (has('pred3')) db.exec('ALTER TABLE pred3 RENAME TO pred3_prev')
  db.exec('ALTER TABLE pred3_new RENAME TO pred3')
  // 索引は名前ごとテーブルについて回るので、名前を付け直す
  db.exec('DROP INDEX IF EXISTS idx_pred3_split')
  db.exec('DROP INDEX IF EXISTS idx_pred3_new_split')
  db.exec('DROP INDEX IF EXISTS idx_pred3_prev_split')
  db.exec('CREATE INDEX idx_pred3_split ON pred3(split)')
  if (has('pred3_prev')) db.exec('CREATE INDEX idx_pred3_prev_split ON pred3_prev(split)')
  db.exec('COMMIT')
  db.prepare(`UPDATE model_history SET adopted = 1 WHERE run_at = (SELECT MAX(run_at) FROM model_history)`).run()
  console.log(`入れ替えた：朝モデル ${m ? '新' : '前のまま'} ／ フルモデル ${f ? '新' : '前のまま'}` +
    `（前のモデルは data/model5.prev.json・model5-full.prev.json・pred3_prev に退避）`)
  process.exit(0)
}

console.log('使い方: --dates / --judge / --adopt / --discard / --history')
