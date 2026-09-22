// 「波耐性」と「外枠適性」は同じ能力か？
//
//   node scripts/wake-skill.mjs
//
// ★検証する仮説（2026/08/18 ユーザー提供）
//   「4・5・6号艇は1マークのターン時に先行艇の出した波を乗り越えていかなければいけない。
//    常に高波状態になる。その為、水面が荒れているときのデータとして併用した」
//
//   これが正しいなら、次が成り立つはず：
//     波耐性（高波での成績 − 平水面での成績）が高い選手ほど、
//     外枠適性（4〜6コースでの成績 − 1〜3コースでの成績）も高い
//
//   選手の総合力は両方に効くので、**同一選手の中の「差分」どうし**で相関を見る。
//   こうすれば「単に強い選手」の影響が消え、能力の中身だけが残る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 180000')
const all = (s, ...p) => db.prepare(s).all(...p)

const corr = (pairs) => {
  const n = pairs.length
  const mx = pairs.reduce((a, b) => a + b[0], 0) / n
  const my = pairs.reduce((a, b) => a + b[1], 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2 }
  return sxy / Math.sqrt(sxx * syy)
}
// 相関がゼロでないと言えるか（フィッシャー変換）
const zTest = (r, n) => Math.abs(0.5 * Math.log((1 + r) / (1 - r))) * Math.sqrt(n - 3)

const MIN = 20
const q = (where, ...p) => {
  const m = new Map()
  for (const r of all(`SELECT e.racer_id, COUNT(*) n,
      SUM(CASE WHEN e.rank_num<=3 THEN 1 ELSE 0 END) t3
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.racer_id IS NOT NULL AND e.rank_num IS NOT NULL AND e.course IS NOT NULL ${where}
    GROUP BY e.racer_id HAVING n >= ${MIN}`, ...p)) m.set(r.racer_id, r.t3 / r.n)
  return m
}

console.log('=== 「波耐性」と「外枠適性」は同じ能力か ===\n')
console.log(`各区分で${MIN}走以上ある選手のみ。指標は3連対率（1着率だと外枠でほぼゼロになり差が出ないため）\n`)

// 波耐性：内枠(1-3)に限定して測る。外枠を混ぜると検証したい相手と重なってしまう
const waveHi = q('AND e.course <= 3 AND r.wave >= 4')
const waveLo = q('AND e.course <= 3 AND r.wave <= 2')
// 外枠適性：平水面(波2cm以下)に限定して測る。高波を混ぜると同じデータを両側に使うことになる
const outer = q('AND e.course >= 4 AND r.wave <= 2')
const inner = q('AND e.course <= 3 AND r.wave <= 2')

const pairs = []
const rows = []
for (const [id, hi] of waveHi) {
  const lo = waveLo.get(id), o = outer.get(id), i = inner.get(id)
  if (lo === undefined || o === undefined || i === undefined) continue
  const waveSkill = hi - lo      // 波耐性
  const outerSkill = o - i       // 外枠適性
  pairs.push([waveSkill, outerSkill])
  rows.push({ id, waveSkill, outerSkill })
}

console.log(`対象 ${pairs.length} 選手`)
if (pairs.length < 40) {
  console.log('標本が足りず判定できません')
  db.close()
  process.exit(0)
}
const r = corr(pairs)
const z = zTest(r, pairs.length)
console.log(`\n  波耐性 と 外枠適性 の相関 = ${r.toFixed(4)}`)
console.log(`  ゼロとの差の検定 z = ${z.toFixed(2)}  （2.0を超えれば偶然とは言いにくい）`)
console.log(`\n  → ${z < 2 ? '**相関は検出できず。仮説を裏付ける証拠は無い**'
  : r > 0 ? '**正の相関あり。仮説を支持する**' : '**負の相関。仮説と逆**'}`)

// 対照実験：波耐性と「内枠での強さそのもの」の相関（交絡していないかの確認）
const ctrl = []
for (const [id, hi] of waveHi) {
  const lo = waveLo.get(id), i = inner.get(id)
  if (lo === undefined || i === undefined) continue
  ctrl.push([hi - lo, i])
}
const rc = corr(ctrl)
console.log(`\n  【対照】波耐性 と 内枠での強さ の相関 = ${rc.toFixed(4)}`)
console.log(`  ※ こちらが強く出るなら、波耐性は単に「強い選手ほど高い」だけの指標かもしれない`)

// 上位・下位の選手を並べて目視確認
rows.sort((a, b) => b.waveSkill - a.waveSkill)
const nm = new Map(all(`SELECT DISTINCT racer_id, racer_name FROM entries WHERE racer_id IS NOT NULL`).map((x) => [x.racer_id, x.racer_name]))
console.log('\n  波耐性が高い選手 上位8人（外枠適性も併記）')
console.log('  登番  選手         波耐性    外枠適性')
for (const x of rows.slice(0, 8))
  console.log(`  ${x.id}  ${(nm.get(x.id) ?? '').padEnd(9, '　')} ${(x.waveSkill * 100).toFixed(1).padStart(6)}pt  ${(x.outerSkill * 100).toFixed(1).padStart(6)}pt`)
console.log('\n  波耐性が低い選手 下位5人')
for (const x of rows.slice(-5))
  console.log(`  ${x.id}  ${(nm.get(x.id) ?? '').padEnd(9, '　')} ${(x.waveSkill * 100).toFixed(1).padStart(6)}pt  ${(x.outerSkill * 100).toFixed(1).padStart(6)}pt`)
db.close()
