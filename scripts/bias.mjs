// モデルが「どの条件で系統的に外しているか」を全次元・掛け合わせで洗い出す。
//
//   node scripts/bias.mjs
//   node scripts/bias.mjs --min 300     その条件の最低件数（既定200）
//
// ★なぜ生の勝率を並べないのか
//   時間帯ごとの1着率には最大29ptの差があったが、調べると**番組編成で全部説明がついた**。
//   （後半のレースほど強い選手が1号艇に入る）。生の集計は他の要因と混ざるので、
//   「12Rは1号艇が強い」のような、実際には成り立たない結論を生む。
//
// ★代わりに何を見るか
//   モデルは選手・モーター・コース・場・グレード・波・風を全部織り込んで確率を出している。
//   その上でなお「予測より実際が高い／低い」条件があれば、
//   それはモデルがまだ捉えていない本物の効果である可能性が高い。
//   ずれ = 実際の1着率 − 予測確率の平均。
//
// ★注意
//   検証期間（学習に使っていない期間）だけで見る。学習期間で見ると当てはめた分ずれが消える。
//   件数が少ない条件は偶然で大きくずれるので、95%信頼区間が0を跨ぐものは採らない。
//   条件を大量に調べると、偶然だけで「有意」が出る。件数と区間を必ず併記する。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const MIN = Number(flag('min', 200))

const VENUE = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国',
  'びわこ', '住之江', '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

const rows = all(`
  SELECT p.p, p.y, p.course, r.jcd, r.grade, r.race_no, r.wave, r.wind_speed, r.wind_dir,
         r.deadline, r.day_no
  FROM pred p JOIN races r ON r.race_id = p.race_id
  WHERE p.split = 'test'`)
console.log(`検証期間 ${rows.length.toLocaleString()} 艇ぶん\n`)

const waveB = (w) => (w == null ? '不明' : w <= 2 ? '波0-2cm' : w <= 5 ? '波3-5cm' : w <= 9 ? '波6-9cm' : '波10cm以上')
const windB = (w) => (w == null ? '不明' : w <= 1 ? '風0-1m' : w <= 3 ? '風2-3m' : w <= 5 ? '風4-5m' : '風6m以上')
const hourOf = (t) => { const m = String(t ?? '').match(/^(\d{1,2}):/); return m ? Number(m[1]) : null }

/** 条件ごとに「予測平均」と「実際」を比べる */
function scan(label, keyFn) {
  const g = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (k == null) continue
    let e = g.get(k); if (!e) { e = { n: 0, p: 0, y: 0 }; g.set(k, e) }
    e.n++; e.p += r.p; e.y += r.y
  }
  const out = []
  for (const [k, e] of g) {
    if (e.n < MIN) continue
    const pp = e.p / e.n, ac = e.y / e.n
    const se = Math.sqrt(Math.max(ac * (1 - ac), 1e-9) / e.n)
    const d = ac - pp
    out.push({ k, n: e.n, pp, ac, d, lo: d - 1.96 * se, hi: d + 1.96 * se })
  }
  out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  const sig = out.filter((x) => x.lo > 0 || x.hi < 0)
  console.log(`\n=== ${label} ===  条件${out.length}件中、意味のあるずれ ${sig.length}件`)
  if (!sig.length) { console.log('  モデルで説明できている（系統的なずれなし）'); return }
  console.log('  条件                          件数    予測    実際     ずれ        95%区間')
  for (const x of sig.slice(0, 12))
    console.log(`  ${String(x.k).padEnd(28)} ${String(x.n).padStart(6)}  ${(x.pp * 100).toFixed(1).padStart(5)}%  ${(x.ac * 100).toFixed(1).padStart(5)}%  ${(x.d * 100 >= 0 ? '+' : '') + (x.d * 100).toFixed(1).padStart(5)}pt   [${(x.lo * 100).toFixed(1)}, ${(x.hi * 100).toFixed(1)}]`)
}

console.log('■ 単一の次元')
scan('競艇場', (r) => VENUE[r.jcd] ?? r.jcd)
scan('グレード', (r) => r.grade)
scan('出走コース', (r) => `${r.course}コース`)
scan('波', (r) => waveB(r.wave))
scan('風速', (r) => windB(r.wind_speed))
scan('風向', (r) => r.wind_dir)
scan('何レース目', (r) => `${r.race_no}R`)
scan('時間（1時間刻み）', (r) => { const h = hourOf(r.deadline); return h == null ? null : `${h}時台` })
scan('日目', (r) => (r.day_no == null ? null : `第${r.day_no}日`))

console.log('\n\n■ 掛け合わせ')
scan('競艇場 × コース', (r) => `${VENUE[r.jcd] ?? r.jcd} ${r.course}コース`)
scan('グレード × コース', (r) => `${r.grade} ${r.course}コース`)
scan('波 × コース', (r) => `${waveB(r.wave)} ${r.course}コース`)
scan('風速 × コース', (r) => `${windB(r.wind_speed)} ${r.course}コース`)
scan('競艇場 × グレード', (r) => `${VENUE[r.jcd] ?? r.jcd} ${r.grade}`)
scan('競艇場 × 波', (r) => `${VENUE[r.jcd] ?? r.jcd} ${waveB(r.wave)}`)
scan('レース番号 × コース', (r) => `${r.race_no}R ${r.course}コース`)
scan('時間 × コース', (r) => { const h = hourOf(r.deadline); return h == null ? null : `${h}時台 ${r.course}コース` })
scan('日目 × コース', (r) => (r.day_no == null ? null : `第${r.day_no}日 ${r.course}コース`))
scan('競艇場 × 風速', (r) => `${VENUE[r.jcd] ?? r.jcd} ${windB(r.wind_speed)}`)

console.log(`\n\n※ 検証期間のみ・各条件${MIN}件以上・95%信頼区間が0を跨がないものだけを表示`)
console.log('※ 多数の条件を同時に調べているので、区間ぎりぎりのものは偶然の可能性がある。')
console.log('   実際に使う前に、別期間でも同じ向きに出るかを確認すること。')
db.close()
