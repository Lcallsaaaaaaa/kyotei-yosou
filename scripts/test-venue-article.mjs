// 場ごとの攻略記事を作る仕組みを確かめる。
//
//   node scripts/test-venue-article.mjs
//
// ★なぜこれが要るか（2026-10-11）
//   この記事は**無人で毎日1場ぶん書き換わる**。間違えたらそのまま公開される。
//   こわいのは2つ。
//   ①母数の小さい数字を言い切ってしまう（「2Rは29%しか勝てない」が実は偶然）
//   ②24場で同じ文章になってしまう（＝大量生成コンテンツの不正使用に当たる）
//   どちらも画面を見ただけでは気づけないので、条件で押さえる。
import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeArticle, venueOfDay, zDiff, isSure, extremes, VENUES, MIN_N, Z_SURE, KIMARITE_DESC } from './venue-article.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let ok = 0, ng = 0
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✓ ${name}`) }
  else { ng++; console.log(`  ✗ ${name}${extra ? '　' + extra : ''}`) }
}

console.log('\n■ 1. 差の検定（言い切ってよいかの判定）')
{
  t('同じ割合なら z=0', zDiff(50, 100, 50, 100) === 0)
  t('母数が0なら0を返す', zDiff(5, 0, 5, 100) === 0)
  t('大きな差＋大きな母数は確かと判定', isSure({ w: 700, n: 1000 }, { w: 400, n: 1000 }) === true)
  t('同じ差でも母数が小さければ確かと言わない', isSure({ w: 7, n: 10 }, { w: 4, n: 10 }) === false)
  t('わずかな差は母数が大きくても慎重', isSure({ w: 505, n: 1000 }, { w: 500, n: 1000 }) === false)
  t('わずかな差でも母数が極端に大きければ拾う', isSure({ w: 52000, n: 100000 }, { w: 50000, n: 100000 }) === true)
  t('しきい値は p<0.01 相当', Z_SURE === 2.58)
  t('母数の下限は200', MIN_N === 200)
}

console.log('\n■ 2. 「いちばん高い／低い」は確かなときだけ')
{
  const big = [{ label: 'A', w: 700, n: 1000 }, { label: 'B', w: 500, n: 1000 }, { label: 'C', w: 400, n: 1000 }]
  const e = extremes(big)
  t('はっきり差があれば返す', e != null)
  t('いちばん高いのはA', e?.hi.label === 'A')
  t('いちばん低いのはC', e?.lo.label === 'C')
  t('並び順を変えても同じ', extremes([...big].reverse())?.hi.label === 'A')
  t('差が小さければ null（表だけ出す）',
    extremes([{ label: 'A', w: 505, n: 1000 }, { label: 'B', w: 500, n: 1000 }]) === null)
  t('母数が足りないものは最初から外す',
    extremes([{ label: 'A', w: 9, n: 10 }, { label: 'B', w: 1, n: 10 }]) === null)
  t('母数の足りるものが1つだけなら null',
    extremes([{ label: 'A', w: 700, n: 1000 }, { label: 'B', w: 1, n: 10 }]) === null)
  t('空なら null', extremes([]) === null)
  // ★ここが肝：見かけ上の大差でも母数が小さければ黙る
  t('n=30同士の40ポイント差は言い切らない',
    extremes([{ label: 'A', w: 21, n: 30 }, { label: 'B', w: 9, n: 30 }]) === null)
}

console.log('\n■ 3. 当番の場（24日で一周）')
{
  t('同じ日なら何度でも同じ場', venueOfDay('2026-10-11') === venueOfDay('2026-10-11'))
  t('翌日は次の場', ((venueOfDay('2026-10-11') % 24) + 1) === venueOfDay('2026-10-12'))
  t('24日後に戻る', venueOfDay('2026-10-11') === venueOfDay('2026-11-04'))
  t('必ず1〜24に入る', [...Array(60)].every((_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
    const v = venueOfDay(d); return v >= 1 && v <= 24
  }))
  const seen = new Set()
  for (let i = 0; i < 24; i++) seen.add(venueOfDay(new Date(Date.UTC(2026, 9, 11) + i * 86400e3).toISOString().slice(0, 10)))
  t('24日で24場すべてを1回ずつ回る', seen.size === 24, `回った数=${seen.size}`)
}

console.log('\n■ 4. 本物のデータで24場ぶん作る')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
db.exec('PRAGMA busy_timeout = 30000')
const arts = []
for (let jcd = 1; jcd <= 24; jcd++) arts.push({ jcd, venue: VENUES[jcd], md: makeArticle(db, jcd) })
db.close()
{
  t('24場すべて作れた', arts.length === 24)
  t('どれも3,000文字以上の中身がある', arts.every((a) => a.md.length >= 3000),
    `いちばん短いのは ${Math.min(...arts.map((a) => a.md.length))}文字`)
  t('frontmatter が付いている', arts.every((a) => a.md.startsWith('---\ntitle: ')))
  t('題にその場の名前が入っている', arts.every((a) => a.md.split('\n')[1].includes(a.venue)))
  t('本文にその場の名前が入っている', arts.every((a) => a.md.includes(`ボートレース${a.venue}`)))
  t('表が5つ以上ある', arts.every((a) => (a.md.match(/^\| コース \|/gm) ?? []).length >= 1
    && (a.md.match(/^\|---/gm) ?? []).length >= 5))
  t('日付が今日', arts.every((a) => a.md.includes(`date: ${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)}`)))
}

console.log('\n■ 5. 24場が本当に別の中身か（ここが「量産」との分かれ目）')
{
  const bodies = arts.map((a) => a.md.replace(/^---[\s\S]*?---\n/, ''))
  t('同じ本文のものが1組も無い', new Set(bodies).size === 24)
  // 場名を伏せても見分けがつくか＝数字が違うか
  const masked = arts.map((a, i) => bodies[i].replaceAll(a.venue, '○○'))
  t('場名を伏せても全部ちがう', new Set(masked).size === 24)
  // 結論（効いている／偶然の範囲）が場によって割れているか
  const kiku = arts.filter((a) => a.md.includes('はインの勝率に効いています')).length
  const guzen = arts.filter((a) => a.md.includes('偶然の範囲')).length
  t('「効いている」と出る場がある', kiku > 0, `${kiku}場`)
  t('「偶然の範囲」と出る場もある（全部同じ結論ではない）', guzen > 0, `${guzen}場`)
  const arete = arts.filter((a) => a.md.includes('荒れやすい')).length
  const katai = arts.filter((a) => a.md.includes('堅く決まりやすい')).length
  t('荒れる場と堅い場に分かれている', arete > 0 && katai > 0, `荒れ${arete}場・堅${katai}場`)
}

console.log('\n■ 6. 書いてはいけないことが入っていないか')
{
  const NG = ['必ず勝て', '儲かります', '確実に', '絶対に当た', '稼げます']
  for (const w of NG) t(`「${w}」が入っていない`, arts.every((a) => !a.md.includes(w)))
  t('20歳未満への注意が全部に入っている', arts.every((a) => a.md.includes('20歳から')))
  t('控除率の記事へ案内している', arts.every((a) => a.md.includes('/news/2026-10-10-kojoritsu')))
  t('確定払戻である旨が全部に入っている', arts.every((a) => a.md.includes('確定払戻')))
  t('母数の表記（n=）が本文にある', arts.every((a) => a.md.includes('n=')))
}

console.log('\n■ 7. 数字そのものの正しさ（別経路で突き合わせ）')
{
  const db2 = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
  db2.exec('PRAGMA busy_timeout = 30000')
  let bad = 0
  for (const a of arts) {
    const r = db2.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN e.rank_num=1 THEN 1 ELSE 0 END) w
      FROM entries e JOIN races rc ON rc.race_id = e.race_id
      WHERE rc.jcd=? AND e.course=1`).get(a.jcd)
    const want = (r.w / r.n * 100).toFixed(1)
    if (!a.md.includes(`1コースの1着率は**${want}%**（n=${r.n.toLocaleString()}）`)) {
      bad++; console.log(`    ${a.venue}: 期待 ${want}% / n=${r.n}`)
    }
  }
  t('24場すべてで1コース1着率がDBと一致', bad === 0, `ずれ ${bad}場`)
  const tot = db2.prepare('SELECT COUNT(*) n FROM races WHERE jcd=1').get()
  t('レース数がDBと一致（桐生）', arts[0].md.includes(tot.n.toLocaleString() + 'レース'))
  db2.close()
}

