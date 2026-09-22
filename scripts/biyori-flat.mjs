// biyori_racer の JSON を、1項目=1列の平坦テーブルに展開する。
//
//   node scripts/biyori-flat.mjs
//
// ★なぜ必要か
//   日和は選手1人あたり1,516項目を返すが、JSON文字列のままでは集計できない。
//   json_extract で毎回掘ると33万行×1516項目で実用にならないので、列にする。
//   SQLite の既定の列数上限は2000なので1,516列は入る。
//
// ★項目の意味（実データで確認済み・推測ではない）
//   接尾辞が条件を表す：
//     なし=全体 / _nomal=一般戦 / _sg=SG / _woman=女子戦 / _tochi=当地
//     _night=ナイター / _shonichi=初日 / _saishu=最終日 / _fmochi=F持ち
//     _choku1,2,3,6 = 直近期間
//   接頭辞が指標を表す：
//     course{N}_shinnyu=そのコースでの進入回数 / course{N}_{1,2,3}_ave=1〜3着率
//     start{N}_ave=そのコースでの平均ST / st_junban_{N}=ST順位
//     kimete_*=決まり手別回数 / nami5_*=波5cm超での成績
//     jiko_ten/jiko_ritsu=事故点・事故率 / mishoka_flying=フライング未消化

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const one = (s, ...p) => db.prepare(s).get(...p)

const sample = one(`SELECT data FROM biyori_racer LIMIT 1`)
if (!sample) { console.error('biyori_racer が空です'); process.exit(1) }

// 列名はSQLiteの予約語と衝突しうるので必ず引用する
const keys = Object.keys(JSON.parse(sample.data))
const q = (k) => '"' + k.replace(/"/g, '""') + '"'
console.log(`項目数 ${keys.length}`)

// 数値なら REAL、そうでなければ TEXT。100件見て決める。
const probe = all(`SELECT data FROM biyori_racer LIMIT 100`).map((r) => JSON.parse(r.data))
const isNum = (k) => probe.every((p) => {
  const v = p[k]
  return v === null || v === '' || v === undefined || (typeof v !== 'object' && /^-?\d+(\.\d+)?$/.test(String(v)))
})
const types = Object.fromEntries(keys.map((k) => [k, isNum(k) ? 'REAL' : 'TEXT']))
console.log(`  数値列 ${keys.filter((k) => types[k] === 'REAL').length} / 文字列 ${keys.filter((k) => types[k] === 'TEXT').length}`)

db.exec(`DROP TABLE IF EXISTS bf`)
db.exec(`CREATE TABLE bf (
  race_id TEXT NOT NULL, lane INTEGER NOT NULL,
  ${keys.map((k) => `${q(k)} ${types[k]}`).join(',\n  ')},
  PRIMARY KEY (race_id, lane)
)`)

const ins = db.prepare(`INSERT OR REPLACE INTO bf (race_id, lane, ${keys.map(q).join(',')})
  VALUES (?,?,${keys.map(() => '?').join(',')})`)

const total = one(`SELECT COUNT(*) c FROM biyori_racer`).c
console.log(`展開対象 ${total.toLocaleString()} 行`)

const CH = 4000
let done = 0
const t0 = Date.now()
for (let off = 0; off < total; off += CH) {
  const rows = all(`SELECT race_id, lane, data FROM biyori_racer ORDER BY race_id, lane LIMIT ${CH} OFFSET ${off}`)
  if (!rows.length) break
  db.exec('BEGIN')
  for (const r of rows) {
    const o = JSON.parse(r.data)
    const vals = keys.map((k) => {
      const v = o[k]
      if (v === null || v === undefined || v === '') return null
      if (typeof v === 'object') return JSON.stringify(v)
      return types[k] === 'REAL' ? (Number.isFinite(Number(v)) ? Number(v) : null) : String(v)
    })
    ins.run(r.race_id, r.lane, ...vals)
  }
  db.exec('COMMIT')
  done += rows.length
  const el = (Date.now() - t0) / 1000
  console.log(`  ${done.toLocaleString()}/${total.toLocaleString()} (${((done / total) * 100).toFixed(1)}%)  ${el.toFixed(0)}秒経過`)
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_bf_player ON bf(player_no)`)
db.exec(`ANALYZE bf`)
console.log(`\n完了: bf ${one('SELECT COUNT(*) c FROM bf').c.toLocaleString()} 行 × ${keys.length + 2} 列`)
db.close()
