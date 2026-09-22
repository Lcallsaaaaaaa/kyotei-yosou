// 3連単・3連複の確定オッズを集める。
//
//   node scripts/odds3.mjs --from 2025-11-01 --to 2026-08-27
//   node scripts/odds3.mjs --stats
//   node scripts/odds3.mjs --verify        払戻と突き合わせて正しいか確かめる
//
// ★なぜ要るか
//   単勝は「必要倍率＝(1÷確率)×余裕」で判定でき、回収148%が出ている。
//   3連単・3連複は**オッズを持っていない**ので、確率の高い順に買うしかなく回収80〜86%止まり。
//   単勝オッズからHarville方式で推定してみたが、中央で33%ずれて使い物にならなかった
//   （期待値で選ぶと回収61〜77%まで悪化）。実オッズを取るしかない。
//
// ★ページの並び（実測）
//   3連単 odds3t … 列が1着(1〜6)、行が2着×3着。文書順は「行ごとに6列ぶん」。
//     1着aの列では、2着は残り5艇を昇順、その各々で3着が残り4艇を昇順。
//   3連複 odds3f … 20通り。**2026-08-28にページの並びが変わった**（3連単と同じ格子形式へ）。
//     新: 行が「2つ目と3つ目の数字の組」、列が「1つ目の数字」。文書順は行ごとに左から。
//     旧: 単純な昇順（1-2-3, 1-2-4, …）。8/27までに取った分はこの並びで正しい。
//     気づいたきっかけ: 当たり目のオッズ×100が払戻と合う率が 98% → 59% に落ちた（9月）。
//     3連単は変わっていない（全期間98%）。取り直しは `--refetch3f --fetched-since 2026-08-28`。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const DELAY = Number(flag('delay', 220))
const CONC = Number(flag('conc', 3))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

db.exec(`
  CREATE TABLE IF NOT EXISTS odds3t (race_id TEXT NOT NULL, combo TEXT NOT NULL, odds REAL,
    PRIMARY KEY (race_id, combo));
  CREATE TABLE IF NOT EXISTS odds3f (race_id TEXT NOT NULL, combo TEXT NOT NULL, odds REAL,
    PRIMARY KEY (race_id, combo));
  CREATE TABLE IF NOT EXISTS odds3_fetch (race_id TEXT PRIMARY KEY, fetched TEXT, status TEXT);
`)

/** 3連単120通りを、ページの文書順に並べる */
const ORDER3T = (() => {
  const cols = []
  for (let a = 1; a <= 6; a++) {
    const rest = [1, 2, 3, 4, 5, 6].filter((x) => x !== a)
    const col = []
    for (const b of rest) for (const c of rest) if (c !== b) col.push(`${a}-${b}-${c}`)
    cols.push(col)   // 20通り
  }
  // 文書順は「行ごとに6列」
  const out = []
  for (let r = 0; r < 20; r++) for (let c = 0; c < 6; c++) out.push(cols[c][r])
  return out
})()
/** 3連複20通りを、ページの文書順に並べる（2026-08-28以降の並び） */
const ORDER3F = (() => {
  const out = []
  for (let b = 2; b <= 6; b++) for (let c = b + 1; c <= 6; c++) for (let a = 1; a < b; a++) out.push(`${a}-${b}-${c}`)
  return out
})()

if (argv.includes('--stats')) {
  const t = db.prepare(`SELECT COUNT(DISTINCT race_id) c FROM odds3t`).get().c
  const f = db.prepare(`SELECT COUNT(DISTINCT race_id) c FROM odds3f`).get().c
  const all = db.prepare(`SELECT COUNT(*) c FROM races`).get().c
  console.log(`3連単 ${t.toLocaleString()} / ${all.toLocaleString()} レース`)
  console.log(`3連複 ${f.toLocaleString()} / ${all.toLocaleString()} レース`)
  const r = db.prepare(`SELECT MIN(r.date) a, MAX(r.date) b FROM odds3_fetch o JOIN races r ON r.race_id=o.race_id WHERE o.status='ok'`).get()
  console.log(`期間 ${r?.a ?? '-'} 〜 ${r?.b ?? '-'}`)
  db.close(); process.exit(0)
}

if (argv.includes('--verify')) {
  // 勝った組み合わせのオッズ×100が払戻と一致するか。
  // ★2026-09-16: 3連複のページの並びが8/28に変わっていて、9月ぶんが59%まで落ちていた。
  //   毎日 --verify --since で直近を見ておけば、同じことが黙って起きても翌日に分かる。
  const SINCE = flag('since', '0000-00-00')
  let bad = 0
  for (const [T, kind, nm] of [['odds3t', 'sanrentan', '3連単'], ['odds3f', 'sanrenpuku', '3連複']]) {
    let n = 0, ok = 0
    const ex = []
    for (const r of db.prepare(`
      SELECT o.race_id, o.combo, o.odds, p.amount
      FROM ${T} o JOIN payouts p ON p.race_id=o.race_id AND p.bet_type='${kind}' AND p.combo=o.combo
      JOIN races rc ON rc.race_id=o.race_id
      WHERE o.odds IS NOT NULL AND p.amount IS NOT NULL AND rc.date >= ?`).iterate(SINCE)) {
      n++
      if (Math.abs(r.odds * 100 - r.amount) / r.amount < 0.02) ok++
      else if (ex.length < 5) ex.push(r)
    }
    if (!n) { console.log(`${nm}: データなし`); continue }
    console.log(`${nm}  突き合わせ ${n.toLocaleString()}件　一致 ${(ok / n * 100).toFixed(2)}%`)
    if (ok / n < 0.9) {
      bad++
      console.log('  ずれている例:')
      for (const r of ex) console.log(`    ${r.race_id} ${r.combo} オッズ${r.odds} → 払戻${r.amount}円`)
      console.log(`  ⚠ ${nm}のオッズが払戻と合っていない。ページの並びが変わった疑い。`)
      console.log(`    直し方: 並び(ORDER3T/ORDER3F)を確かめ直してから --refetch3f --fetched-since <日付>`)
    }
  }
  db.close(); process.exit(bad ? 1 : 0)
}