console.log('\n■ 8. 進入と年推移（2026-10-11に踏んだNULLの罠を含む）')
{
  t('全場に進入の節がある', arts.every((a) => a.md.includes('## 進入（枠なりで収まるか')))
  t('全場に年ごとの変化がある', arts.every((a) => a.md.includes('## 年ごとの変化')))
  const nums = arts.map((a) => (a.md.match(/進入になったレースは([\d.]+)%/) ?? [])[1])
  t('進入率が24場すべてで取れている', nums.every(Boolean))
  t('進入率が場によって違う（定型文になっていない）', new Set(nums).size >= 20, `ちがう値 ${new Set(nums).size}通り`)

  // ★ここが本題：「6艇ぶんの course が全部そろったレースだけ」で数えると
  //   前付けのあるレースほど落ちて、枠なり率が上に化ける。
  //   別経路（レース総数 − 食い違いが1艇でもあるレース）と突き合わせる。
  const db3 = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'), { readOnly: true })
  db3.exec('PRAGMA busy_timeout = 30000')
  let bad = 0
  for (const a of arts) {
    const tot = db3.prepare('SELECT COUNT(*) n FROM races WHERE jcd=?').get(a.jcd)
    const off = db3.prepare(`SELECT COUNT(DISTINCT e.race_id) n FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE r.jcd=? AND e.course IS NOT NULL AND e.lane <> e.course`).get(a.jcd)
    const want = ((tot.n - off.n) / tot.n * 100).toFixed(1)
    if (!a.md.includes(`進入になったレースは${want}%`)) { bad++; console.log(`    ${a.venue}: 期待 ${want}%`) }
  }
  t('24場すべてで進入率がDBと一致', bad === 0, `ずれ ${bad}場`)
  // 落ちたやり方（c=6 でしぼる）との違いが実際に出ることも押さえる
  const old = db3.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN ok=6 THEN 1 ELSE 0 END) w FROM (
    SELECT e.race_id, SUM(CASE WHEN e.lane=e.course THEN 1 ELSE 0 END) ok, COUNT(*) c
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE r.jcd=3 AND e.course IS NOT NULL GROUP BY e.race_id HAVING c=6)`).get()
  const oldPct = old.w / old.n * 100
  t('江戸川で旧方式と2ポイント近い差が出る（罠が実在する証拠）', oldPct - 98.0 > 1.5,
    `旧方式 ${oldPct.toFixed(1)}% / 正しくは 98.0%`)
  db3.close()
}

console.log('\n■ 9. 決まり手の説明（2026-10-11 本人指摘：「恵まれ」が何か分からない）')
{
  t('6種類すべてに説明がある', Object.keys(KIMARITE_DESC).length === 6)
  for (const k of ['逃げ', '差し', 'まくり', 'まくり差し', '抜き', '恵まれ'])
    t(`「${k}」の説明がある`, !!KIMARITE_DESC[k])
  t('「恵まれ」の説明に繰り上がりの話が入っている', /繰り上が/.test(KIMARITE_DESC['恵まれ']))
  t('全場の表に説明の列がある', arts.every((a) => a.md.includes('| 決まり手 | 回数 | 割合 | どういう勝ち方か |')))
  t('全場に「恵まれ」の説明が出ている', arts.every((a) => a.md.includes('繰り上がって1着')))
  t('「差しやまくりが無い理由」を全場で説明している',
    arts.every((a) => a.md.includes('1コースの決まり手は**この3つしかありません**')))
  // ★1コースの内訳に、外のコース用の決まり手が混ざっていないこと
  //   （混ざっていたら集計の結合を間違えている）
  let bad = 0
  for (const a of arts) {
    const sec = a.md.slice(a.md.indexOf('## 決まり手'), a.md.indexOf('## 配当'))
    const table = sec.slice(0, sec.indexOf('\n\n1コースの勝ちは'))
    for (const ng2 of ['| 差し |', '| まくり |', '| まくり差し |'])
      if (table.includes(ng2)) { bad++; console.log(`    ${a.venue}: 1コースの表に ${ng2}`) }
  }
  t('1コースの内訳に 差し／まくり／まくり差し が混ざっていない', bad === 0)
}

console.log(`\n${ng ? '✗' : '✓'} ${ok + ng}件中 ${ok}件が通りました${ng ? `・${ng}件が落ちました` : ''}`)
process.exit(ng ? 1 : 0)
