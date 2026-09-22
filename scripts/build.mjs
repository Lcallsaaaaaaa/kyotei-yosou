// data/extracted/{K,B}/*.TXT を解析して data/boatrace.db (SQLite) に投入する。
// 同じレースを再投入しても上書きされるだけなので、何度実行しても安全。
//
//   node scripts/build.mjs            全ファイル
//   node scripts/build.mjs --since 2026-08-01

import { readdir, readFile, mkdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB_PATH = join(ROOT, 'data', 'boatrace.db')

const decoder = new TextDecoder('shift-jis')

// 全角英数・全角スペース・全角コロンを半角に落とす
const toHalf = (s) =>
  s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/：/g, ':')
    .replace(/．/g, '.')

/** k260816.TXT -> 2026-08-16 （2000年代前提。競走成績は2005年以降しか配布されていない） */
function dateFromFilename(name) {
  const m = basename(name).match(/^[KB](\d{2})(\d{2})(\d{2})\.TXT$/i)
  if (!m) return null
  return `20${m[1]}-${m[2]}-${m[3]}`
}

const raceId = (date, jcd, raceNo) =>
  `${date.replace(/-/g, '')}-${String(jcd).padStart(2, '0')}-${String(raceNo).padStart(2, '0')}`

// ---------------------------------------------------------------- K（競走成績）

const BET_TYPES = {
  単勝: 'tansho',
  複勝: 'fukusho',
  '２連単': 'nirentan',
  '２連複': 'nirenpuku',
  拡連複: 'kakuren',
  '３連単': 'sanrentan',
  '３連複': 'sanrenpuku',
}

function parseRaceHeader(line) {
  // "   1R       一般　　　　      H1800m  曇り  風  南　　 3m  波　  2cm"
  const m = line.match(/^\s+(\d{1,2})R\s+(.*?)\s+[A-Z](\d+)m\s*(.*)$/)
  if (!m) return null
  const tail = toHalf(m[4]).replace(/\s+/g, ' ').trim()

  const wind = tail.match(/風\s*(\S*?)\s*(\d+)\s*m/)
  const wave = tail.match(/波\s*(\d+)\s*cm/)
  const weather = tail.split(' ')[0] || null

  return {
    race_no: Number(m[1]),
    title: m[2].replace(/　/g, '').trim() || null,
    distance: Number(m[3]),
    weather: weather && !weather.startsWith('風') ? weather : null,
    wind_dir: wind && wind[1] ? wind[1] : null,
    wind_speed: wind ? Number(wind[2]) : null,
    wave: wave ? Number(wave[1]) : null,
  }
}

/**
 * 数値スライス。空白のみ・"."のみ等は null。
 * ⚠️ これらのファイルは固定幅であって空白区切りではない。
 *   モーター2率が 100.00 だったり、ボートNOが3桁だと隣の項目と密着する。
 *   （例: 福岡 "43 60.92162 38.10" / 戸田 "8100.00"）
 *   空白分割で読むと場ごと丸ごと落ちるので、必ず桁位置で切ること。
 */
