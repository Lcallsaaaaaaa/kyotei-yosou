// 公式の「レーサー期別成績」（ファン手帳データ）を取り込む。
//
//   node scripts/fan.mjs --fetch     全期をダウンロードして展開
//   node scripts/fan.mjs --load      DBへ投入
//   node scripts/fan.mjs --probe     未確定バイトの中身を既存データと突合して特定する
//
// ★なぜ要るか
//   KファイルにもBファイルにも無い項目がここにある：
//     性別・身長・血液型・事故率・優出/優勝回数・平均ST・コース別の進入と成績
//   2026/08/18、ユーザーが「1号艇は事故とフライングの歴がある」と指摘したが、
//   事故点・事故率はこちらのデータには存在しなかった。その穴を埋める。
//
// ★形式（実測で確定）
//   Shift-JIS の固定長。1行416バイト。**日本語が2バイトなので文字数で切ると全部ずれる。**
//   0-3 登番 / 4-19 漢字名 / 20-34 カナ名 / 35-38 支部 / 39-40 級別
//   41-47 生年月日 / 48 性別 / 49-50 年齢 / 51-53 身長 / 54-55 体重 / 56 血液型
//   58-61 勝率 / 62-65 2連対率 / 66-68 1着数 / 69-71 2着数 / 72-74 出走数
//   ↑ 2連対率は (1着+2着)/出走 で検算済み（守屋美穂 (36+21)/125 = 45.6% = 記載値）
//   75バイト以降は未確定。--probe で既存データと突合して特定する。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data', 'raw', 'FAN')
const EXT = join(ROOT, 'data', 'extracted', 'FAN')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const dec = new TextDecoder('shift-jis')
const argv = process.argv.slice(2)

// ---------- 取得 ----------
if (argv.includes('--fetch')) {
  mkdirSync(RAW, { recursive: true })
  mkdirSync(EXT, { recursive: true })
  const page = await (await fetch('https://www.boatrace.jp/owpc/pc/extra/data/download.html')).text()
  const links = [...new Set([...page.matchAll(/href="([^"]*kibetsu\/fan\d+\.lzh)"/g)].map((m) => m[1]))]
  console.log(`期別ファイル ${links.length} 件`)
  const sevenZip = join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe')
  let got = 0
  for (const l of links) {
    const name = l.split('/').pop()
    const dest = join(RAW, name)
    if (!existsSync(dest)) {
      const res = await fetch('https://www.boatrace.jp' + l)
      if (!res.ok) { console.log(`  失敗 ${name}`); continue }
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
      await new Promise((r) => setTimeout(r, 400))
    }
    try { execFileSync(sevenZip, ['x', dest, `-o${EXT}`, '-y'], { windowsHide: true }); got++ } catch {}
  }
  console.log(`展開済み ${got} 件 → ${EXT}`)
}

// ---------- 行を読む ----------
function readLines(file) {
  const buf = readFileSync(file)
  const out = []
  let s = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      let e = i
      if (buf[e - 1] === 0x0d) e--
      if (e - s > 100) out.push(buf.subarray(s, e))
      s = i + 1
    }
  }
  return out
}
const str = (b, a, z) => dec.decode(b.subarray(a, z)).trim()
const num = (b, a, z) => { const v = str(b, a, z); return /^-?\d+$/.test(v) ? Number(v) : null }

/** ファイル名 fan2604.txt -> 2026年後期(04=4月期) の識別子 */
const periodOf = (name) => {
  const m = name.match(/fan(\d{2})(\d{2})/i)
  return m ? `20${m[1]}-${m[2]}` : null
}

