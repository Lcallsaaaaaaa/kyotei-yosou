// 確率順の「何位を買うか」ごとに、的中率・回収率・平均配当を出す。
//
//   node --max-old-space-size=4096 scripts/rank-test.mjs
//   node --max-old-space-size=4096 scripts/rank-test.mjs --max 30
//
// ★並べ替えはモデルの確率だけ。オッズは使っていない（＝朝に確定する買い方）。
//   期待値順（確率×オッズ）は ev-test.mjs で測ってあり、上限の時点で確率順に負ける。
//
// ★「上位10%」は自信度（3連複の上位4点の確率の合計）の上位10%。
//   本番の絞り 0.7645 はこの分位点から出したもの。検証データは確率の鋭さが
//   違うので、数値の閾値ではなく**分位点**で切ること。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const MAX = Number((argv.indexOf('--max') > -1 ? argv[argv.indexOf('--max') + 1] : 20))

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

const payT = new Map(), payF = new Map()
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrentan'`).all())
  payT.set(r.race_id + '|' + r.combo, r.amount)
for (const r of db.prepare(`SELECT race_id, combo, amount FROM payouts WHERE bet_type='sanrenpuku'`).all())
  payF.set(r.race_id + '|' + r.combo.split('-').map(Number).sort((a, b) => a - b).join('='), r.amount)

// wi3（歩進検証）をレースごとに読む
const races = []
{
  const it = db.prepare(`SELECT race_id, combo, p FROM wi3 ORDER BY race_id`).iterate()
  let cur = null, buf = []
  const flush = () => {
    if (!cur || !buf.length) return
    if (buf.some((x) => payT.has(cur + '|' + x[0]))) {
      const st = buf.slice().sort((a, b) => b[1] - a[1])
      const m = new Map()
      for (const [c, p] of buf) {
        const k = c.split('-').map(Number).sort((a, b) => a - b).join('=')
        m.set(k, (m.get(k) ?? 0) + p)
      }
      const sf = [...m].sort((a, b) => b[1] - a[1])
      races.push({
        conf4: sf.slice(0, 4).reduce((s, x) => s + x[1], 0),
        rid: cur,
        // 順位ごとの払戻（当たっていなければ 0）
        t: st.slice(0, MAX).map(([c]) => payT.get(cur + '|' + c) ?? 0),
        f: sf.slice(0, MAX).map(([c]) => payF.get(cur + '|' + c) ?? 0),
      })
    }
    buf = []
  }
  for (const r of it) { if (r.race_id !== cur) { flush(); cur = r.race_id } buf.push([r.combo, r.p]) }
  flush()
}
races.sort((a, b) => b.conf4 - a.conf4)

function table(title, set, key) {
  console.log('■ ' + title + '（' + set.length.toLocaleString() + 'レース・1点100円）')
  console.log('  順位   的中率    回収率   的中時の平均配当    最高配当')
  for (let i = 0; i < MAX; i++) {
    const v = set.map((r) => r[key][i]).filter((x) => x !== undefined)
    const hits = v.filter((x) => x > 0)
    if (!v.length) break
    const ret = v.reduce((s, x) => s + x, 0)
    const avg = hits.length ? ret / hits.length : 0
    console.log('  ' + String(i + 1).padStart(3) + '位',
      (hits.length / v.length * 100).toFixed(2).padStart(8) + '%',
      (ret / (v.length * 100) * 100).toFixed(1).padStart(8) + '%',
      Math.round(avg).toLocaleString().padStart(14) + '円',
      Math.max(0, ...hits).toLocaleString().padStart(10) + '円')
  }
  console.log('')
}