const REFETCH_SINCE = flag('fetched-since')
const REFETCH = argv.includes('--refetch3f')
if (REFETCH && !REFETCH_SINCE) { console.error('--refetch3f には --fetched-since 日付 が必要'); process.exit(1) }
const from = flag('from'), to = flag('to')
if (!REFETCH && (!from || !to)) { console.error('--from --to が必要'); process.exit(1) }
const targets = REFETCH ? db.prepare(`
  SELECT r.race_id, r.jcd, r.race_no, r.date FROM races r JOIN odds3_fetch f ON f.race_id=r.race_id
  WHERE f.status='ok' AND f.fetched >= ? ORDER BY r.date, r.jcd, r.race_no`).all(REFETCH_SINCE) : db.prepare(`
  SELECT r.race_id, r.jcd, r.race_no, r.date FROM races r
  WHERE r.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM odds3_fetch f WHERE f.race_id=r.race_id AND f.status IN ('ok','empty'))
  ORDER BY r.date DESC, r.jcd, r.race_no`).all(from, to)
console.log(REFETCH ? `=== 3連複オッズの取り直し（${REFETCH_SINCE} 以降に取ったぶん）===`
  : `=== 3連単・3連複オッズの収集 ${from} 〜 ${to} ===`)
console.log(`対象 ${targets.length.toLocaleString()} レース　1レース${REFETCH ? 1 : 2}ページ　推定 ${(targets.length * (REFETCH ? 1 : 2) * DELAY / 3600000 / CONC).toFixed(1)}時間\n`)

const parse = (h) => [...h.matchAll(/<td class="oddsPoint[^"]*">([^<]*)<\/td>/g)].map((m) => {
  const s = m[1].trim()
  const v = Number(s)
  return Number.isFinite(v) && v > 0 ? v : null
})
const url = (kind, t) => `https://www.boatrace.jp/owpc/pc/race/${kind}?rno=${t.race_no}&jcd=${String(t.jcd).padStart(2, '0')}&hd=${t.date.replace(/-/g, '')}`
async function get(kind, t, want) {
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url(kind, t), { signal: AbortSignal.timeout(25_000) })
      if (!res.ok) throw new Error(String(res.status))
      const v = parse(await res.text())
      return v.length === want ? v : null
    } catch { if (a === 3) return undefined; await sleep(DELAY * a * 3) }
  }
}
const insT = db.prepare(`INSERT OR REPLACE INTO odds3t VALUES (?,?,?)`)
const insF = db.prepare(`INSERT OR REPLACE INTO odds3f VALUES (?,?,?)`)
const insR = db.prepare(`INSERT OR REPLACE INTO odds3_fetch VALUES (?,?,?)`)

let ok = 0, empty = 0, err = 0
const stamp = new Date().toISOString()
const t0 = Date.now()
const buf = []
for (let i = 0; i < targets.length; i += CONC) {
  const batch = targets.slice(i, i + CONC)
  const got = await Promise.all(batch.map(async (t) => {
    const [a, b] = REFETCH ? [null, await get('odds3f', t, 20)]
      : await Promise.all([get('odds3t', t, 120), get('odds3f', t, 20)])
    return { t, a, b }
  }))
  for (const g of got) buf.push(g)
  if (buf.length >= 30 || i + CONC >= targets.length) {
    // ★ロックで落ちないよう、待って何度でもやり直す（直前情報の収集で一度落ちた）
    for (let a = 1; ; a++) {
      try {
        db.exec('BEGIN IMMEDIATE')
        for (const g of buf) {
          if (REFETCH) {
            // 取り直しでは 3連複だけ上書きし、odds3_fetch の記録は触らない
            // （取れなかったレースは次に流したときまた対象になる）
            if (!g.b) { err++; continue }
            ORDER3F.forEach((c, k) => { if (g.b[k] != null) insF.run(g.t.race_id, c, g.b[k]) })
            ok++; continue
          }
          if (g.a === undefined && g.b === undefined) { insR.run(g.t.race_id, stamp, 'error'); err++; continue }
          if (!g.a && !g.b) { insR.run(g.t.race_id, stamp, 'empty'); empty++; continue }
          if (g.a) ORDER3T.forEach((c, k) => { if (g.a[k] != null) insT.run(g.t.race_id, c, g.a[k]) })
          if (g.b) ORDER3F.forEach((c, k) => { if (g.b[k] != null) insF.run(g.t.race_id, c, g.b[k]) })
          insR.run(g.t.race_id, stamp, 'ok'); ok++
        }
        db.exec('COMMIT'); break
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        if (a % 10 === 1) console.log(`  書き込み待ち ${a}回目（${e.message}）`)
        await sleep(Math.min(30_000, 2000 * a))
      }
    }
    buf.length = 0
  }
  const done = i + batch.length
  if (done % 300 < CONC || done >= targets.length) {
    const per = (Date.now() - t0) / done
    console.log(`[${(done / targets.length * 100).toFixed(1)}%] ${done}/${targets.length}  ok${ok} 空${empty} 失敗${err}  ${(per / 1000).toFixed(2)}秒/件  残り約${((targets.length - done) * per / 3600000).toFixed(1)}時間`)
  }
  await sleep(DELAY)
}
console.log(`\n完了: ok ${ok} / 空 ${empty} / 失敗 ${err}`)
db.close()