const numAt = (line, from, to) => {
  const v = line.slice(from, to).trim()
  if (!v || !/^-?\d+(\.\d+)?$/.test(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseEntryRow(line) {
  // "  01  1 5213 湯　淺　　紀　香 57   27  6.90   1    0.14     1.52.2"
  //  0 2  6 8    13            21   25    29   35   39        47
  const m = line.match(/^\s{2}(.{2})\s{2}([1-6])\s(\d{4})\s(.{8})/)
  if (!m) return null

  const rankRaw = m[1].trim()
  const stRaw = line.slice(39, 47).trim()

  let stFlag = null
  let stVal = null
  if (stRaw) {
    const f = stRaw.match(/^([FLK])?\.?([\d.]+)$/)
    if (f) {
      stFlag = f[1] ?? null
      const body = f[2].startsWith('.') ? '0' + f[2] : f[2]
      const n = Number(body)
      // "F.06" は「0.06 早すぎた」の意味なので値としては 0.06
      stVal = Number.isFinite(n) && n < 1 ? n : null
    }
  }

  return {
    rank: rankRaw || null,
    rank_num: /^0?[1-6]$/.test(rankRaw) ? Number(rankRaw) : null,
    lane: Number(m[2]),
    racer_id: Number(m[3]),
    racer_name: m[4].replace(/　/g, '').trim(),
    motor_no: numAt(line, 21, 25),
    boat_no: numAt(line, 25, 29),
    exhibition: numAt(line, 29, 35),
    course: numAt(line, 35, 39),
    st: stVal,
    st_flag: stFlag,
    race_time: line.slice(47).trim() || null,
  }
}

function parseK(text, date) {
  const lines = text.split(/\r?\n/)
  const races = []
  const entries = []
  const payouts = []

  let jcd = null
  let cur = null
  let betType = null
  let series = null   // 開催名（例「オールレディース競走」）
  let dayNo = null    // 節の何日目か

  const flush = () => {
    if (cur) races.push(cur)
    cur = null
    betType = null
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const bgn = line.match(/^(\d{2})KBGN/)
    if (bgn) {
      flush()
      jcd = Number(bgn[1])
      // ブロック先頭に開催情報がある：
      //   +1行目 「大　村［成績］  8/16  オールレディース競走  第 5日」
      //   +5行目 開催名のフル表記（+1は20字で切られている）
      const head = lines[li + 1] ?? ''
      const full = lines[li + 5] ?? ''
      const dm = toHalf(head).match(/第\s*(\d+)日/)
      dayNo = dm ? Number(dm[1]) : null
      const f = full.replace(/[　\s]+$/g, '').trim()
      series = f || (head.match(/\s{2,}([^\s].*?)\s{2,}第/)?.[1] ?? '').trim() || null
      continue
    }
    if (/^\d{2}KEND/.test(line)) {
      flush()
      jcd = null
      continue
    }
    if (jcd === null) continue

    // レースヘッダ（距離表記があるものだけ。冒頭の払戻一覧表と区別する）
    if (/^\s+\d{1,2}R\s/.test(line) && /[A-Z]\d+m/.test(line)) {
      const h = parseRaceHeader(line)
      if (h) {
        flush()
        cur = { race_id: raceId(date, jcd, h.race_no), date, jcd, ...h, kimarite: null, series, day_no: dayNo }
      }
      continue
    }
    if (!cur) continue

    // 決まり手はカラムヘッダ行の末尾にある
    if (line.includes('ｽﾀｰﾄﾀｲﾐﾝｸ')) {
      const idx = line.indexOf('ﾚｰｽﾀｲﾑ')
      if (idx > -1) cur.kimarite = line.slice(idx + 6).replace(/　/g, '').trim() || null
      continue
    }

    // 成績行
    const e = parseEntryRow(line)
    if (e) {
      entries.push({ race_id: cur.race_id, ...e })
      continue
    }

    // 払戻行。ラベルが無い継続行（拡連複の2本目など）は直前のラベルを引き継ぐ
    const labeled = line.match(/^\s{8}(単勝|複勝|２連単|２連複|拡連複|３連単|３連複)\s+(.*)$/)
    const cont = line.match(/^\s{17}(\S.*)$/)
    if (labeled || (cont && betType)) {
      if (labeled) betType = BET_TYPES[labeled[1]]
      const body = labeled ? labeled[2] : cont[1]
      // "1-2        290  人気     1" / "1  110  2  130"（複勝は1行に2口）
      const re = /([\d\-=]+)\s+(\d+)(?:\s+人気\s+(\d+))?/g
      let mm
      while ((mm = re.exec(body))) {
        payouts.push({
          race_id: cur.race_id,
          bet_type: betType,
          combo: mm[1],
          amount: Number(mm[2]),
          popularity: mm[3] ? Number(mm[3]) : null,
        })
      }
      continue
    }
  }
  flush()
  return { races, entries, payouts }
}

// ---------------------------------------------------------------- B（番組表）

function parseProgramRow(line) {
  // "1 5213湯淺紀香27群馬46B1 5.16 33.33 4.07 22.22 57 37.78 27 31.11 154 251      9"
  //  0 2   6   10  12  14 16 18   23    29   34    40 43    49 52
  //
  // ⚠️ 空白区切りで読んではいけない。実例：
  //   福岡 "43 60.92162 38.10" … ボートNO 162 が モーター2率 と密着
  //   戸田 "  8100.00 15"      … モーター2率 100.00 が モーターNO と密着
  if (!/^[1-6]\s\d{4}/.test(line)) return null

  const grade = line.slice(16, 18).trim()
  const branch = line.slice(12, 14).trim()

  const row = {
    lane: Number(line[0]),
    racer_id: numAt(line, 2, 6),
    racer_name: line.slice(6, 10).replace(/　/g, '').trim(),
    age: numAt(line, 10, 12),
    branch: branch || null,
    weight: numAt(line, 14, 16),
    grade: grade || null,
    win_rate_nat: numAt(line, 18, 23),
    top2_nat: numAt(line, 23, 29),
    win_rate_loc: numAt(line, 29, 34),
    top2_loc: numAt(line, 34, 40),
    motor_no: numAt(line, 40, 43),
    motor_top2: numAt(line, 43, 49),
    boat_no: numAt(line, 49, 52),
    boat_top2: numAt(line, 52, 58),
    // 58桁目以降に「今節成績」と「早見」がある。
    // 今節成績は日ごとの着順を並べたもの（例 "154 251" = 1日目1着5着4着 / 2日目2着5着1着）。
    // その節で今どれだけ来ているかを直接示す情報なので必ず取る。
    // 桁は 58〜70 が今節成績、71〜72 が早見。行長は常に73。
    // 70桁目まで成績が伸びる日があるので、早見を70から切ると成績の末尾を拾って3桁になる。
    series_result: line.slice(58, 71).trim() || null,
    hayami: numAt(line, 71, 73),
  }
  // 登番とモーターが取れない行は番組行ではない
  if (row.racer_id === null || row.motor_no === null) return null
  return row
}

function parseB(text, date) {
  const lines = text.split(/\r?\n/)
  const programs = []
  const deadlines = []
  let jcd = null
  let raceNo = null

  for (const line of lines) {
    const bgn = line.match(/^(\d{2})BBGN/)
    if (bgn) {
      jcd = Number(bgn[1])
      raceNo = null
      continue
    }
    if (/^\d{2}BEND/.test(line)) {
      jcd = null
      raceNo = null
      continue
    }
    if (jcd === null) continue

    const half = toHalf(line)
    const h = half.match(/^\s*(\d{1,2})R\s/)
    if (h && /\d+m/.test(half)) {
      raceNo = Number(h[1])
      const dl = half.match(/締切予定\s*(\d{1,2}:\d{2})/)
      if (dl) deadlines.push({ race_id: raceId(date, jcd, raceNo), deadline: dl[1] })
      continue
    }
    if (raceNo === null) continue

    const p = parseProgramRow(line)
    if (p) programs.push({ race_id: raceId(date, jcd, raceNo), ...p })
  }
  return { programs, deadlines }
}

// ---------------------------------------------------------------- DB

function openDb() {
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA busy_timeout = 120000')
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS races (
      race_id    TEXT PRIMARY KEY,
      date       TEXT NOT NULL,
      jcd        INTEGER NOT NULL,
      race_no    INTEGER NOT NULL,
      title      TEXT,
      distance   INTEGER,
      weather    TEXT,
      wind_dir   TEXT,
      wind_speed INTEGER,
      wave       INTEGER,
      kimarite   TEXT,
      deadline   TEXT,
      series     TEXT,
      day_no     INTEGER
    );

    CREATE TABLE IF NOT EXISTS entries (
      race_id    TEXT NOT NULL,
      lane       INTEGER NOT NULL,
      rank       TEXT,
      rank_num   INTEGER,
      racer_id   INTEGER,
      racer_name TEXT,
      motor_no   INTEGER,
      boat_no    INTEGER,
      exhibition REAL,
      course     INTEGER,
      st         REAL,
      st_flag    TEXT,
      race_time  TEXT,
      PRIMARY KEY (race_id, lane)
    );

    CREATE TABLE IF NOT EXISTS payouts (
      race_id    TEXT NOT NULL,
      bet_type   TEXT NOT NULL,
      combo      TEXT NOT NULL,
      amount     INTEGER,
      popularity INTEGER,
      PRIMARY KEY (race_id, bet_type, combo)
    );

    CREATE TABLE IF NOT EXISTS programs (
      race_id      TEXT NOT NULL,
      lane         INTEGER NOT NULL,
      racer_id     INTEGER,
      racer_name   TEXT,
      age          INTEGER,
      branch       TEXT,
      weight       INTEGER,
      grade        TEXT,
      win_rate_nat REAL,
      top2_nat     REAL,
      win_rate_loc REAL,
      top2_loc     REAL,
      motor_no     INTEGER,
      motor_top2   REAL,
      boat_no      INTEGER,
      boat_top2    REAL,
      series_result TEXT,
      hayami       INTEGER,
      PRIMARY KEY (race_id, lane)
    );

    CREATE INDEX IF NOT EXISTS idx_races_date   ON races(date);
    CREATE INDEX IF NOT EXISTS idx_races_jcd    ON races(jcd, date);
    CREATE INDEX IF NOT EXISTS idx_entries_racer ON entries(racer_id, course);
    CREATE INDEX IF NOT EXISTS idx_entries_course ON entries(course, rank_num);
    CREATE INDEX IF NOT EXISTS idx_programs_racer ON programs(racer_id);
  `)
  return db
}

async function main() {
  await mkdir(join(ROOT, 'data'), { recursive: true })
  const sinceIdx = process.argv.indexOf('--since')
  const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : null

  const db = openDb()

  const insRace = db.prepare(`INSERT INTO races
    (race_id,date,jcd,race_no,title,distance,weather,wind_dir,wind_speed,wave,kimarite,series,day_no)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(race_id) DO UPDATE SET
      title=excluded.title, distance=excluded.distance, weather=excluded.weather,
      wind_dir=excluded.wind_dir, wind_speed=excluded.wind_speed, wave=excluded.wave,
      kimarite=excluded.kimarite, series=excluded.series, day_no=excluded.day_no`)

  const insEntry = db.prepare(`INSERT INTO entries
    (race_id,lane,rank,rank_num,racer_id,racer_name,motor_no,boat_no,exhibition,course,st,st_flag,race_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(race_id,lane) DO UPDATE SET
      rank=excluded.rank, rank_num=excluded.rank_num, racer_id=excluded.racer_id,
      racer_name=excluded.racer_name, motor_no=excluded.motor_no, boat_no=excluded.boat_no,
      exhibition=excluded.exhibition, course=excluded.course, st=excluded.st,
      st_flag=excluded.st_flag, race_time=excluded.race_time`)

  const insPayout = db.prepare(`INSERT INTO payouts (race_id,bet_type,combo,amount,popularity)
    VALUES (?,?,?,?,?)
    ON CONFLICT(race_id,bet_type,combo) DO UPDATE SET
      amount=excluded.amount, popularity=excluded.popularity`)

  const insProgram = db.prepare(`INSERT INTO programs
    (race_id,lane,racer_id,racer_name,age,branch,weight,grade,
     win_rate_nat,top2_nat,win_rate_loc,top2_loc,motor_no,motor_top2,boat_no,boat_top2,series_result,hayami)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(race_id,lane) DO UPDATE SET
      racer_id=excluded.racer_id, racer_name=excluded.racer_name, age=excluded.age,
      branch=excluded.branch, weight=excluded.weight, grade=excluded.grade,
      win_rate_nat=excluded.win_rate_nat, top2_nat=excluded.top2_nat,
      win_rate_loc=excluded.win_rate_loc, top2_loc=excluded.top2_loc,
      motor_no=excluded.motor_no, motor_top2=excluded.motor_top2,
      boat_no=excluded.boat_no, boat_top2=excluded.boat_top2,
      series_result=excluded.series_result, hayami=excluded.hayami`)

  const setDeadline = db.prepare(`UPDATE races SET deadline=? WHERE race_id=?`)

  const stat = { kFiles: 0, bFiles: 0, races: 0, entries: 0, payouts: 0, programs: 0, errors: 0 }

  for (const kind of ['K', 'B']) {
    const dir = join(ROOT, 'data', 'extracted', kind)
    let files
    try {
      files = (await readdir(dir)).filter((f) => f.toUpperCase().endsWith('.TXT')).sort()
    } catch {
      console.log(`${kind}: data/extracted/${kind} が無いので飛ばします`)
      continue
    }

    for (const f of files) {
      const date = dateFromFilename(f)
      if (!date) continue
      if (since && date < since) continue

      let text
      try {
        text = decoder.decode(await readFile(join(dir, f)))
      } catch (e) {
        stat.errors++
        console.error(`  読込失敗 ${f}: ${e.message}`)
        continue
      }

      try {
        db.exec('BEGIN')
        if (kind === 'K') {
          const { races, entries, payouts } = parseK(text, date)
          for (const r of races) {
            insRace.run(r.race_id, r.date, r.jcd, r.race_no, r.title, r.distance,
              r.weather, r.wind_dir, r.wind_speed, r.wave, r.kimarite, r.series, r.day_no)
          }
          for (const e of entries) {
            insEntry.run(e.race_id, e.lane, e.rank, e.rank_num, e.racer_id, e.racer_name,
              e.motor_no, e.boat_no, e.exhibition, e.course, e.st, e.st_flag, e.race_time)
          }
          for (const p of payouts) {
            insPayout.run(p.race_id, p.bet_type, p.combo, p.amount, p.popularity)
          }
          stat.kFiles++
          stat.races += races.length
          stat.entries += entries.length
          stat.payouts += payouts.length
        } else {
          const { programs, deadlines } = parseB(text, date)
          for (const p of programs) {
            insProgram.run(p.race_id, p.lane, p.racer_id, p.racer_name, p.age, p.branch,
              p.weight, p.grade, p.win_rate_nat, p.top2_nat, p.win_rate_loc, p.top2_loc,
              p.motor_no, p.motor_top2, p.boat_no, p.boat_top2, p.series_result, p.hayami)
          }
          for (const d of deadlines) setDeadline.run(d.deadline, d.race_id)
          stat.bFiles++
          stat.programs += programs.length
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        stat.errors++
        console.error(`  解析失敗 ${f}: ${e.message}`)
      }

      const n = stat.kFiles + stat.bFiles
      if (n % 50 === 0) console.log(`  ${n}ファイル処理`)
    }
  }

  console.log(`\n=== 投入完了 ===`)
  console.log(`Kファイル ${stat.kFiles} / Bファイル ${stat.bFiles} / エラー ${stat.errors}`)
  console.log(`races ${stat.races} / entries ${stat.entries} / payouts ${stat.payouts} / programs ${stat.programs}`)

  const q = (sql) => db.prepare(sql).get()
  console.log(`\n=== DB 実数 ===`)
  console.log('races   :', q('SELECT COUNT(*) c FROM races').c)
  console.log('entries :', q('SELECT COUNT(*) c FROM entries').c)
  console.log('payouts :', q('SELECT COUNT(*) c FROM payouts').c)
  console.log('programs:', q('SELECT COUNT(*) c FROM programs').c)
  const range = q('SELECT MIN(date) a, MAX(date) b FROM races')
  console.log('期間    :', range.a, '〜', range.b)

  // ANALYZE を忘れるとプランナが結合順を誤り、集計が数分単位で詰まる。必ず流す。
  // ★--no-analyze で飛ばせる（2026-09-12に追加）。
  //   DBが育って13分（786秒）かかるようになり、02:00のバッチが長引いた末に
  //   スリープで強制終了された。当日の番組表を足すだけの回は統計がほとんど動かない。
  //   ⚠ 前日の結果を取り込む 05:00(night.sh) と 15:00(catchup.sh) では**必ず流すこと**。
  if (process.argv.includes('--no-analyze')) {
    console.log('ANALYZE は飛ばした（--no-analyze）')
    db.close(); return
  }
  process.stdout.write('\nANALYZE 実行中... ')
  const t0 = Date.now()
  db.exec('ANALYZE')
  console.log(`${Date.now() - t0}ms`)
  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
