// 分析結果と過去データを、表計算ソフトで開けるCSVに書き出す。
//
//   node scripts/export.mjs            全部書き出す
//   node scripts/export.mjs --list     何が書き出せるか一覧
//
// ★文字コード
//   UTF-8 の先頭にBOMを付ける。これが無いと日本語版Excelで開いたとき文字化けする
//   （Excelは既定でShift-JISとして読むため）。BOMがあればExcelもGoogleスプレッドシートも
//   両方そのまま開ける。
//
// ★行数の目安
//   Excel は約104万行、Googleスプレッドシートは1000万セルが上限。
//   艇単位の明細（21万行×12列＝約250万セル）は両方に入る。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'export')
const db = new DatabaseSync(join(ROOT, 'data', 'boatrace.db'))
db.exec('PRAGMA busy_timeout = 300000')
const all = (s, ...p) => db.prepare(s).all(...p)
const argv = process.argv.slice(2)

const VENUE = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国',
  'びわこ', '住之江', '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

/** CSVの1セルを安全にする。カンマ・改行・引用符を含む値を壊さない */
const cell = (v) => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
const write = (name, header, rows) => {
  mkdirSync(OUT, { recursive: true })
  const body = [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')
  writeFileSync(join(OUT, name), '﻿' + body, 'utf8')   // 先頭のBOMがExcelの文字化けを防ぐ
  console.log(`  ${name.padEnd(28)} ${rows.length.toLocaleString()}行`)
}

const TABLES = [
  {
    name: '01_レース結果.csv',
    desc: '1レース1行。着順・気象・払戻',
    run: () => {
      const rows = all(`
        SELECT r.date, r.jcd, r.race_no, r.grade, r.title, r.series, r.day_no,
               r.weather, r.wind_dir, r.wind_speed, r.wave, r.kimarite, r.deadline,
               (SELECT lane FROM entries e WHERE e.race_id=r.race_id AND e.rank_num=1) w1,
               (SELECT lane FROM entries e WHERE e.race_id=r.race_id AND e.rank_num=2) w2,
               (SELECT lane FROM entries e WHERE e.race_id=r.race_id AND e.rank_num=3) w3,
               (SELECT amount FROM payouts p WHERE p.race_id=r.race_id AND p.bet_type='sanrentan') p3t,
               (SELECT amount FROM payouts p WHERE p.race_id=r.race_id AND p.bet_type='sanrenpuku') p3f,
               (SELECT amount FROM payouts p WHERE p.race_id=r.race_id AND p.bet_type='tansho') ptan
        FROM races r WHERE r.date >= '2025-08-18' ORDER BY r.date, r.jcd, r.race_no`)
      return {
        header: ['日付', '場', 'R', 'グレード', 'レース名', '開催名', '日目', '天候', '風向', '風速m', '波高cm',
          '決まり手', '締切', '1着枠', '2着枠', '3着枠', '3連単払戻', '3連複払戻', '単勝払戻'],
        rows: rows.map((r) => [r.date, VENUE[r.jcd] ?? r.jcd, r.race_no, r.grade, r.title, r.series, r.day_no,
          r.weather, r.wind_dir, r.wind_speed, r.wave, r.kimarite, r.deadline,
          r.w1, r.w2, r.w3, r.p3t, r.p3f, r.ptan]),
      }
    },
  },
  {
    name: '02_出走明細.csv',
    desc: '1艇1行。選手・モーター・展示・結果',
    run: () => {
      const rows = all(`
        SELECT r.date, r.jcd, r.race_no, r.grade, e.lane, e.racer_id, e.racer_name,
               p.age, p.branch, p.grade AS cls, p.weight,
               p.win_rate_nat, p.top2_nat, p.win_rate_loc, p.top2_loc,
               e.motor_no, p.motor_top2, e.boat_no, p.boat_top2,
               f.bf_ex_time, f.bf_ex_rank, f.bf_tilt, f.bf_parts,
               e.course, e.st, e.st_flag, e.rank_num
        FROM entries e
        JOIN races r ON r.race_id = e.race_id
        LEFT JOIN programs p ON p.race_id = e.race_id AND p.lane = e.lane
        LEFT JOIN feat f ON f.race_id = e.race_id AND f.lane = e.lane
        WHERE r.date >= '2025-08-18' ORDER BY r.date, r.jcd, r.race_no, e.lane`)
      return {
        header: ['日付', '場', 'R', 'グレード', '枠', '登番', '選手名', '年齢', '支部', '級別', '体重',
          '全国勝率', '全国2連率', '当地勝率', '当地2連率', 'モーター', 'モーター2連率', 'ボート', 'ボート2連率',
          '展示タイム', '展示順位', 'チルト', '部品交換', '進入コース', 'ST', 'ST異常', '着順'],
        rows: rows.map((r) => [r.date, VENUE[r.jcd] ?? r.jcd, r.race_no, r.grade, r.lane, r.racer_id, r.racer_name,
          r.age, r.branch, r.cls, r.weight, r.win_rate_nat, r.top2_nat, r.win_rate_loc, r.top2_loc,
          r.motor_no, r.motor_top2, r.boat_no, r.boat_top2,
          r.bf_ex_time, r.bf_ex_rank, r.bf_tilt, r.bf_parts, r.course, r.st, r.st_flag, r.rank_num]),
      }
    },
  },
  {
    name: '03_予想と結果.csv',
    desc: '歩進検証の予想・単勝オッズ・的中',
    run: () => {
      const rows = all(`
        SELECT w.month, r.date, r.jcd, r.race_no, r.grade, w.lane, e.racer_name,
               ROUND(w.p, 4) p, t.tansho, w.y, e.rank_num
        FROM we1 w
        JOIN races r ON r.race_id = w.race_id
        LEFT JOIN entries e ON e.race_id = w.race_id AND e.lane = w.lane
        LEFT JOIN odds_tan t ON t.race_id = w.race_id AND t.lane = w.lane
        ORDER BY r.date, r.jcd, r.race_no, w.lane`)
      return {
        header: ['月', '日付', '場', 'R', 'グレード', '枠', '選手名', 'モデル1着確率', '単勝オッズ', '1着だったか', '着順'],
        rows: rows.map((r) => [r.month, r.date, VENUE[r.jcd] ?? r.jcd, r.race_no, r.grade, r.lane, r.racer_name,
          r.p, r.tansho, r.y, r.rank_num]),
      }
    },
  },
  {
    name: '04_選手別集計.csv',
    desc: '選手ごとの成績・コース別1着率',
    run: () => {
      const rows = all(`
        SELECT e.racer_id, e.racer_name,
               (SELECT branch FROM programs p WHERE p.racer_id=e.racer_id ORDER BY p.race_id DESC LIMIT 1) branch,
               (SELECT grade  FROM programs p WHERE p.racer_id=e.racer_id ORDER BY p.race_id DESC LIMIT 1) cls,
               COUNT(*) n,
               ROUND(100.0*AVG(e.rank_num=1),2) p1,
               ROUND(100.0*AVG(e.rank_num<=2),2) p2,
               ROUND(100.0*AVG(e.rank_num<=3),2) p3,
               ROUND(AVG(e.st),3) st,
               SUM(e.st_flag='F') f,
               ${[1, 2, 3, 4, 5, 6].map((c) => `ROUND(100.0*AVG(CASE WHEN e.course=${c} THEN (e.rank_num=1) END),1) c${c}`).join(', ')}
        FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date >= '2025-08-18' AND e.rank_num IS NOT NULL AND e.racer_id IS NOT NULL
        GROUP BY e.racer_id HAVING n >= 10 ORDER BY p1 DESC`)
      return {
        header: ['登番', '選手名', '支部', '級別', '走数', '1着率%', '2連対率%', '3連対率%', '平均ST', 'F回数',
          '1コース1着率%', '2コース', '3コース', '4コース', '5コース', '6コース'],
        rows: rows.map((r) => [r.racer_id, r.racer_name, r.branch, r.cls, r.n, r.p1, r.p2, r.p3, r.st, r.f,
          r.c1, r.c2, r.c3, r.c4, r.c5, r.c6]),
      }
    },
  },
  {
    name: '05_場コース別.csv',
    desc: '競艇場×コースの成績と決まり手',
    run: () => {
      const rows = all(`
        SELECT r.jcd, e.course, COUNT(*) n,
               ROUND(100.0*AVG(e.rank_num=1),2) p1,
               ROUND(100.0*AVG(e.rank_num<=2),2) p2,
               ROUND(100.0*AVG(e.rank_num<=3),2) p3,
               ROUND(AVG(e.st),3) st,
               ${['逃げ', 'まくり', 'まくり差し', '差し', '抜き', '恵まれ'].map((k) =>
        `SUM(CASE WHEN e.rank_num=1 AND r.kimarite='${k}' THEN 1 ELSE 0 END) k${['逃げ', 'まくり', 'まくり差し', '差し', '抜き', '恵まれ'].indexOf(k)}`).join(', ')}
        FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date >= '2025-08-18' AND e.course BETWEEN 1 AND 6 AND e.rank_num IS NOT NULL
        GROUP BY r.jcd, e.course ORDER BY r.jcd, e.course`)
      return {
        header: ['場', 'コース', '走数', '1着率%', '2連対率%', '3連対率%', '平均ST',
          '逃げ', 'まくり', 'まくり差し', '差し', '抜き', '恵まれ'],
        rows: rows.map((r) => [VENUE[r.jcd] ?? r.jcd, r.course, r.n, r.p1, r.p2, r.p3, r.st,
          r.k0, r.k1, r.k2, r.k3, r.k4, r.k5]),
      }
    },
  },
  {
    name: '06_条件別の成績.csv',
    desc: 'グレード・波・風・日目×コース',
    run: () => {
      const q = (label, expr) => all(`
        SELECT '${label}' AS kind, ${expr} AS cond, e.course, COUNT(*) n,
               ROUND(100.0*AVG(e.rank_num=1),2) p1, ROUND(100.0*AVG(e.rank_num<=3),2) p3
        FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date >= '2025-08-18' AND e.course BETWEEN 1 AND 6 AND e.rank_num IS NOT NULL
        GROUP BY cond, e.course HAVING n >= 50`)
      const rows = [
        ...q('グレード', 'r.grade'),
        ...q('波高', `CASE WHEN r.wave<=2 THEN '0-2cm' WHEN r.wave<=5 THEN '3-5cm' WHEN r.wave<=9 THEN '6-9cm' ELSE '10cm以上' END`),
        ...q('風速', `CASE WHEN r.wind_speed<=1 THEN '0-1m' WHEN r.wind_speed<=3 THEN '2-3m' WHEN r.wind_speed<=5 THEN '4-5m' ELSE '6m以上' END`),
        ...q('日目', `'第'||r.day_no||'日'`),
        ...q('レース番号', `r.race_no||'R'`),
      ]
      return {
        header: ['区分', '条件', 'コース', '走数', '1着率%', '3連対率%'],
        rows: rows.map((r) => [r.kind, r.cond, r.course, r.n, r.p1, r.p3]),
      }
    },
  },
  {
    name: '07_モーター別.csv',
    desc: '場×モーター番号の成績',
    run: () => {
      const rows = all(`
        SELECT r.jcd, e.motor_no, COUNT(*) n,
               ROUND(100.0*AVG(e.rank_num=1),2) p1,
               ROUND(100.0*AVG(e.rank_num<=2),2) p2,
               ROUND(100.0*AVG(e.rank_num<=3),2) p3,
               ROUND(AVG(e.exhibition),3) ex
        FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date >= '2025-08-18' AND e.rank_num IS NOT NULL AND e.motor_no IS NOT NULL
        GROUP BY r.jcd, e.motor_no HAVING n >= 20 ORDER BY r.jcd, p3 DESC`)
      return {
        header: ['場', 'モーター番号', '走数', '1着率%', '2連対率%', '3連対率%', '平均展示タイム'],
        rows: rows.map((r) => [VENUE[r.jcd] ?? r.jcd, r.motor_no, r.n, r.p1, r.p2, r.p3, r.ex]),
      }
    },
  },
]

if (argv.includes('--list')) {
  console.log('書き出せるもの:')
  for (const t of TABLES) console.log(`  ${t.name.padEnd(24)} ${t.desc}`)
  db.close(); process.exit(0)
}

console.log(`=== CSV書き出し → ${OUT} ===`)
for (const t of TABLES) {
  try {
    const { header, rows } = t.run()
    write(t.name, header, rows)
  } catch (e) {
    console.log(`  ${t.name.padEnd(28)} 失敗: ${e.message}`)
  }
}
console.log('\n文字コードは UTF-8（BOM付き）。ExcelでもGoogleスプレッドシートでもそのまま開ける。')
db.close()