// ★上位N点をまとめて買った場合（点数を増やすほど的中は上がり、回収は下がる）
function cum(title, set, key, list) {
  console.log('■ ' + title + '（' + set.length.toLocaleString() + 'レース・1点100円）')
  // ★平均は大穴1本で跳ねるので、中央値と上位1%も出す。
  //   「平均3,000円」と「半分は1,500円以下」は、同じ分布の別の顔。
  console.log('  点数   投資   的中率   回収率   配当の平均／中央値／上位1%／最高    1レースの平均収支')
  for (const n of list) {
    if (n > MAX) continue
    let ret = 0
    const won = []
    for (const r of set) {
      const got = r[key].slice(0, n).reduce((s, x) => s + x, 0)
      if (got > 0) won.push(got)
      ret += got
    }
    won.sort((a, b) => a - b)
    const q = (f) => won.length ? won[Math.min(won.length - 1, Math.floor(won.length * f))] : 0
    const bet = n * 100
    const yen = (v) => Math.round(v).toLocaleString() + '円'
    console.log('  ' + String(n).padStart(3) + '点', (bet.toLocaleString() + '円').padStart(7),
      (won.length / set.length * 100).toFixed(1).padStart(7) + '%',
      (ret / (set.length * bet) * 100).toFixed(1).padStart(7) + '%',
      [yen(won.reduce((s, x) => s + x, 0) / (won.length || 1)), yen(q(0.5)), yen(q(0.99)), yen(q(1))]
        .map((s) => s.padStart(8)).join(' ／'),
      yen(ret / set.length - bet).padStart(12))
  }
  console.log('')
}

// ★「何位から何位まで」を買う場合。点数を揃えて切り取る場所だけ変えて比べられる。
//   --range 5-15,1-11,3-13 のように指定する。
function ranges(title, set, key, specs) {
  console.log('■ 【範囲買い】' + title + '（' + set.length.toLocaleString() + 'レース・1点100円）')
  console.log('  範囲      点数   投資   的中率   回収率   配当の平均／中央値／最高    1レースの平均収支')
  for (const [a, b] of specs) {
    if (b > MAX) continue
    let ret = 0
    const won = []
    for (const r of set) {
      const got = r[key].slice(a - 1, b).reduce((s, x) => s + x, 0)
      if (got > 0) won.push(got)
      ret += got
    }
    won.sort((x, y) => x - y)
    const n = b - a + 1, bet = n * 100
    const yen = (v) => Math.round(v).toLocaleString() + '円'
    console.log('  ' + (a + '〜' + b + '位').padEnd(9), String(n).padStart(3) + '点', (bet.toLocaleString() + '円').padStart(7),
      (won.length / set.length * 100).toFixed(1).padStart(7) + '%',
      (ret / (set.length * bet) * 100).toFixed(1).padStart(7) + '%',
      [yen(won.reduce((s, x) => s + x, 0) / (won.length || 1)), yen(won[Math.floor(won.length / 2)] ?? 0), yen(won.at(-1) ?? 0)]
        .map((s) => s.padStart(9)).join(' ／'),
      yen(ret / set.length - bet).padStart(12))
  }
  console.log('')
}

