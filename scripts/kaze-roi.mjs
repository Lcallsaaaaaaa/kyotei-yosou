// 風向きの条件で、買い方ごとの的中・回収がどう変わるかを測る。
//
//   node --max-old-space-size=4096 scripts/kaze-roi.mjs
//
// ★作り方（ここを守らないと必ず良く見える）
//   ① 前半のデータだけで「荒れる場×向き」「固まる場×向き」を決める
//   ② 後半で、その条件に当てはまるレースだけを買って測る
//   後から良い条件を探して全期間に当てはめると、必ず良い数字が出る。
//   実際、場24×向き17＝408通りを全期間で見ると「万舟率32.5%」のような
//   組み合わせが出るが、後半では17.1%に落ちた（2026-10-03）。
//
// ★使う風向きは締切前の値（before_race.wind_dir）
//   races.wind_dir はレース後のKファイルで、締切前とは向きで6割しか一致しない。
//
// ★買い方は確率順（オッズを使わない＝朝に確定する）
//   期待値順（確率×オッズ）は ev-test.mjs で測り、上限の時点で確率順に負けた。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const num = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? Number(argv[i + 1]) : d }
const SPEED = num('speed', 3)
const MIN = num('min', 60)        // 前半でこの本数以上あるセルだけ条件にする
const MAXR = 20                   // 何位まで見るか

const VEN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑',
  9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島',
  17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

// 払戻
const payT = new Map(), payF = new Map()
const racePay = new Map()   // レースごとの3連単の払戻（＝そのレースが荒れたかの指標）
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrentan'`).all())
  { payT.set(r.race_id + '|' + r.combo, r.amount); racePay.set(r.race_id, r.amount) }
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrenpuku'`).all())
  payF.set(r.race_id + '|' + r.combo.split('-').map(Number).sort((a, b) => a - b).join('='), r.amount)

// 風（締切前）
const wind = new Map()
for (const r of db.prepare(`SELECT b.race_id, r.jcd, b.wind_dir dir, b.wind_speed sp
  FROM before_race b JOIN races r ON r.race_id=b.race_id
  WHERE b.wind_dir IS NOT NULL AND b.wind_speed IS NOT NULL`).all())
  wind.set(r.race_id, r)

// モデルの確率（歩進検証）をレースごとに読む
const races = []
{
  const it = db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()
  let cur = null, buf = []
  const flush = () => {
    if (!cur || !buf.length) return
    const w = wind.get(cur)
    if (w && buf.some((x) => payT.has(cur + '|' + x[0]))) {
      const st = buf.slice().sort((a, b) => b[1] - a[1])
      const m = new Map()
      for (const [c, p] of buf) { const k = c.split('-').map(Number).sort((a, b) => a - b).join('='); m.set(k, (m.get(k) ?? 0) + p) }
      const sf = [...m].sort((a, b) => b[1] - a[1])
      const pre = (arr, pay, key) => { const o = [0]; for (let i = 0; i < MAXR; i++) o.push(o[i] + (pay.get(cur + '|' + (arr[i] ? key(arr[i]) : '')) ?? 0)); return o }
      races.push({ rid: cur, jcd: w.jcd, dir: w.dir, sp: w.sp,
        conf: sf.slice(0, 4).reduce((s, x) => s + x[1], 0),
        pay: racePay.get(cur) ?? 0,   // そのレースの3連単の払戻
        t: pre(st, payT, (x) => x[0]), f: pre(sf, payF, (x) => x[0]) })
    }
    buf = []
  }
  for (const r of it) { if (r.race_id !== cur) { flush(); cur = r.race_id } buf.push([r.combo, r.p]) }
  flush()
}
db.close()

const dates = [...new Set(races.map((r) => r.rid.slice(0, 8)))].sort()
// ★--thirds … 3分割で測る（2026-10-04）
//   2分割だと「①で条件を決め、②で買い方も選ぶ」ことになり、買い方を8通り
//   試したぶんだけ良い数字が出る。①条件 → ②買い方 → ③試す、まで分ければ塞げる。
//   2分割での最良は「固まる条件×上位25%×3連単6点 90.2%」だったが、
//   それは420レースで8通りの中から選んだ数字で、まだ信用できない。
const THIRDS = argv.includes('--thirds')
const CUT = THIRDS ? dates[Math.floor(dates.length / 3)] : dates[Math.floor(dates.length / 2)]
const CUT2 = dates[Math.floor(dates.length * 2 / 3)]
const first = races.filter((r) => r.rid.slice(0, 8) < CUT)
const second = races.filter((r) => r.rid.slice(0, 8) >= CUT && (!THIRDS || r.rid.slice(0, 8) < CUT2))
const third = races.filter((r) => r.rid.slice(0, 8) >= CUT2)
console.log(`${races.length.toLocaleString()}レース（前半 ${dates[0]}〜 ${first.length.toLocaleString()} ／ 後半 ${CUT}〜 ${second.length.toLocaleString()}）`)
console.log(`風速${SPEED}m以上を対象にする`)
console.log('')

