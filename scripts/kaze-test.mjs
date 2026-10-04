// 「風向きの条件がそろうと荒れる場がある」を測る。
//
//   node scripts/kaze-test.mjs                 風速3m以上で、場×風向きごとの荒れ方
//   node scripts/kaze-test.mjs --speed 4       風速の足切りを変える
//   node scripts/kaze-test.mjs --min 80        1セルの最低レース数
//
// ★締切前の風向きを使うこと
//   races.wind_dir は**レース後**のKファイルの値で、締切前の値とは
//   風速で51.4%・向きで6割しか一致しない（展示の時点とレース中で風が変わる）。
//   2026-09-30に races.wind_dir で測って「風向きは効かない」と結論したが、
//   4割が誤った向きでの測定だったので、あの結論は無効。
//   before_race.wind_dir（直前情報・数字1〜17）が、買う時点で手に入る唯一の値。
//
// ★必ず前半・後半に割る
//   場24 × 向き17 = 408通りあるので、探せば「荒れる組み合わせ」は必ず見つかる。
//   前半で見つけたものが後半でも残るかまで見ないと、偶然の山を拾う。
//   （20位99.2%・自信度77〜80・3〜8位105% … いずれもこれで消えた）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const num = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? Number(argv[i + 1]) : d }
const SPEED = num('speed', 3)
const MIN = num('min', 80)

const VEN = { 1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖', 7: '蒲郡', 8: '常滑',
  9: '津', 10: '三国', 11: 'びわこ', 12: '住之江', 13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島',
  17: '宮島', 18: '徳山', 19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村' }

const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })

// 1レース1行。荒れ方は「3連単の払戻」と「1着が内(1〜3コース)か」で見る
const rows = db.prepare(`
  SELECT b.race_id AS rid, r.jcd, b.wind_dir AS dir, b.wind_speed AS sp,
         p.amount AS pay, e.course AS wc
  FROM before_race b
  JOIN races r   ON r.race_id = b.race_id
  JOIN payouts p ON p.race_id = b.race_id AND p.bet_type = 'sanrentan'
  JOIN entries e ON e.race_id = b.race_id AND e.rank_num = 1
  WHERE b.wind_dir IS NOT NULL AND b.wind_speed IS NOT NULL AND e.course IS NOT NULL`).all()
db.close()

const strong = rows.filter((x) => x.sp >= SPEED)
const dates = [...new Set(rows.map((x) => x.rid.slice(0, 8)))].sort()
const cut = dates[Math.floor(dates.length / 2)]
console.log(`全 ${rows.length.toLocaleString()}レース ／ 風速${SPEED}m以上 ${strong.length.toLocaleString()}レース`)
console.log(`前半 ${dates[0]}〜 ／ 後半 ${cut}〜`)
console.log('')

const stat = (set) => {
  if (!set.length) return null
  const pays = set.map((x) => x.pay).sort((a, b) => a - b)
  return {
    n: set.length,
    inner: set.filter((x) => x.wc <= 3).length / set.length * 100,   // 1着が1〜3コース
    med: pays[Math.floor(pays.length / 2)],                           // 配当の中央値
    man: set.filter((x) => x.pay >= 10000).length / set.length * 100, // 万舟率
  }
}

// ---------- 場ごとの基準（弱風） ----------
const base = new Map()
for (const jcd of Object.keys(VEN).map(Number)) {
  const s = stat(rows.filter((x) => x.jcd === jcd && x.sp <= 1))
  if (s && s.n >= 100) base.set(jcd, s)
}

// ---------- 場 × 風向き ----------
const cells = []
for (const jcd of Object.keys(VEN).map(Number)) {
  const b = base.get(jcd); if (!b) continue
  for (let dir = 1; dir <= 17; dir++) {
    const all = strong.filter((x) => x.jcd === jcd && x.dir === dir)
    if (all.length < MIN) continue
    const A = stat(all.filter((x) => x.rid.slice(0, 8) < cut))
    const B = stat(all.filter((x) => x.rid.slice(0, 8) >= cut))
    if (!A || !B || A.n < 25 || B.n < 25) continue
    cells.push({ jcd, dir, all: stat(all), A, B, b })
  }
}
console.log(`測れた組み合わせ ${cells.length}（1セル${MIN}レース以上・前後半とも25レース以上）`)
console.log('')

// 荒れている順（万舟率が弱風の基準からどれだけ上がっているか）
cells.sort((x, y) => (y.all.man - y.b.man) - (x.all.man - x.b.man))
const line = (c) => '  ' + (VEN[c.jcd] + ' 向き' + c.dir).padEnd(11) +
  String(c.all.n).padStart(5) + 'R  ' +
  ('内' + c.all.inner.toFixed(0) + '%').padStart(6) +
  ('  万舟' + c.all.man.toFixed(1) + '%').padStart(10) +
  ('（弱風時' + c.b.man.toFixed(1) + '%）').padStart(12) +
  '  中央値' + c.all.med.toLocaleString().padStart(7) + '円' +
  '   前半' + c.A.man.toFixed(1) + '% ／ 後半' + c.B.man.toFixed(1) + '%'

console.log('■ 荒れる側（万舟率が弱風より高い順）')
console.log('  場・向き      本数    1着が内   万舟率     （基準）        配当中央値    前半／後半')
for (const c of cells.slice(0, 12)) console.log(line(c))
console.log('')
console.log('■ 固まる側（万舟率が弱風より低い順）')
for (const c of cells.slice(-8).reverse()) console.log(line(c))
console.log('')
console.log('※ 前半と後半の両方で基準を上回っていなければ、偶然の山と見なすこと')