// ★総当たり（--sweep）
//   券種 × 自信度の帯 × 開始順位 × 点数 を全部試して、回収率の高い順に出す。
//   ⚠ 数千通り試せば、偶然100%を超えるものが必ず出る。だから**必ず前半/後半に
//     割って両方で残るかを見る**。片方だけなら偶然。
//     （20位99.2%・自信度77〜80・3〜8位105% … いずれもこれで消えた）
if (argv.includes('--sweep')) {
  const half = Math.floor(races.length / 2)   // 並びは race_id 順ではないので日付で割る
  const byDate = races.slice().sort((a, b) => a.rid.localeCompare(b.rid))
  const cutDate = byDate[half].rid.slice(0, 8)
  const pre = (arr) => { const p = [0]; for (let i = 0; i < arr.length; i++) p.push(p[i] + arr[i]); return p }
  for (const r of races) { r.pt = pre(r.t); r.pf = pre(r.f) }
  const sorted = races.slice().sort((a, b) => b.conf4 - a.conf4)
  const bands = [['全部', 0, 1], ['上位50%', 0, .5], ['上位30%', 0, .3], ['上位20%', 0, .2],
    ['上位10%', 0, .1], ['上位5%', 0, .05], ['下位50%', .5, 1], ['下位30%', .7, 1], ['下位10%', .9, 1]]
  const out = []
  for (const [lbl, lo, hi] of bands) {
    const set = sorted.slice(Math.round(sorted.length * lo), Math.round(sorted.length * hi))
    if (set.length < 1000) continue
    for (const [kind, pk] of [['3連単', 'pt'], ['3連複', 'pf']]) {
      for (let a = 1; a <= 20; a++) {
        for (let n = 1; n <= 12; n++) {
          const b = a + n - 1; if (b > MAX) continue
          let ret = 0, hit = 0, sum = 0
          for (const r of set) { const g = r[pk][b] - r[pk][a - 1]; ret += g; if (g > 0) { hit++; sum += g } }
          if (hit < 100) continue           // 標本が薄いものは出さない
          out.push({ lbl, kind, a, b, n, set, races: set.length, hit,
            roi: ret / (set.length * n * 100) * 100, avg: sum / hit })
        }
      }
    }
  }
  out.sort((x, y) => y.roi - x.roi)
  console.log('■ 総当たり：回収率の高い順（当たり100本以上のものだけ）')
  console.log('  絞り       券種    範囲      点数  レース  当たり   回収率   平均配当   前半／後半')
  for (const o of out.slice(0, 15)) {
    const sp = (f) => {
      const s = o.set.filter((r) => f(r.rid.slice(0, 8)))
      let ret = 0; for (const r of s) ret += r[o.kind === '3連単' ? 'pt' : 'pf'][o.b] - r[o.kind === '3連単' ? 'pt' : 'pf'][o.a - 1]
      return s.length ? (ret / (s.length * o.n * 100) * 100).toFixed(1) + '%' : '―'
    }
    console.log('  ' + o.lbl.padEnd(10), o.kind, (o.a + '〜' + o.b + '位').padEnd(9), String(o.n).padStart(2) + '点',
      String(o.races).padStart(7), String(o.hit).padStart(7),
      o.roi.toFixed(1).padStart(8) + '%', Math.round(o.avg).toLocaleString().padStart(9) + '円',
      ('  ' + sp((d) => d < cutDate) + ' ／ ' + sp((d) => d >= cutDate)))
  }
  console.log('')
  console.log('  （前半＝' + byDate[0].rid.slice(0, 8) + '〜 ／ 後半＝' + cutDate + '〜。')
  console.log('    両方で100%を超えていなければ、偶然の山と見なすこと）')
  db.close(); process.exit(0)
}

const top10 = races.slice(0, Math.round(races.length * 0.10))
// --from 5 … 5位から買い足していく（5位始まりで点数を増やす）
// 指定が無ければ、同じ点数で切り取る場所だけ変えた比較を出す
const FROM = argv.indexOf('--from') > -1 ? Number(argv[argv.indexOf('--from') + 1]) : null
const RANGES = FROM
  ? [1, 2, 3, 4, 6, 8, 11, 16, 20, 24].map((n) => [FROM, FROM + n - 1]).filter(([, b]) => b <= MAX)
  : [[1, 11], [3, 13], [5, 15], [8, 18], [10, 20], [5, 10], [5, 20]]
ranges('3連単・全レース', races, 't', RANGES)
ranges('3連単・上位10%（いまの配信の絞りに相当）', top10, 't', RANGES)
ranges('3連複・上位10%', top10, 'f', RANGES)
const NS = [1, 2, 4, 6, 8, 12, 16, 24, 32, 40, 48]
cum('【まとめ買い】3連単・全レース', races, 't', NS)
cum('【まとめ買い】3連単・上位10%（いまの配信の絞りに相当）', top10, 't', NS)
cum('【まとめ買い】3連複・上位10%', top10, 'f', NS.filter((n) => n <= 20))
if (!argv.includes('--cum-only')) {
  table('3連単・全レース', races, 't')
  table('3連単・上位10%（いまの配信の絞りに相当）', top10, 't')
  table('3連複・全レース', races, 'f')
  table('3連複・上位10%', top10, 'f')
}

db.close()