// ---------- 投入 ----------
if (argv.includes('--load')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS racer_period (
      period TEXT NOT NULL, racer_id INTEGER NOT NULL,
      name TEXT, kana TEXT, branch TEXT, grade TEXT,
      birth TEXT, sex INTEGER, age INTEGER, height INTEGER, weight INTEGER, blood TEXT,
      win_rate REAL, top2_rate REAL, w1 INTEGER, w2 INTEGER, starts INTEGER,
      raw TEXT,
      PRIMARY KEY (period, racer_id)
    )`)
  const ins = db.prepare(`INSERT INTO racer_period
    (period,racer_id,name,kana,branch,grade,birth,sex,age,height,weight,blood,
     win_rate,top2_rate,w1,w2,starts,raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(period,racer_id) DO UPDATE SET
      name=excluded.name, kana=excluded.kana, branch=excluded.branch, grade=excluded.grade,
      birth=excluded.birth, sex=excluded.sex, age=excluded.age, height=excluded.height,
      weight=excluded.weight, blood=excluded.blood, win_rate=excluded.win_rate,
      top2_rate=excluded.top2_rate, w1=excluded.w1, w2=excluded.w2, starts=excluded.starts,
      raw=excluded.raw`)

  let files = 0, rows = 0
  db.exec('BEGIN')
  for (const f of readdirSync(EXT).filter((x) => /\.txt$/i.test(x))) {
    const period = periodOf(f)
    if (!period) continue
    for (const b of readLines(join(EXT, f))) {
      const id = num(b, 0, 4)
      if (!id) continue
      ins.run(period, id,
        str(b, 4, 20).replace(/　/g, ''), str(b, 20, 35), str(b, 35, 39), str(b, 39, 41),
        str(b, 41, 48), num(b, 48, 49), num(b, 49, 51), num(b, 51, 54), num(b, 54, 56), str(b, 56, 57),
        (num(b, 58, 62) ?? 0) / 100, (num(b, 62, 66) ?? 0) / 10,
        num(b, 66, 69), num(b, 69, 72), num(b, 72, 75),
        dec.decode(b.subarray(75)))   // 未確定部分はそのまま残す
      rows++
    }
    files++
  }
  db.exec('COMMIT')
  console.log(`投入完了: ${files}ファイル / ${rows}行`)
  for (const r of all(`SELECT period, COUNT(*) n FROM racer_period GROUP BY period ORDER BY period DESC LIMIT 6`))
    console.log(`  ${r.period}  ${r.n}人`)

  // 検算：2連対率 =(1着+2着)/出走 が成り立つか
  const chk = all(`SELECT COUNT(*) n,
      SUM(ABS(top2_rate - 100.0*(w1+w2)/starts) < 0.15) ok
    FROM racer_period WHERE starts > 0`)[0]
  console.log(`\n検算 2連対率=(1着+2着)/出走 : ${chk.ok}/${chk.n} 一致`)
}

// ---------- 未確定バイトの特定 ----------
if (argv.includes('--probe')) {
  console.log('=== 75バイト以降の未確定領域を、既存データと突合して特定する ===\n')
  // 番組表の全国勝率・2連率と、期別データを選手単位で突き合わせる
  const prog = new Map()
  for (const r of all(`SELECT racer_id, AVG(win_rate_nat) wr, AVG(top2_nat) t2, COUNT(*) n
    FROM programs WHERE racer_id IS NOT NULL GROUP BY racer_id HAVING n >= 20`))
    prog.set(r.racer_id, r)

  const rows = all(`SELECT racer_id, raw FROM racer_period WHERE period='2026-04'`)
  console.log(`対象 ${rows.length} 人\n`)
  const corr = (pairs) => {
    const n = pairs.length
    if (n < 50) return null
    const mx = pairs.reduce((a, b) => a + b[0], 0) / n
    const my = pairs.reduce((a, b) => a + b[1], 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2 }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null
  }
  // 3桁・4桁の窓を総当たりし、既知量と強く相関する位置を探す
  console.log('開始バイト 幅  →  全国勝率との相関 / 全国2連率との相関   平均値')
  for (let off = 0; off <= 60; off++) {
    for (const w of [3, 4]) {
      const pw = [], pt = [], vals = []
      for (const r of rows) {
        const v = r.raw.slice(off, off + w)
        if (!/^\d+$/.test(v)) { vals.length = 0; break }
        const p = prog.get(r.racer_id)
        vals.push(Number(v))
        if (p) { pw.push([Number(v), p.wr]); pt.push([Number(v), p.t2]) }
      }
      if (!vals.length) continue
      const cw = corr(pw), ct = corr(pt)
      if ((cw !== null && Math.abs(cw) > 0.55) || (ct !== null && Math.abs(ct) > 0.55)) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length
        console.log(`  ${String(75 + off).padStart(3)}   ${w}   勝率 ${cw?.toFixed(3) ?? '  -  '} / 2連率 ${ct?.toFixed(3) ?? '  -  '}   平均${mean.toFixed(1)}`)
      }
    }
  }
}
db.close()