// ---------- ① 前半だけで「荒れる／固まる」を決める ----------
//   基準は、その場の弱風(1m以下)での万舟率
// ⚠ 万舟率は**そのレースの払戻**で見る。買い目が当たったかではない（2026-10-03にここを間違えた）
const manOf = (set) => set.length ? set.filter((r) => r.pay >= 10000).length / set.length * 100 : null
const baseMan = new Map()
for (const jcd of Object.keys(VEN).map(Number)) {
  const s = first.filter((r) => r.jcd === jcd && r.sp <= 1)
  if (s.length >= 60) baseMan.set(jcd, manOf(s))
}
const rough = new Set(), calm = new Set()
for (const jcd of Object.keys(VEN).map(Number)) {
  const b = baseMan.get(jcd); if (b == null) continue
  for (let dir = 1; dir <= 17; dir++) {
    const s = first.filter((r) => r.jcd === jcd && r.dir === dir && r.sp >= SPEED)
    if (s.length < MIN) continue
    const m = manOf(s)
    if (m > b + 3) rough.add(jcd + '|' + dir)
    else if (m < b - 3) calm.add(jcd + '|' + dir)
  }
}
console.log(`前半で決めた条件：荒れる ${rough.size}通り ／ 固まる ${calm.size}通り`)
console.log('  荒れる:', [...rough].slice(0, 10).map((k) => VEN[k.split('|')[0]] + k.split('|')[1]).join(' ') + (rough.size > 10 ? ' …' : ''))
console.log('  固まる:', [...calm].slice(0, 10).map((k) => VEN[k.split('|')[0]] + k.split('|')[1]).join(' ') + (calm.size > 10 ? ' …' : ''))
console.log('')

// ---------- ② 後半で測る ----------
const plans = [
  ['3連複2点', 'f', 1, 2], ['3連複4点', 'f', 1, 4], ['3連複6点', 'f', 1, 6],
  ['3連単2点', 't', 1, 2], ['3連単4点', 't', 1, 4], ['3連単6点', 't', 1, 6],
  ['3連単 5〜10位', 't', 5, 10], ['3連単 8〜18位', 't', 8, 18],
]
const run = (set, key, a, b) => {
  const n = b - a + 1
  let hit = 0, ret = 0
  for (const r of set) { const g = r[key][b] - r[key][a - 1]; if (g > 0) hit++; ret += g }
  return { hit: hit / set.length * 100, roi: ret / (set.length * n * 100) * 100, n: set.length, pts: n }
}
const show = (title, set) => {
  if (set.length < 100) { console.log('■ ' + title + '（' + set.length + 'レース・少なすぎるので省略）'); return }
  console.log('■ ' + title + '（' + set.length.toLocaleString() + 'レース）')
  console.log('  買い方            投資    的中率    回収率')
  for (const [lbl, key, a, b] of plans) {
    const x = run(set, key, a, b)
    console.log('  ' + lbl.padEnd(16), (x.pts * 100 + '円').padStart(6),
      x.hit.toFixed(1).padStart(7) + '%', x.roi.toFixed(1).padStart(8) + '%')
  }
  console.log('')
}
const S = second.filter((r) => r.sp >= SPEED)
show('後半ぜんぶ（風速' + SPEED + 'm以上）', S)
show('前半で「荒れる」とした条件', S.filter((r) => rough.has(r.jcd + '|' + r.dir)))
show('前半で「固まる」とした条件', S.filter((r) => calm.has(r.jcd + '|' + r.dir)))
show('後半・弱風（1m以下）', second.filter((r) => r.sp <= 1))

// ---------- ③ 自信度の絞りと組み合わせる ----------
const top = (set) => set.slice().sort((a, b) => b.conf - a.conf).slice(0, Math.max(1, Math.round(set.length * 0.25)))
console.log('【自信度 上位25%で絞った場合】')
show('荒れる条件 × 上位25%', top(S.filter((r) => rough.has(r.jcd + '|' + r.dir))))
show('固まる条件 × 上位25%', top(S.filter((r) => calm.has(r.jcd + '|' + r.dir))))

// ---------- ④ 3分割の最終確認 ----------
// ①で条件を決め、②で買い方を選び、③で試す。③は一度も見ていないデータ。
if (THIRDS) {
  console.log('')
  console.log('================ 3分割の最終確認 ================')
  console.log(`① 条件決め ${dates[0]}〜 ／ ② 買い方決め ${CUT}〜 ／ ③ 試す ${CUT2}〜`)
  const S2 = second.filter((r) => r.sp >= SPEED)
  const S3 = third.filter((r) => r.sp >= SPEED)
  const sets = [['荒れる', rough], ['固まる', calm]]
  for (const [lbl, cond] of sets) {
    const a2 = top(S2.filter((r) => cond.has(r.jcd + '|' + r.dir)))
    const a3 = top(S3.filter((r) => cond.has(r.jcd + '|' + r.dir)))
    if (a2.length < 80 || a3.length < 80) { console.log(`■ ${lbl}条件 × 上位25%：②${a2.length}R ③${a3.length}R（少なすぎる）`); continue }
    // ②でいちばん良かった買い方を1つ選び、③で試す
    let best = null
    for (const [plan, key, a, b] of plans) {
      const x = run(a2, key, a, b)
      if (!best || x.roi > best.roi) best = { plan, key, a, b, roi: x.roi }
    }
    const v = run(a3, best.key, best.a, best.b)
    console.log(`■ ${lbl}条件 × 上位25%`)
    console.log(`  ②で選んだ買い方: ${best.plan}（②での回収 ${best.roi.toFixed(1)}%・${a2.length}レース）`)
    console.log(`  ③で試した結果  : 的中 ${v.hit.toFixed(1)}%／回収 ${v.roi.toFixed(1)}%（${a3.length}レース）`)
    console.log(`  → ${v.roi >= 100 ? '100%超え' : v.roi >= best.roi - 5 ? '②の水準を保った' : '②より落ちた＝偶然の山'}`)
  }
}
