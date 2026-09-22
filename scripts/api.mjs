// 凪の予想配信 データAPI（v1）。Webサイト（デザインはGPTが作る）と、将来のアプリが同じ窓口から読む。
//
//   status.mjs が /api/ で始まるURLをここへ回す。一覧は http://localhost:3940/api/v1
//   仕様書は「API仕様.md」。項目を変えたら必ずそちらも直すこと。
//
// ★作りの決まり（2026-09-21）
//   ・読むだけ。DBは readOnly で開き、記録には一切書かない。
//   ・数字は記録（*_daily）と予想ファイル（data/predict-<日付>.json）から作る。
//     画面・note記事・JSONで同じ買い目になるよう、ここで作り直したりしない。
//   ・**有料の買い目は prediction / picks に分けて access:"paid" と書く**。
//     noteで1点200円・月額1000円で売っている中身なので、公開するときはここを外す。
//   ・後出し（締切後に入った記録）は late_records に移してあるので、ここには出てこない。
//   ・時刻はすべて日本時間。toISOString は UTC なので直接使わない。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DBP = join(ROOT, 'data', 'boatrace.db')
export const API_VERSION = '1.0'
const VENUE = ['', '桐生', '戸田', '江戸川', '平和島', '多摩川', '浜名湖', '蒲郡', '常滑', '津', '三国',
  'びわこ', '住之江', '尼崎', '鳴門', '丸亀', '児島', '宮島', '徳山', '下関', '若松', '芦屋', '福岡', '唐津', '大村']

// ---------- 小道具 ----------
const jst = () => new Date(Date.now() + 9 * 3600e3)
const today = () => jst().toISOString().slice(0, 10)
const nowHM = () => jst().toISOString().slice(11, 16)
const jstStamp = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : null)
const ymd = (d) => d.replace(/-/g, '')
const r1 = (v) => (v == null ? null : Math.round(v * 1000) / 10)          // 確率 → %（小数1桁）
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100)
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null)
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''))
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
function open() {
  const db = new DatabaseSync(DBP, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
const has = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)

// 重い集計は時間で覚えておく（選手・場・決まり手の表）
const CACHE = new Map()
function cached(key, ttlMs, fn) {
  const c = CACHE.get(key)
  if (c && Date.now() - c.t < ttlMs) return c.v
  const v = fn()
  CACHE.set(key, { t: Date.now(), v })
  if (CACHE.size > 3000) CACHE.delete(CACHE.keys().next().value)
  return v
}
const HOUR = 3600e3

// ---------- 予想ファイル ----------
function loadPred(date) {
  const f = join(ROOT, 'data', `predict-${date}.json`)
  if (!existsSync(f)) return null
  const m = statSync(f).mtimeMs
  return cached('pred|' + date + '|' + m, 12 * HOUR, () => JSON.parse(readFileSync(f, 'utf8')))
}

// ---------- 枠→決まり手の実測表（直近1年）と枠別の平均ST ----------
function kmTable(db) {
  return cached('km|' + today(), 24 * HOUR, () => {
    const from = addDays(today(), -365)
    const km = new Map()
    const rows = db.prepare(`SELECT e.lane, r.kimarite k, COUNT(*) n FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE e.rank_num=1 AND r.date>=? AND r.kimarite IS NOT NULL GROUP BY e.lane, r.kimarite`).all(from)
    const by = new Map()
    for (const x of rows) { if (!by.has(x.lane)) by.set(x.lane, []); by.get(x.lane).push(x) }
    for (const [l, v] of by) { const t = v.reduce((a, x) => a + x.n, 0); km.set(l, new Map(v.map((x) => [x.k, x.n / t]))) }
    const laneSt = new Map(db.prepare(`SELECT lane, AVG(st) a FROM entries WHERE st>0 AND st<1 AND race_id>=? GROUP BY lane`)
      .all(ymd(from)).map((r) => [r.lane, r.a]))
    return { km, laneSt }
  })
}

// ---------- 出走表（番組表＋選手名の正＋平均ST・F） ----------
function entriesOf(db, date) {
  return cached('ent|' + date, 6 * HOUR, () => {
    const out = new Map()
    const rows = db.prepare(`SELECT race_id, lane, racer_id, racer_name, age, branch, weight, grade,
      win_rate_nat, top2_nat, win_rate_loc, top2_loc, motor_no, motor_top2, boat_no, boat_top2, series_result
      FROM programs WHERE race_id BETWEEN ? AND ? ORDER BY race_id, lane`).all(ymd(date) + '-', ymd(date) + '-~')
    // ⚠ programs.racer_name は4文字固定幅で長い名前が切れる。racer_period から引く（racecard.mjs と同じ）
    const qN = db.prepare(`SELECT name, kana FROM racer_period WHERE racer_id=? AND period<=? ORDER BY period DESC LIMIT 1`)
    const qN2 = db.prepare(`SELECT name, kana FROM racer_period WHERE racer_id=? ORDER BY period DESC LIMIT 1`)
    // ★平均ST（直近60走）とF回数（過去180日）は、当日の全選手ぶんを1回の問い合わせでまとめて取る。
    //   1人ずつ聞くと936人で59秒かかり、その間は確認画面ごと止まった（2026-09-21に実測）。
    //   race_id は 'YYYYMMDD-..' なので、日付の範囲は race_id の文字列で絞れる（races を結ばずに済む）。
    const ids = [...new Set(rows.map((r) => r.racer_id).filter((x) => x != null))]
    const stOf = new Map(), fOf = new Map()
    const lo = ymd(addDays(date, -365)), lo180 = ymd(addDays(date, -180)), hi = ymd(date)
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400), q = chunk.map(() => '?').join(',')
      for (const e of db.prepare(`SELECT racer_id, race_id, st, st_flag FROM entries
        WHERE racer_id IN (${q}) AND race_id >= ? AND race_id < ? ORDER BY race_id DESC`).iterate(...chunk, lo, hi)) {
        if (e.st > 0 && e.st < 1) {
          const a = stOf.get(e.racer_id) ?? { s: 0, n: 0 }
          if (a.n < 60) { a.s += e.st; a.n++; stOf.set(e.racer_id, a) }
        }
        if (e.st_flag === 'F' && e.race_id >= lo180) fOf.set(e.racer_id, (fOf.get(e.racer_id) ?? 0) + 1)
      }
    }
    const racer = new Map()
    for (const r of rows) {
      if (r.racer_id != null && !racer.has(r.racer_id)) {
        const n = qN.get(r.racer_id, date.slice(0, 7)) ?? qN2.get(r.racer_id)
        const s = stOf.get(r.racer_id)
        racer.set(r.racer_id, { name: n?.name ?? null, kana: n?.kana ?? null,
          avg_st: s && s.n >= 5 ? r2(s.s / s.n) : null, f_count: fOf.get(r.racer_id) ?? 0 })
      }
      const x = racer.get(r.racer_id) ?? {}
      if (!out.has(r.race_id)) out.set(r.race_id, [])
      out.get(r.race_id).push({
        lane: r.lane, racer_id: r.racer_id, name: x.name ?? r.racer_name, kana: x.kana ?? null,
        class: r.grade, age: r.age, branch: r.branch, weight: r.weight,
        win_rate_national: r.win_rate_nat, top2_rate_national: r.top2_nat,
        win_rate_local: r.win_rate_loc, top2_rate_local: r.top2_loc,
        motor_no: r.motor_no, motor_top2_rate: r.motor_top2, boat_no: r.boat_no, boat_top2_rate: r.boat_top2,
        avg_st: x.avg_st ?? null, f_count: x.f_count ?? 0, series_result: r.series_result ?? null,
      })
    }
    return out
  })
}

// ---------- レースの基本情報 ----------
function metaOf(db, date) {
  const m = new Map()
  for (const r of db.prepare(`SELECT race_id, jcd, race_no, deadline, series, day_no, grade, title FROM races WHERE date=?`).all(date))
    m.set(r.race_id, { ...r })
  if (has(db, 'race_meta'))
    for (const r of db.prepare(`SELECT race_id, jcd, race_no, deadline, title, day_no, series, series_len FROM race_meta WHERE date=?`).all(date)) {
      const a = m.get(r.race_id) ?? {}
      m.set(r.race_id, { ...r, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)), series_len: r.series_len })
    }
  return m
}

// ---------- 結果 ----------
function resultsOf(db, date) {
  const res = new Map()
  if (has(db, 'result_live'))
    for (const r of db.prepare(`SELECT * FROM result_live WHERE date=?`).all(date)) {
      let pays = null
      try { pays = r.pays ? JSON.parse(r.pays) : null } catch { /* 壊れていれば出さない */ }
      res.set(r.race_id, r.status === 'cancel' ? { cancelled: true }
        : { order: [r.lane1, r.lane2, r.lane3].join('-'), order_all: r.order_all ?? null, kimarite: r.kimarite ?? null,
            trifecta_payout: r.sanrentan_pay, trio_payout: r.sanrenpuku_pay, win_payout: r.tansho_pay,
            payouts: pays ? Object.fromEntries(Object.entries(pays).map(([k, v]) => [k, { combo: v.combo.split('-').join(v.sep ?? '-'), amount: v.amount }])) : null,
            source: '速報' })
    }
  // 競走成績（Kファイル）があればそちらが正。6着までの並びと全券種の払戻も付ける
  const k = new Map()
  for (const r of db.prepare(`SELECT e.race_id, e.lane, e.rank_num, r.kimarite FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE r.date=? AND e.rank_num BETWEEN 1 AND 6`).all(date)) {
    let a = k.get(r.race_id); if (!a) { a = { km: r.kimarite }; k.set(r.race_id, a) }
    a[r.rank_num] = r.lane
  }
  const BT = { tansho: '単勝', fukusho: '複勝', nirentan: '2連単', nirenpuku: '2連複', kakuren: '拡連複', sanrentan: '3連単', sanrenpuku: '3連複' }
  const SEP = { nirenpuku: '=', kakuren: '=', sanrenpuku: '=' }
  const pay = new Map()
  for (const r of db.prepare(`SELECT p.race_id, p.bet_type, p.combo, p.amount FROM payouts p JOIN races r ON r.race_id=p.race_id
    WHERE r.date=? AND p.amount IS NOT NULL`).all(date)) {
    if (!pay.has(r.race_id)) pay.set(r.race_id, {})
    const o = pay.get(r.race_id), name = BT[r.bet_type] ?? r.bet_type
    const v = { combo: String(r.combo).split('-').join(SEP[r.bet_type] ?? '-'), amount: r.amount }
    if (o[name]) { o[name] = Array.isArray(o[name]) ? [...o[name], v] : [o[name], v] } else o[name] = v   // 複勝・拡連複は複数
  }
  const one = (o, n) => (o?.[n] ? (Array.isArray(o[n]) ? o[n][0].amount : o[n].amount) : null)
  for (const [id, a] of k) {
    if (!a[1] || !a[2] || !a[3]) continue
    const o = pay.get(id)
    res.set(id, { order: `${a[1]}-${a[2]}-${a[3]}`, order_all: [1, 2, 3, 4, 5, 6].map((n) => a[n] ?? '-').join('-'), kimarite: a.km ?? null,
      win_payout: one(o, '単勝'), trifecta_payout: one(o, '3連単'), trio_payout: one(o, '3連複'), payouts: o ?? null, source: '競走成績' })
  }
  return res
}

// ---------- 展開予想 ----------
// 1着の枠が決まれば決まり手はほぼ決まる（直近1年の実測）ので、
// 「枠ごとの1着確率 × その枠の決まり手分布」の和を決まり手の確率にする（tenkai.mjs と同じ変換）。
function tenkaiOf(db, pr, ents) {
  if (!pr?.first?.length) return null
  const { km: KM, laneSt } = kmTable(db)
  const km = new Map()
  for (const b of pr.first) {
    const d = KM.get(b.lane); if (!d) continue
    for (const [k, p] of d) km.set(k, (km.get(k) ?? 0) + b.p * p)
  }
  const move = (lane) => { const d = KM.get(lane); return d ? [...d].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null }
  const ent = (lane) => ents?.find((e) => e.lane === lane)
  const stNote = (lane) => {
    const s = ent(lane)?.avg_st, base = laneSt.get(lane)
    if (s == null || base == null) return null
    const d = s - base
    return d <= -0.012 ? '速い' : d >= 0.012 ? '遅め' : '普通'
  }
  const sorted = [...pr.first].sort((a, b) => b.p - a.p)
  const role = (b, label) => b && ({ role: label, lane: b.lane, name: ent(b.lane)?.name ?? b.name, win_probability: r1(b.p),
    likely_move: move(b.lane), avg_st: ent(b.lane)?.avg_st ?? null, start: stNote(b.lane) })
  const honmei = role(sorted[0], '本線'), taiko = role(sorted[1], '対抗'), ana = role(sorted[2], '3番手')
  const kimarite = [...km].sort((a, b) => b[1] - a[1]).map(([k, p]) => ({ kimarite: k, probability: r1(p) }))
  const escape = kimarite.find((x) => x.kimarite === '逃げ')?.probability ?? 0
  const shape = escape >= 70 ? 'イン逃げ濃厚' : escape >= 55 ? 'イン有利だが波乱含み' : escape >= 40 ? '混戦' : '荒れ模様'
  const lines = [
    `本線は${honmei.lane}号艇 ${honmei.name}の${honmei.likely_move ?? ''}（1着${honmei.win_probability}%）` +
      (honmei.start && honmei.start !== '普通' ? `。スタートは${honmei.start}（平均ST${honmei.avg_st}）` : ''),
    taiko ? `対抗は${taiko.lane}号艇 ${taiko.name}の${taiko.likely_move ?? ''}（${taiko.win_probability}%）` +
      (taiko.start === '速い' ? `。平均ST${taiko.avg_st}と速く、仕掛ける余地あり` : '') : null,
    `決まり手は${kimarite.slice(0, 3).map((x) => `${x.kimarite}${x.probability}%`).join('・')}。${shape}`,
  ].filter(Boolean)
  return { shape, honmei, taiko, third: ana, kimarite, summary: lines.join('。'), lines,
    basis: '1着確率×枠ごとの決まり手の実測（直近1年）。STは直近60走の平均' }
}

// ---------- 記録された買い目（有料） ----------
function picksOf(db, date) {
  const P = new Map()
  const put = (id, k, v) => { if (!P.has(id)) P.set(id, {}); P.get(id)[k] = v }
  if (has(db, 'haishin_daily')) {
    const rows = db.prepare(`SELECT race_id, kind, rank, combo, p, hit, payout, conf FROM haishin_daily WHERE date=? ORDER BY race_id, kind, rank`).all(date)
    const by = new Map()
    for (const r of rows) { if (!by.has(r.race_id)) by.set(r.race_id, { conf: r.conf, trio: [], tri: [] }); (r.kind === 'sanrenpuku' ? by.get(r.race_id).trio : by.get(r.race_id).tri).push(r) }
    const pk = (r, sep) => ({ combo: r.combo.split('-').join(sep), probability: r1(r.p), hit: r.hit == null ? null : r.hit === 1, payout: r.hit === 1 ? r.payout : null })
    for (const [id, a] of by) {
      put(id, 'plan2', { name: '3連複2点プラン', yen: 200, confidence: Math.round(a.conf * 100), picks: a.trio.slice(0, 2).map((r) => pk(r, '=')) })
      put(id, 'haishin', { name: '3連複4点＋3連単4点', yen: 800, confidence: Math.round(a.conf * 100),
        trio: a.trio.map((r) => pk(r, '=')), trifecta: a.tri.map((r) => pk(r, '-')) })
    }
  }
  if (has(db, 'tansho_daily'))
    for (const r of db.prepare(`SELECT race_id, lane, racer, p, hit, payout FROM tansho_daily WHERE date=?`).all(date))
      put(r.race_id, 'free_win', { name: '無料枠（単勝1点）', yen: 100, lane: r.lane, racer: r.racer, probability: r1(r.p),
        hit: r.hit == null ? null : r.hit === 1, payout: r.hit === 1 ? r.payout : null })
  // 企画枠（場を指定した全レース）。通常の配信とは別枠で、実績にも混ぜていない
  if (has(db, 'spot_daily')) {
    const by = new Map()
    for (const r of db.prepare(`SELECT race_id, kind, rank, combo, p, hit, payout, conf, series FROM spot_daily
      WHERE date=? AND rank<=4 ORDER BY race_id, kind, rank`).all(date)) {
      if (!by.has(r.race_id)) by.set(r.race_id, { conf: r.conf, series: r.series, trio: [], tri: [] })
      ;(r.kind === 'sanrenpuku' ? by.get(r.race_id).trio : by.get(r.race_id).tri).push(r)
    }
    const pk = (r, sep) => ({ combo: r.combo.split('-').join(sep), probability: r1(r.p), hit: r.hit == null ? null : r.hit === 1, payout: r.hit === 1 ? r.payout : null })
    for (const [id, a] of by) put(id, 'spot', { name: '企画枠（場の全レース）', series: a.series, confidence: a.conf != null ? Math.round(a.conf * 100) : null,
      trio: a.trio.map((r) => pk(r, '=')), trifecta: a.tri.map((r) => pk(r, '-')) })
  }
  if (has(db, 'b2_daily'))
    for (const r of db.prepare(`SELECT race_id, lane, racer, grade, p, hit, payout FROM b2_daily WHERE date=?`).all(date))
      put(r.race_id, 'b2', { name: 'B2判定（単勝1点）', yen: 100, lane: r.lane, racer: r.racer, class: r.grade, probability: r1(r.p),
        hit: r.hit == null ? null : r.hit === 1, payout: r.hit === 1 ? r.payout : null })
  return P
}

// ---------- 1レース分を組み立てる ----------
function buildRace(db, date, id, ctx, full) {
  const meta = ctx.meta.get(id) ?? {}
  const pr = ctx.predById.get(id)
  const jcd = meta.jcd ?? pr?.jcd ?? Number(id.slice(9, 11))
  const rno = meta.race_no ?? pr?.race_no ?? Number(id.slice(12, 14))
  const ents = ctx.ents.get(id) ?? []
  const deadline = meta.deadline ?? null
  const isToday = date === today()
  const result = ctx.res.get(id) ?? null
  const base = {
    race_id: id, date, jcd, venue: VENUE[jcd] ?? null, race_no: rno, deadline,
    title: meta.title ?? null, series: meta.series ?? pr?.series ?? null, day_no: meta.day_no ?? pr?.day_no ?? null,
    series_days: meta.series_len ?? null, grade: meta.grade ?? pr?.grade ?? null,
    closed: isToday ? (deadline ?? '00:00') <= nowHM() : date < today(),
    cancelled: !!result?.cancelled, result: result && !result.cancelled ? result : null,
  }
  if (!full) {
    const top = pr?.first ? [...pr.first].sort((a, b) => b.p - a.p)[0] : null
    return { ...base, favorite: top ? { lane: top.lane, name: ents.find((e) => e.lane === top.lane)?.name ?? top.name, win_probability: r1(top.p) } : null,
      has_paid_picks: ctx.picks.has(id) && !!(ctx.picks.get(id).plan2 || ctx.picks.get(id).haishin) }
  }
  // ★直前情報（展示・進入・チルト・部品交換・気象）。当日は before.mjs --live がレース前に集める（2026-09-22〜）
  const bi = new Map(db.prepare(`SELECT lane, weight, adj_weight, ex_time, tilt, parts, ex_course, ex_st, ex_st_flag
    FROM before_info WHERE race_id=?`).all(id).map((b) => [b.lane, b]))
  const br = db.prepare(`SELECT air_temp, water_temp, weather, wind_speed, wind_dir, wave, fetched, status FROM before_race WHERE race_id=?`).get(id)
  const exs = [...bi.values()].map((b) => b.ex_time).filter((v) => v != null).sort((a, b) => a - b)
  const beforeOf = (lane) => {
    const b = bi.get(lane); if (!b) return null
    return { weight: b.weight, adjust_weight: b.adj_weight, exhibition_time: b.ex_time,
      exhibition_rank: b.ex_time == null ? null : exs.indexOf(b.ex_time) + 1,
      tilt: b.tilt, parts_changed: b.parts, start_course: b.ex_course, start_st: b.ex_st, start_flag: b.ex_st_flag }
  }
  const byLane = new Map((pr?.first ?? []).map((b) => [b.lane, b.p]))
  const top2 = new Map((pr?.top2 ?? []).map((b) => [b.lane, b.p]))
  return {
    ...base,
    entries: ents.map((e) => {
      // ★日和の「基本情報・枠別情報・モータ情報・今節成績」にあたるもの（2026-09-23）
      const rc = e.racer_id ? racerOf(db, e.racer_id) : null
      const b = beforeOf(e.lane)
      const course = b?.start_course ?? e.lane            // 展示の進入が分かればそのコース、無ければ枠
      const cs = rc?.by_course.find((c) => c.course === course) ?? null
      return { ...e, win_probability: r1(byLane.get(e.lane)), top2_probability: r1(top2.get(e.lane)), before: b,
        stats_1y: rc ? { ...rc.summary_1y, titles_since_2022: rc.titles_since_2022, maezuke_rate: rc.maezuke.inward_rate } : null,
        course_stats: cs ? { course, ...cs } : null,
        motor: motorOf(db, jcd, e.motor_no, date),
        konsetsu: e.racer_id ? konsetsuOf(db, e.racer_id, jcd, meta.series ?? pr?.series ?? null, date, e.series_result) : null }
    }),
    // 水面気象。wind_dir は公式の風向図の番号（1〜16、17は無風）。status=partial は展示前
    conditions: br ? { weather: br.weather, air_temp: br.air_temp, water_temp: br.water_temp, wind_speed: br.wind_speed,
      wind_dir: br.wind_dir, wave: br.wave, before_info: br.status === 'ok' ? '展示まで取得済み' : '展示前',
      fetched_at: jstStamp(br.fetched) } : null,
    tenkai: tenkaiOf(db, pr, ents),
    demoku: demokuOf(db, jcd, rno),
    odds: oddsOf(db, id),
    prediction: pr ? {
      access: 'paid',
      note: '有料の買い目の元になる確率。公開サイトに出すときは外すこと',
      confidence: pr.conf != null ? Math.round(pr.conf * 100) : null,
      trio: (pr.sanrenpuku ?? []).map((x) => ({ combo: x.combo.split('-').join('='), probability: r1(x.p) })),
      trifecta: (pr.sanrentan ?? []).map((x) => ({ combo: x.combo, probability: r1(x.p) })),
      exacta: (pr.nirentanTop ?? []).map((x) => ({ combo: x.combo, probability: r1(x.p) })),
    } : null,
    picks: ctx.picks.has(id) ? { access: 'paid', ...ctx.picks.get(id) } : null,
  }
}
function dayContext(db, date) {
  const pred = loadPred(date)
  return {
    pred, predById: new Map((pred?.races ?? []).map((r) => [r.race_id, r])),
    meta: metaOf(db, date), ents: entriesOf(db, date), res: resultsOf(db, date), picks: picksOf(db, date),
  }
}
const raceIds = (ctx) => [...new Set([...ctx.meta.keys(), ...ctx.predById.keys(), ...ctx.ents.keys()])]
  .sort((a, b) => a.slice(9, 11) - b.slice(9, 11) || a.slice(12, 14) - b.slice(12, 14))

// ---------- トップの特集（ガチガチ/穴レース・アラート） ----------
// ★2026-09-23：日和のトップにある「ガチガチレース検索・穴レース検索・まくり/前づけ/チルト跳アラート」にあたるもの。
//   ガチガチ/穴は AI の1着確率で選ぶ（オッズは使わない）。アラートは当日の直前情報（before.mjs --live）から作る。
//   ・前づけ：展示の進入で、枠より内のコースに入った艇
//   ・チルト跳：チルト+1.0度以上、または同じ節の前走からチルトを上げた艇
//   ・まくり：3〜6号艇の展示タイムが1位で、1号艇より0.05秒以上速い
//   ・スタート：展示STで、外の艇が内の艇より0.05秒以上速い（内が凹んでいる）
function featuresOf(db, date, ctx) {
  const races = raceIds(ctx).map((id) => buildRace(db, date, id, ctx, false))
  const byId = new Map(races.map((r) => [r.race_id, r]))
  const open = (r) => !r.closed && !r.cancelled
  const gachi = [], ana = []
  for (const [id, pr] of ctx.predById) {
    const r = byId.get(id); if (!r || !pr.first?.length) continue
    const f = [...pr.first].sort((a, b) => b.p - a.p)
    const item = { race_id: id, venue: r.venue, race_no: r.race_no, deadline: r.deadline, closed: r.closed, result: r.result,
      favorite: { lane: f[0].lane, name: r.favorite?.name ?? f[0].name, win_probability: r1(f[0].p) },
      second: f[1] ? { lane: f[1].lane, win_probability: r1(f[1].p) } : null }
    if (f[0].p >= 0.70) gachi.push(item)
    if (f[0].p < 0.40) ana.push(item)
  }
  gachi.sort((a, b) => b.favorite.win_probability - a.favorite.win_probability)
  ana.sort((a, b) => a.favorite.win_probability - b.favorite.win_probability)

  // アラート（当日の直前情報）
  const alerts = { maezuke: [], tilt: [], makuri: [], start: [] }
  const bi = db.prepare(`SELECT b.race_id, b.lane, b.tilt, b.ex_time, b.ex_course, b.ex_st, b.ex_st_flag, p.racer_id
    FROM before_info b LEFT JOIN programs p ON p.race_id=b.race_id AND p.lane=b.lane
    WHERE b.race_id BETWEEN ? AND ?`).all(ymd(date) + '-', ymd(date) + '-~')
  const R = new Map()
  for (const x of bi) { if (!R.has(x.race_id)) R.set(x.race_id, []); R.get(x.race_id).push(x) }
  const prevTilt = db.prepare(`SELECT b.tilt FROM before_info b JOIN programs p ON p.race_id=b.race_id AND p.lane=b.lane
    WHERE p.racer_id=? AND b.race_id < ? AND b.race_id >= ? AND substr(b.race_id,10,2)=? AND b.tilt IS NOT NULL
    ORDER BY b.race_id DESC LIMIT 1`)
  const nameOf = (id, lane) => (ctx.ents.get(id) ?? []).find((e) => e.lane === lane)?.name ?? null
  for (const [id, rows] of R) {
    const r = byId.get(id); if (!r) continue
    const base = { race_id: id, venue: r.venue, race_no: r.race_no, deadline: r.deadline, closed: r.closed }
    for (const x of rows) {
      if (x.ex_course != null && x.ex_course < x.lane) alerts.maezuke.push({ ...base, lane: x.lane, name: nameOf(id, x.lane), course: x.ex_course })
      if (x.tilt != null) {
        const pv = x.racer_id ? prevTilt.get(x.racer_id, id, ymd(addDays(date, -8)) + '-', id.slice(9, 11))?.tilt : null
        if (x.tilt >= 1.0 || (pv != null && x.tilt > pv))
          alerts.tilt.push({ ...base, lane: x.lane, name: nameOf(id, x.lane), tilt: x.tilt, previous_tilt: pv ?? null })
      }
    }
    const ex = rows.filter((x) => x.ex_time > 0)
    if (ex.length === 6) {
      const best = [...ex].sort((a, b) => a.ex_time - b.ex_time)[0]
      const one = ex.find((x) => x.lane === 1)
      if (best.lane >= 3 && one && one.ex_time - best.ex_time >= 0.05)
        alerts.makuri.push({ ...base, lane: best.lane, name: nameOf(id, best.lane), exhibition_time: best.ex_time, lane1_time: one.ex_time, diff: r2(one.ex_time - best.ex_time) })
    }
    const st = rows.filter((x) => x.ex_st != null && x.ex_course != null).sort((a, b) => a.ex_course - b.ex_course)
    for (let i = 1; i < st.length; i++) {
      const inner = st[i - 1], outer = st[i]
      const sIn = inner.ex_st_flag === 'F' ? -inner.ex_st : inner.ex_st, sOut = outer.ex_st_flag === 'F' ? -outer.ex_st : outer.ex_st
      if (sIn - sOut >= 0.05) alerts.start.push({ ...base, inner_lane: inner.lane, inner_st: sIn, outer_lane: outer.lane, outer_st: sOut, diff: r2(sIn - sOut) })
    }
  }
  for (const k of Object.keys(alerts)) alerts[k].sort((a, b) => (a.closed - b.closed) || String(a.deadline).localeCompare(String(b.deadline)))
  return {
    gachigachi: { rule: 'AIの本命の1着確率が70%以上', races: gachi.filter(open).concat(gachi.filter((r) => !open(r))) },
    ana: { rule: 'AIの本命の1着確率が40%未満（荒れそう）', races: ana.filter(open).concat(ana.filter((r) => !open(r))) },
    alerts: { ...alerts, rules: {
      maezuke: '展示の進入で、枠より内のコースに入った艇', tilt: 'チルト+1.0度以上、または同じ節の前走からチルトを上げた艇',
      makuri: '3〜6号艇の展示タイムが1位で、1号艇より0.05秒以上速い', start: '展示STで外の艇が内の艇より0.05秒以上速い（内が凹み）' } },
    note: 'アラートは直前情報（締切の約20分前から）が入ったレースだけ。ガチガチ/穴はオッズを使わないAIの確率',
  }
}

// ---------- 出目ランク（その場・そのレース番号の直近1年でよく出た3連単） ----------
function demokuOf(db, jcd, rno) {
  return cached(`demoku|${jcd}|${rno}|${today()}`, 24 * HOUR, () => {
    const rows = db.prepare(`SELECT e.race_id, e.lane, e.rank_num FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE r.jcd=? AND r.race_no=? AND r.date>=? AND e.rank_num BETWEEN 1 AND 3`).all(jcd, rno, addDays(today(), -365))
    const by = new Map()
    for (const x of rows) { if (!by.has(x.race_id)) by.set(x.race_id, {}); by.get(x.race_id)[x.rank_num] = x.lane }
    const cnt = new Map(), first = new Map()
    let n = 0
    for (const a of by.values()) {
      if (!a[1] || !a[2] || !a[3]) continue
      n++
      const k = `${a[1]}-${a[2]}-${a[3]}`
      cnt.set(k, (cnt.get(k) ?? 0) + 1)
      first.set(a[1], (first.get(a[1]) ?? 0) + 1)
    }
    return { races: n, period: '直近1年',
      trifecta_top: [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([combo, c]) => ({ combo, count: c, rate: pct(c, n) })),
      first_by_lane: [1, 2, 3, 4, 5, 6].map((l) => ({ lane: l, rate: pct(first.get(l) ?? 0, n) })) }
  })
}

// ---------- 開催予定・出場予定（scripts/schedule.mjs が集める） ----------
function scheduleOf(db, from, to) {
  if (!has(db, 'schedule')) return []
  const n = has(db, 'assen') ? new Map(db.prepare(`SELECT jcd||'|'||start_date k, COUNT(*) c FROM assen GROUP BY jcd, start_date`).all().map((r) => [r.k, r.c])) : new Map()
  return db.prepare(`SELECT * FROM schedule WHERE end_date>=? AND start_date<=? ORDER BY start_date, jcd`).all(from, to)
    .map((x) => ({ jcd: x.jcd, venue: VENUE[x.jcd], start_date: x.start_date, end_date: x.end_date, days: x.days, title: x.title, grade: x.grade,
      racers: n.get(x.jcd + '|' + x.start_date) ?? 0 }))
}
function meetingOf(db, jcd, start) {
  const m = has(db, 'schedule') ? db.prepare(`SELECT * FROM schedule WHERE jcd=? AND start_date=?`).get(jcd, start) : null
  if (!m) return null
  const rs = has(db, 'assen') ? db.prepare(`SELECT a.racer_id, a.name, a.class, r.win_rate, r.branch FROM assen a
    LEFT JOIN (SELECT racer_id, win_rate, branch, MAX(period) FROM racer_period GROUP BY racer_id) r ON r.racer_id=a.racer_id
    WHERE a.jcd=? AND a.start_date=? ORDER BY r.win_rate DESC`).all(jcd, start) : []
  return { jcd, venue: VENUE[jcd], start_date: m.start_date, end_date: m.end_date, days: m.days, title: m.title, grade: m.grade,
    racers: rs.map((r) => ({ racer_id: r.racer_id, name: r.name, class: r.class, branch: r.branch, win_rate: r.win_rate })) }
}
function upcomingOf(db, id) {
  if (!has(db, 'assen')) return []
  return db.prepare(`SELECT s.jcd, s.start_date, s.end_date, s.title, s.grade FROM assen a JOIN schedule s USING (jcd, start_date)
    WHERE a.racer_id=? AND s.end_date>=? ORDER BY s.start_date`).all(id, today())
    .map((x) => ({ jcd: x.jcd, venue: VENUE[x.jcd], start_date: x.start_date, end_date: x.end_date, title: x.title, grade: x.grade }))
}

// ---------- データ分析（日和の「データ分析」「出目分析」にあたる。2026-09-23） ----------
//   kind=average  全国と場ごとのコース別1着率・平均ST・決まり手（直近1年）
//   kind=ranking  コース別の1着率ランキング（直近1年・そのコースで20走以上）
//   kind=demoku   出目分析：全国と場ごとの3連単の出目上位・1着の枠・万舟率
//   kind=yusho    優勝戦の結果（直近90日）。SG/G1は別に並べる
function analysisOf(db, kind) {
  return cached('analysis|' + kind + '|' + today(), 12 * HOUR, () => {
    const from = addDays(today(), -365), lo = ymd(from)
    if (kind === 'average') {
      const rows = db.prepare(`SELECT r.jcd, e.course, COUNT(*) n, SUM(e.rank_num=1) w, SUM(e.rank_num<=2) t2, SUM(e.rank_num<=3) t3,
        AVG(CASE WHEN e.st>0 AND e.st<1 THEN e.st END) st FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date>=? AND e.course+0 BETWEEN 1 AND 6 GROUP BY r.jcd, e.course`).all(from)
      const km = db.prepare(`SELECT r.jcd, e.course, r.kimarite k, COUNT(*) n FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date>=? AND e.rank_num=1 AND r.kimarite IS NOT NULL GROUP BY r.jcd, e.course, r.kimarite`).all(from)
      const sum = (arr) => arr.reduce((a, x) => ({ n: a.n + x.n, w: a.w + x.w, t2: a.t2 + x.t2, t3: a.t3 + x.t3, st: a.st + (x.st ?? 0) * x.n }), { n: 0, w: 0, t2: 0, t3: 0, st: 0 })
      const row = (c, s, kms) => { const tw = kms.reduce((a, x) => a + x.n, 0)
        return { course: c, starts: s.n, win_rate: pct(s.w, s.n), top2_rate: pct(s.t2, s.n), top3_rate: pct(s.t3, s.n), avg_st: s.n ? r2(s.st / s.n) : null,
          kimarite: Object.entries(kms.reduce((m, x) => ({ ...m, [x.k]: (m[x.k] ?? 0) + x.n }), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ kimarite: k, share: pct(n, tw) })) } }
      const national = [1, 2, 3, 4, 5, 6].map((c) => row(c, sum(rows.filter((x) => x.course === c)), km.filter((x) => x.course === c)))
      const venues = [...new Set(rows.map((x) => x.jcd))].sort((a, b) => a - b).map((j) => ({ jcd: j, venue: VENUE[j],
        courses: [1, 2, 3, 4, 5, 6].map((c) => row(c, sum(rows.filter((x) => x.jcd === j && x.course === c)), km.filter((x) => x.jcd === j && x.course === c))) }))
      return { period: { from, to: today() }, national, venues }
    }
    if (kind === 'ranking') {
      const rows = db.prepare(`SELECT e.racer_id, e.course, COUNT(*) n, SUM(e.rank_num=1) w, SUM(e.rank_num<=2) t2, SUM(e.rank_num<=3) t3,
        AVG(CASE WHEN e.st>0 AND e.st<1 THEN e.st END) st FROM entries e
        WHERE e.race_id>=? AND e.course+0 BETWEEN 1 AND 6 AND e.racer_id IS NOT NULL GROUP BY e.racer_id, e.course HAVING n>=20`).all(lo)
      const name = new Map(db.prepare(`SELECT r.racer_id, r.name, r.grade, r.branch FROM racer_period r
        JOIN (SELECT racer_id, MAX(period) mp FROM racer_period GROUP BY racer_id) m ON m.racer_id=r.racer_id AND m.mp=r.period`).all().map((r) => [r.racer_id, r]))
      const by = [1, 2, 3, 4, 5, 6].map((c) => ({ course: c,
        top: rows.filter((x) => x.course === c).sort((a, b) => b.w / b.n - a.w / a.n).slice(0, 30).map((x) => ({
          racer_id: x.racer_id, name: name.get(x.racer_id)?.name ?? null, class: name.get(x.racer_id)?.grade ?? null, branch: name.get(x.racer_id)?.branch ?? null,
          starts: x.n, win_rate: pct(x.w, x.n), top2_rate: pct(x.t2, x.n), top3_rate: pct(x.t3, x.n), avg_st: r2(x.st) })) }))
      const st = db.prepare(`SELECT racer_id, COUNT(*) n, AVG(st) st FROM entries WHERE race_id>=? AND st>0 AND st<1 AND racer_id IS NOT NULL
        GROUP BY racer_id HAVING n>=50 ORDER BY st LIMIT 30`).all(lo)
      return { period: { from, to: today() }, rule: '直近1年・そのコースで20走以上', by_course: by,
        fastest_start: st.map((x) => ({ racer_id: x.racer_id, name: name.get(x.racer_id)?.name ?? null, class: name.get(x.racer_id)?.grade ?? null, starts: x.n, avg_st: r2(x.st) })) }
    }
    if (kind === 'demoku') {
      const rows = db.prepare(`SELECT r.jcd, e.race_id, e.lane, e.rank_num FROM entries e JOIN races r ON r.race_id=e.race_id
        WHERE r.date>=? AND e.rank_num BETWEEN 1 AND 3`).all(from)
      const pay = new Map(db.prepare(`SELECT p.race_id, p.amount FROM payouts p WHERE p.race_id>=? AND p.bet_type='sanrentan'`).all(lo).map((r) => [r.race_id, r.amount]))
      const by = new Map()
      for (const x of rows) { if (!by.has(x.race_id)) by.set(x.race_id, { jcd: x.jcd }); by.get(x.race_id)[x.rank_num] = x.lane }
      const make = (list) => {
        const cnt = new Map(), first = new Map(); let n = 0, man = 0, sum = 0, np = 0
        for (const [id, a] of list) {
          if (!a[1] || !a[2] || !a[3]) continue
          n++; const k = `${a[1]}-${a[2]}-${a[3]}`; cnt.set(k, (cnt.get(k) ?? 0) + 1); first.set(a[1], (first.get(a[1]) ?? 0) + 1)
          const p = pay.get(id); if (p) { np++; sum += p; if (p >= 10000) man++ }
        }
        return { races: n, trifecta_top: [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([combo, c]) => ({ combo, count: c, rate: pct(c, n) })),
          first_by_lane: [1, 2, 3, 4, 5, 6].map((l) => ({ lane: l, rate: pct(first.get(l) ?? 0, n) })),
          avg_payout: np ? Math.round(sum / np) : null, over_10000_rate: pct(man, np) }
      }
      const all = [...by]
      return { period: { from, to: today() }, national: make(all),
        venues: [...new Set(all.map(([, a]) => a.jcd))].sort((a, b) => a - b).map((j) => ({ jcd: j, venue: VENUE[j], ...make(all.filter(([, a]) => a.jcd === j)) })) }
    }
    if (kind === 'yusho') {
      const races = db.prepare(`SELECT race_id, date, jcd, title, series, grade, kimarite FROM races WHERE date>=? AND title LIKE '%優勝戦%' AND title NOT LIKE '%準優%'
        ORDER BY date DESC`).all(addDays(today(), -90))
      const q = db.prepare(`SELECT lane, course, racer_id, racer_name, rank_num, st FROM entries WHERE race_id=? ORDER BY rank_num`)
      const pay = db.prepare(`SELECT amount FROM payouts WHERE race_id=? AND bet_type='sanrentan'`)
      const out = races.map((r) => {
        const es = q.all(r.race_id), w = es.find((e) => e.rank_num === 1)
        const nm = w ? db.prepare(`SELECT name FROM racer_period WHERE racer_id=? ORDER BY period DESC LIMIT 1`).get(w.racer_id)?.name : null
        return { race_id: r.race_id, date: r.date, venue: VENUE[r.jcd], jcd: r.jcd, series: r.series, grade: r.grade ?? '一般', kimarite: r.kimarite,
          winner: w ? { racer_id: w.racer_id, name: nm ?? w.racer_name, lane: w.lane, course: w.course, st: w.st } : null,
          order: es.filter((e) => e.rank_num >= 1).slice(0, 3).map((e) => e.lane).join('-'), trifecta_payout: pay.get(r.race_id)?.amount ?? null }
      })
      return { period: '直近90日', races: out, big: out.filter((x) => ['SG', 'G1', 'G2'].includes(x.grade)) }
    }
    return null
  })
}

// ---------- オッズ（2026-09-23） ----------
//   締切前：before.mjs --live が締切20分前と5分前に取った 3連単・3連複・2連単・2連複（odds_snap）と、
//           odds-live.mjs が取っている単勝・複勝（odds_live の最新）
//   締切後：翌日に集める確定オッズ（odds3t / odds3f / odds_tan）があればそちら
function oddsOf(db, id) {
  const pick = (sql, ...a) => { try { return db.prepare(sql).all(...a) } catch { return [] } }
  const obj = (rows) => (rows.length ? Object.fromEntries(rows.map((r) => [r.combo, r.odds])) : null)
  const fin3t = obj(pick(`SELECT combo, odds FROM odds3t WHERE race_id=?`, id))
  if (fin3t) {
    const tan = pick(`SELECT lane, tansho, fukusho_lo, fukusho_hi FROM odds_tan WHERE race_id=? ORDER BY lane`, id)
    return { kind: '確定', taken_at: null, minutes_before: null,
      win: tan.map((t) => ({ lane: t.lane, odds: t.tansho })), place: tan.map((t) => ({ lane: t.lane, low: t.fukusho_lo, high: t.fukusho_hi })),
      trifecta: fin3t, trio: obj(pick(`SELECT combo, odds FROM odds3f WHERE race_id=?`, id)) }
  }
  const meta = pick(`SELECT taken, mins_before FROM odds_snap_meta WHERE race_id=?`, id)[0]
  const snap = pick(`SELECT kind, combo, odds FROM odds_snap WHERE race_id=?`, id)
  const live = pick(`SELECT l.lane, l.tansho, l.fukusho_lo, l.taken, l.mins_before FROM odds_live l
    JOIN (SELECT lane, MAX(taken) mt FROM odds_live WHERE race_id=? GROUP BY lane) m ON m.lane=l.lane AND m.mt=l.taken WHERE l.race_id=? ORDER BY l.lane`, id, id)
  if (!meta && !live.length) return null
  const k = (kind) => obj(snap.filter((r) => r.kind === kind))
  return { kind: '締切前', taken_at: meta ? jstStamp(meta.taken) : null, minutes_before: meta?.mins_before ?? null,
    win: live.map((t) => ({ lane: t.lane, odds: t.tansho })), place: live.map((t) => ({ lane: t.lane, low: t.fukusho_lo, high: null })),
    win_taken: live[0] ? `${live[0].taken}（締切${live[0].mins_before}分前）` : null,
    trifecta: k('sanrentan'), trio: k('sanrenpuku'), exacta: k('nirentan'), quinella: k('nirenpuku'),
    note: '締切前のオッズは締切までに変わります。確定オッズとは違います' }
}

// ---------- 実績 ----------
function resultsSummary(db, days) {
  const from = addDays(today(), -days)
  const day = new Map()
  const bump = (d, k, n, h, ret, cost) => {
    if (!day.has(d)) day.set(d, {})
    const a = day.get(d)[k] ?? (day.get(d)[k] = { races: 0, hits: 0, returned: 0, spent: 0 })
    a.races += n; a.hits += h; a.returned += ret; a.spent += cost
  }
  if (has(db, 'haishin_daily')) {
    for (const [k, where, pts] of [['plan2', "kind='sanrenpuku' AND rank<=2", 2], ['trio4', "kind='sanrenpuku' AND rank<=4", 4], ['trifecta4', "kind='sanrentan' AND rank<=4", 4]]) {
      for (const r of db.prepare(`SELECT date, race_id, MAX(hit) h, SUM(CASE WHEN hit=1 THEN payout ELSE 0 END) ret
        FROM haishin_daily WHERE ${where} AND hit IS NOT NULL AND date>=? GROUP BY date, race_id`).all(from))
        bump(r.date, k, 1, r.h ? 1 : 0, r.ret ?? 0, pts * 100)
    }
  }
  for (const [t, k] of [['tansho_daily', 'free_win'], ['b2_daily', 'b2']]) {
    if (!has(db, t)) continue
    for (const r of db.prepare(`SELECT date, hit, payout FROM ${t} WHERE hit IS NOT NULL AND date>=?`).all(from))
      bump(r.date, k, 1, r.hit ? 1 : 0, r.hit ? (r.payout ?? 0) : 0, 100)
  }
  const fin = (a) => a && { races: a.races, hits: a.hits, hit_rate: pct(a.hits, a.races), spent: a.spent, returned: a.returned, return_rate: pct(a.returned, a.spent) }
  const total = {}
  for (const v of day.values()) for (const [k, a] of Object.entries(v)) {
    const t = total[k] ?? (total[k] = { races: 0, hits: 0, returned: 0, spent: 0 })
    t.races += a.races; t.hits += a.hits; t.returned += a.returned; t.spent += a.spent
  }
  const NAMES = { plan2: '3連複2点プラン', trio4: '3連複4点', trifecta4: '3連単4点', free_win: '無料枠（単勝1点）', b2: 'B2判定' }
  return {
    days, from, to: today(),
    note: '締切前に出した予想だけを数えています（後出しは除外）。外れた日も含みます。回収率は100%未満です。',
    reference: { plan2: { hit_rate: 58.9, return_rate: 83.1, basis: '学習に使っていない175日・2,689レースの実測' } },
    products: NAMES,
    total: Object.fromEntries(Object.entries(total).map(([k, a]) => [k, fin(a)])),
    daily: [...day].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([d, v]) => ({ date: d, ...Object.fromEntries(Object.entries(v).map(([k, a]) => [k, fin(a)])) })),
  }
}

// ---------- 選手 ----------
// ★2026-09-23に厚くした（本人：選手データが少なすぎる。日和と同じ構成に）。
//   出走履歴（2022-08〜）を1回で読み、JSで全部集計する。1人0.1〜0.3秒。1日6時間覚えておく。
//   事故：F（フライング）・L0/L1（出遅れ）・S0/S1/S2（失格・転覆など）。K0/K1 は欠場なので事故に数えない。
//   優勝戦・準優勝戦はレース名（races.title）で見分ける。「優勝戦」を含む＝優出、そこで1着＝優勝。
const isYusho = (t) => /優勝戦/.test(t ?? '') && !/準優/.test(t ?? '')
const isJunyu = (t) => /準優勝戦/.test(t ?? '')
const band = (dl) => (!dl ? null : dl < '12:00' ? '朝（〜12時）' : dl < '17:00' ? '昼（12〜17時）' : '夜（17時〜）')
function agg(rows) {
  const n = rows.length
  const done = rows.filter((x) => x.rank_num >= 1 && x.rank_num <= 6)
  const st = rows.filter((x) => x.st > 0 && x.st < 1)
  const str = rows.filter((x) => x.st_rank != null)
  return {
    starts: n,
    win_rate: pct(done.filter((x) => x.rank_num === 1).length, n),
    top2_rate: pct(done.filter((x) => x.rank_num <= 2).length, n),
    top3_rate: pct(done.filter((x) => x.rank_num <= 3).length, n),
    avg_st: st.length ? r2(st.reduce((a, x) => a + x.st, 0) / st.length) : null,
    avg_st_rank: str.length ? Math.round(str.reduce((a, x) => a + x.st_rank, 0) / str.length * 100) / 100 : null,
  }
}
function racerOf(db, id) {
  return cached('racer2|' + id + '|' + today(), 6 * HOUR, () => {
    const periods = db.prepare(`SELECT period, name, kana, branch, grade, birth, sex, age, height, weight, blood,
      win_rate, top2_rate, w1, w2, starts FROM racer_period WHERE racer_id=? ORDER BY period DESC`).all(id)
    const p = periods[0]
    if (!p) return null
    const rows = db.prepare(`SELECT e.race_id, e.lane, e.course, e.st, e.st_flag, e.rank, e.rank_num, e.motor_no, e.exhibition,
      r.date, r.jcd, r.race_no, r.title, r.grade, r.series, r.kimarite, r.deadline, r.wave, r.wind_speed
      FROM entries e JOIN races r ON r.race_id=e.race_id WHERE e.racer_id=? ORDER BY r.date DESC, r.race_no DESC`).all(id)
    const from1y = addDays(today(), -365)
    const y1 = rows.filter((x) => x.date >= from1y && x.rank !== 'K0' && x.rank !== 'K1')
    // ST順位（同じレースの6艇の中で何番目に速かったか）。直近1年ぶんだけ同じレースの他艇を読む
    const ids = [...new Set(y1.map((x) => x.race_id))]
    const stBy = new Map()
    for (let i = 0; i < ids.length; i += 400) {
      const ch = ids.slice(i, i + 400)
      for (const e of db.prepare(`SELECT race_id, lane, st FROM entries WHERE race_id IN (${ch.map(() => '?').join(',')}) AND st>0 AND st<1`).iterate(...ch)) {
        if (!stBy.has(e.race_id)) stBy.set(e.race_id, []); stBy.get(e.race_id).push(e)
      }
    }
    for (const x of y1) {
      const a = stBy.get(x.race_id)
      if (a && x.st > 0 && x.st < 1) x.st_rank = a.filter((o) => o.st < x.st).length + 1
    }
    // コース別（1コースは負け方、2〜6コースは勝ち方も）
    const by_course = [1, 2, 3, 4, 5, 6].map((c) => {
      const rs = y1.filter((x) => x.course === c)
      if (!rs.length) return null
      const wins = rs.filter((x) => x.rank_num === 1)
      const kmCount = (arr) => { const m = new Map(); for (const x of arr) if (x.kimarite) m.set(x.kimarite, (m.get(x.kimarite) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ kimarite: k, count: n, rate: pct(n, rs.length) })) }
      const o = { course: c, ...agg(rs), wins_by_kimarite: kmCount(wins) }
      if (c === 1) {
        // 1コースで負けたとき、1着艇が何で勝ったか＝差された・まくられた・まくり差された
        const lost = rs.filter((x) => x.rank_num > 1 && x.rank_num <= 6)
        const how = (k) => pct(lost.filter((x) => x.kimarite === k).length, rs.length)
        o.escape_rate = pct(wins.filter((x) => x.kimarite === '逃げ').length, rs.length)
        o.lost_to = { '差され': how('差し'), 'まくられ': how('まくり'), 'まくり差され': how('まくり差し'),
          '抜かれ・恵まれ': pct(lost.filter((x) => x.kimarite === '抜き' || x.kimarite === '恵まれ').length, rs.length) }
      }
      o.recent = rs.slice(0, 5).map((x) => ({ date: x.date, venue: VENUE[x.jcd], race_no: x.race_no, st: x.st, rank: x.rank_num ?? x.rank }))
      return o
    }).filter(Boolean)
    // 場別・グレード別・時間帯別・波別
    const group = (keyOf) => { const m = new Map(); for (const x of y1) { const k = keyOf(x); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(x) } return m }
    const by_venue = [...group((x) => x.jcd)].sort((a, b) => a[0] - b[0]).map(([j, rs]) => ({ jcd: j, venue: VENUE[j], ...agg(rs) }))
    const by_grade = [...group((x) => x.grade ?? '一般')].map(([g, rs]) => ({ grade: g, ...agg(rs) })).sort((a, b) => b.starts - a.starts)
    const by_time = [...group((x) => band(x.deadline))].map(([b, rs]) => ({ band: b, ...agg(rs) }))
    const by_wave = [...group((x) => (x.wave == null ? null : x.wave >= 5 ? '波5cm以上' : '波5cm未満'))].map(([b, rs]) => ({ band: b, ...agg(rs) }))
    // タイトル（2022-08以降の手元の記録から）
    const all = rows.filter((x) => x.rank !== 'K0' && x.rank !== 'K1')
    const titles = (arr) => ({
      yusho: arr.filter((x) => isYusho(x.title) && x.rank_num === 1).length,
      yushutsu: arr.filter((x) => isYusho(x.title)).length,
      junyu: arr.filter((x) => isJunyu(x.title)).length,
    })
    const accidents = (arr) => ({
      flying: arr.filter((x) => x.rank === 'F' || x.st_flag === 'F').length,
      late: arr.filter((x) => /^L/.test(x.rank ?? '') || x.st_flag === 'L').length,
      disqualified: arr.filter((x) => /^S/.test(x.rank ?? '')).length,
    })
    const acc = accidents(y1)
    // 前づけ（枠より内のコースに入った）・外に出た
    const withCourse = y1.filter((x) => x.course >= 1 && x.course <= 6)
    const inward = withCourse.filter((x) => x.course < x.lane).length
    const outward = withCourse.filter((x) => x.course > x.lane).length
    // 節（同じ場・同じ開催名で日付が続いているもの）ごとの成績。新しい順
    const series = []
    for (const x of rows) {
      const s = series.find((g) => g.jcd === x.jcd && g.series === x.series && addDays(x.date, 8) >= g.to)
      if (s) { s.races.push(x); if (x.date < s.from) s.from = x.date } else { if (series.length >= 6) break; series.push({ jcd: x.jcd, series: x.series, grade: x.grade, from: x.date, to: x.date, races: [x] }) }
    }
    const series_recent = series.map((g) => {
      const rs = [...g.races].sort((a, b) => a.date.localeCompare(b.date) || a.race_no - b.race_no)
      const yu = rs.find((x) => isYusho(x.title))
      return { venue: VENUE[g.jcd], jcd: g.jcd, series: g.series, grade: g.grade ?? '一般', from: g.from, to: g.to,
        results: rs.map((x) => ({ date: x.date, race_no: x.race_no, title: x.title, lane: x.lane, course: x.course, st: x.st, rank: x.rank_num ?? x.rank })),
        line: rs.map((x) => x.rank_num ?? (x.rank === 'F' ? 'F' : /^[SLK]/.test(x.rank ?? '') ? x.rank[0] : '-')).join(' '),
        finals: yu ? (yu.rank_num === 1 ? '優勝' : `優出${yu.rank_num ?? ''}着`) : rs.some((x) => isJunyu(x.title)) ? '準優出' : null }
    })
    const moves = new Map()
    for (const x of y1) if (x.rank_num === 1 && x.kimarite) moves.set(x.kimarite, (moves.get(x.kimarite) ?? 0) + 1)
    const wins = [...moves.values()].reduce((a, b) => a + b, 0)
    const todayRaces = db.prepare(`SELECT race_id, lane FROM programs WHERE racer_id=? AND race_id BETWEEN ? AND ? ORDER BY race_id`)
      .all(id, ymd(today()) + '-', ymd(today()) + '-~')
    return {
      racer_id: id, name: p.name, kana: p.kana, branch: p.branch, class: p.grade, birth: p.birth, sex: p.sex, age: p.age,
      height: p.height, weight: p.weight, blood: p.blood, period: p.period,
      official: { win_rate: p.win_rate, top2_rate: p.top2_rate, firsts: p.w1, seconds: p.w2, starts: p.starts },
      periods: periods.slice(0, 12).map((x) => ({ period: x.period, class: x.grade, win_rate: x.win_rate, top2_rate: x.top2_rate, starts: x.starts, firsts: x.w1, seconds: x.w2 })),
      summary_1y: { ...agg(y1), accidents: acc, accident_rate: pct(acc.flying + acc.late + acc.disqualified, y1.length), ...titles(y1) },
      titles_since_2022: titles(all),
      by_course, by_venue, by_grade, by_time, by_wave,
      maezuke: { starts: withCourse.length, inward, inward_rate: pct(inward, withCourse.length), outward, outward_rate: pct(outward, withCourse.length) },
      winning_moves: [...moves].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ kimarite: k, count: n, share: pct(n, wins) })),
      series_recent,
      upcoming: upcomingOf(db, id),
      today: todayRaces.map((x) => ({ race_id: x.race_id, venue: VENUE[Number(x.race_id.slice(9, 11))], race_no: Number(x.race_id.slice(12, 14)), lane: x.lane })),
      recent: rows.slice(0, 20).map((x) => ({ date: x.date, venue: VENUE[x.jcd], race_no: x.race_no, lane: x.lane, course: x.course,
        st: x.st, st_flag: x.st_flag, rank: x.rank_num ?? x.rank, kimarite: x.rank_num === 1 ? x.kimarite : null })),
      period_note: '成績は出走履歴（2022年8月〜）から当システムが集計。「直近1年」は今日から365日。公式の期別成績とは期間が違う',
    }
  })
}

// ---------- 選手一覧 ----------
function racerList(db) {
  return cached('racers|' + today(), 12 * HOUR, () => {
    const act = new Set(db.prepare(`SELECT DISTINCT racer_id FROM entries WHERE race_id >= ?`).all(ymd(addDays(today(), -180))).map((r) => r.racer_id))
    const rows = db.prepare(`SELECT r.racer_id, r.name, r.kana, r.branch, r.grade, r.sex, r.age, r.win_rate, r.top2_rate FROM racer_period r
      JOIN (SELECT racer_id, MAX(period) mp FROM racer_period GROUP BY racer_id) m ON m.racer_id=r.racer_id AND m.mp=r.period`).all()
    return rows.filter((r) => act.has(r.racer_id)).sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0))
      .map((r) => ({ racer_id: r.racer_id, name: r.name, kana: r.kana, branch: r.branch, class: r.grade, sex: r.sex, age: r.age, win_rate: r.win_rate, top2_rate: r.top2_rate }))
  })
}

// ---------- モーター ----------
// ★モーターは場ごとに年1回入れ替わり、番号が使い回される。入れ替わりをまたいで数えると別物が混ざるので、
//   番組表のモーター2連率がその場で一斉に小さくなった日（平均10%未満）を「今期の始まり」とみなす。
function motorPeriodStart(db, jcd) {
  return cached('mstart|' + jcd + '|' + today(), 24 * HOUR, () => {
    const rows = db.prepare(`SELECT substr(race_id,1,8) d, AVG(motor_top2) a FROM programs
      WHERE race_id >= ? AND substr(race_id,10,2)=? GROUP BY d ORDER BY d DESC`).all(ymd(addDays(today(), -450)), String(jcd).padStart(2, '0'))
    const hit = rows.find((r) => r.a != null && r.a < 10)
    const d = hit?.d ?? rows.at(-1)?.d
    return d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : addDays(today(), -365)
  })
}
function motorOf(db, jcd, no, date) {
  if (!no) return null
  return cached(`motor|${jcd}|${no}|${date}`, 6 * HOUR, () => {
    const since = motorPeriodStart(db, jcd)
    const rows = db.prepare(`SELECT r.date, r.race_no, e.racer_id, e.racer_name, e.lane, e.course, e.rank, e.rank_num, e.exhibition
      FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE r.jcd=? AND e.motor_no=? AND r.date>=? AND r.date<? ORDER BY r.date DESC, r.race_no DESC`).all(jcd, no, since, date)
    const s = (arr) => ({ starts: arr.length, win_rate: pct(arr.filter((x) => x.rank_num === 1).length, arr.length),
      top2_rate: pct(arr.filter((x) => x.rank_num >= 1 && x.rank_num <= 2).length, arr.length),
      top3_rate: pct(arr.filter((x) => x.rank_num >= 1 && x.rank_num <= 3).length, arr.length) })
    const users = []
    for (const x of rows) {
      const u = users.find((v) => v.racer_id === x.racer_id && addDays(x.date, 8) >= v.to)
      if (u) { u.results.unshift(x.rank_num ?? x.rank); if (x.date < u.from) u.from = x.date }
      else if (users.length < 8) users.push({ racer_id: x.racer_id, name: x.racer_name, from: x.date, to: x.date, results: [x.rank_num ?? x.rank] })
    }
    const ex = rows.filter((x) => x.exhibition > 0).slice(0, 20)
    return { motor_no: no, period_from: since, total: s(rows), last_30d: s(rows.filter((x) => x.date >= addDays(date, -30))),
      avg_exhibition_recent: ex.length ? Math.round(ex.reduce((a, x) => a + x.exhibition, 0) / ex.length * 100) / 100 : null,
      users: users.map((u) => ({ ...u, results: u.results.join(' ') })) }
  })
}

// ---------- 今節 ----------
function konsetsuOf(db, id, jcd, series, date, seriesResult) {
  const rows = series ? db.prepare(`SELECT r.date, r.race_no, r.title, e.lane, e.course, e.st, e.st_flag, e.rank, e.rank_num, e.exhibition
    FROM entries e JOIN races r ON r.race_id=e.race_id
    WHERE e.racer_id=? AND r.jcd=? AND r.series=? AND r.date<? AND r.date>=? ORDER BY r.date, r.race_no`).all(id, jcd, series, date, addDays(date, -8)) : []
  const done = rows.filter((x) => x.rank_num >= 1 && x.rank_num <= 6)
  const st = rows.filter((x) => x.st > 0 && x.st < 1)
  return { series_result: seriesResult ?? null, races: rows.map((x) => ({ date: x.date, race_no: x.race_no, title: x.title, lane: x.lane,
      course: x.course, st: x.st, st_flag: x.st_flag, exhibition: x.exhibition, rank: x.rank_num ?? x.rank })),
    top2_rate: pct(done.filter((x) => x.rank_num <= 2).length, rows.length), avg_st: st.length ? r2(st.reduce((a, x) => a + x.st, 0) / st.length) : null,
    note: '前日までの今節成績（当日の分は series_result＝番組表の値）' }
}

// ---------- 場 ----------
function venueOf(db, jcd) {
  // ⚠ e.course+0 は索引を使わせないための書き方。素の e.course だと (course, rank_num) の索引で
  //   全出走を舐めて14秒かかった。+0 で「場で絞ってから数える」順になり0.1秒台になる。
  return cached('venue|' + jcd + '|' + today(), 12 * HOUR, () => {
    const from = addDays(today(), -365)
    const course = db.prepare(`SELECT e.course, COUNT(*) n, SUM(e.rank_num=1) w, SUM(e.rank_num<=2) t2, SUM(e.rank_num<=3) t3
      FROM entries e JOIN races r ON r.race_id=e.race_id WHERE r.jcd=? AND r.date>=? AND e.course+0 BETWEEN 1 AND 6
      GROUP BY e.course ORDER BY e.course`).all(jcd, from)
    const km = db.prepare(`SELECT kimarite k, COUNT(*) n FROM races WHERE jcd=? AND date>=? AND kimarite IS NOT NULL
      GROUP BY kimarite ORDER BY n DESC`).all(jcd, from)
    const monthly = db.prepare(`SELECT substr(r.date,1,7) m, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE r.jcd=? AND r.date>=? AND e.course=1 GROUP BY m ORDER BY m`).all(jcd, from)
    const byRace = db.prepare(`SELECT r.race_no, COUNT(*) n, SUM(e.rank_num=1) w FROM entries e JOIN races r ON r.race_id=e.race_id
      WHERE r.jcd=? AND r.date>=? AND e.course=1 GROUP BY r.race_no ORDER BY r.race_no`).all(jcd, from)
    const tot = km.reduce((a, x) => a + x.n, 0)
    const pay = db.prepare(`SELECT AVG(p.amount) a, COUNT(*) n, SUM(p.amount>=10000) man FROM payouts p JOIN races r ON r.race_id=p.race_id
      WHERE r.jcd=? AND r.date>=? AND p.bet_type='sanrentan'`).get(jcd, from)
    return {
      jcd, venue: VENUE[jcd], period: { from, to: today() },
      by_course: course.map((c) => ({ course: c.course, starts: c.n, win_rate: pct(c.w, c.n), top2_rate: pct(c.t2, c.n), top3_rate: pct(c.t3, c.n) })),
      kimarite: km.map((x) => ({ kimarite: x.k, count: x.n, share: pct(x.n, tot) })),
      course1_win_rate_by_month: monthly.map((x) => ({ month: x.m, races: x.n, win_rate: pct(x.w, x.n) })),
      course1_win_rate_by_race_no: byRace.map((x) => ({ race_no: x.race_no, races: x.n, win_rate: pct(x.w, x.n) })),
      trifecta: { avg_payout: pay?.a ? Math.round(pay.a) : null, races: pay?.n ?? 0, over_10000_rate: pct(pay?.man ?? 0, pay?.n ?? 0) },
    }
  })
}

// ---------- 一覧（自己紹介） ----------
const INDEX = {
  api: '凪の予想配信 データAPI', version: API_VERSION,
  doc: '競艇予想フォルダの「API仕様.md」',
  note: '時刻はすべて日本時間。date を省くと今日。access=paid の項目はnoteで販売中の買い目なので、公開サイトには出さないこと。',
  endpoints: [
    { path: '/api/v1/races?date=YYYY-MM-DD', access: 'free', what: 'その日の全レース一覧（締切・開催・本命・結果）' },
    { path: '/api/v1/race?id=YYYYMMDD-JJ-RR', access: 'free + paid', what: '1レースの全部（出走表・選手データ・1着確率・展開予想・結果、paid部分に買い目）' },
    { path: '/api/v1/tenkai?date=YYYY-MM-DD', access: 'free', what: '全レースの展開予想（本線・対抗・決まり手の確率・一言）' },
    { path: '/api/v1/picks?date=YYYY-MM-DD', access: 'paid', what: 'その日に記録した買い目（2点プラン・4点・無料枠・B2）と的中' },
    { path: '/api/v1/results?days=30', access: 'free', what: '実績（日別・合計の的中率と回収率。外れた日も含む）' },
    { path: '/api/v1/features?date=YYYY-MM-DD', access: 'free', what: 'トップの特集：ガチガチ/穴レース（AIの確率）・前づけ/チルト跳/まくり/スタートのアラート（当日の直前情報）' },
    { path: '/api/v1/analysis?kind=average|ranking|demoku|yusho', access: 'free', what: 'データ分析：全国/場のコース別平均・コース別ランキングとST・出目分析・優勝戦の結果' },
    { path: '/api/v1/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD', access: 'free', what: '開催予定（場・期間・グレード・開催名・出場予定の人数）' },
    { path: '/api/v1/meeting?jcd=1..24&start=YYYY-MM-DD', access: 'free', what: '1つの開催の出場予定選手（あっせん）' },
    { path: '/api/v1/racers', access: 'free', what: '選手一覧（直近180日に出走した全選手）' },
    { path: '/api/v1/racer?id=NNNN', access: 'free', what: '選手（期別成績・直近1年の成績・コース別/場別/グレード別/時間帯別・1コースの逃げ率と負け方・前づけ・優勝/優出・事故・過去の節・本日の出走・直近20走）' },
    { path: '/api/v1/venue?jcd=1..24', access: 'free', what: '場（コース別1着率・決まり手・1コースの月別/レース番号別の強さ・平均配当）' },
    { path: '/plan2.json?date=YYYY-MM-DD', access: 'paid', what: 'note記事の自動生成用（3連複2点プラン）。status=empty なら記事を作らない' },
  ],
}

// ---------- 入口 ----------
export function apiRoute(u, res) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(obj, null, 1))
  }
  const date = u.searchParams.get('date') || today()
  const p = u.pathname.replace(/\/+$/, '')
  if (p === '/api' || p === '/api/v1') return send(200, INDEX)
  if (!isDate(date)) return send(400, { error: 'date は YYYY-MM-DD で指定してください' })
  let db
  try {
    db = open()
    const stamp = { api_version: API_VERSION, now: jst().toISOString().replace('T', ' ').slice(0, 16) }
    if (p === '/api/v1/races') {
      const ctx = dayContext(db, date)
      const ids = raceIds(ctx)
      return send(200, { ...stamp, date, status: ids.length ? 'ok' : 'empty',
        prediction_ready: !!ctx.pred, prediction_generated_at: jstStamp(ctx.pred?.generatedAt),
        races: ids.map((id) => buildRace(db, date, id, ctx, false)) })
    }
    if (p === '/api/v1/race') {
      const id = u.searchParams.get('id') ?? ''
      if (!/^\d{8}-\d{2}-\d{2}$/.test(id)) return send(400, { error: 'id は YYYYMMDD-JJ-RR（例 20260921-05-07）' })
      const d = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`
      const ctx = dayContext(db, d)
      if (!ctx.meta.has(id) && !ctx.ents.has(id) && !ctx.predById.has(id)) return send(404, { error: 'そのレースは見つかりません', id })
      return send(200, { ...stamp, prediction_generated_at: jstStamp(ctx.pred?.generatedAt), race: buildRace(db, d, id, ctx, true) })
    }
    if (p === '/api/v1/tenkai') {
      const ctx = dayContext(db, date)
      if (!ctx.pred) return send(200, { ...stamp, date, status: 'empty', message: `${date} の予想はまだありません`, races: [] })
      const out = raceIds(ctx).filter((id) => ctx.predById.has(id)).map((id) => {
        const b = buildRace(db, date, id, ctx, false)
        return { race_id: id, venue: b.venue, race_no: b.race_no, deadline: b.deadline, series: b.series, closed: b.closed,
          result: b.result, tenkai: tenkaiOf(db, ctx.predById.get(id), ctx.ents.get(id)) }
      })
      return send(200, { ...stamp, date, status: 'ok', prediction_generated_at: jstStamp(ctx.pred.generatedAt), races: out })
    }
    if (p === '/api/v1/picks') {
      const ctx = dayContext(db, date)
      const out = [...ctx.picks].map(([id, v]) => {
        const b = buildRace(db, date, id, ctx, false)
        return { race_id: id, venue: b.venue, race_no: b.race_no, deadline: b.deadline, closed: b.closed, cancelled: b.cancelled, result: b.result, ...v }
      }).sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
      return send(200, { ...stamp, access: 'paid', date, status: out.length ? 'ok' : 'empty',
        message: out.length ? null : `${date} の買い目はまだありません（生成前か、夜間の処理が止まっています）`, races: out })
    }
    if (p === '/api/v1/results') {
      const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days') || 30)))
      return send(200, { ...stamp, ...resultsSummary(db, days) })
    }
    if (p === '/api/v1/analysis') {
      const kind = u.searchParams.get('kind') ?? ''
      const a = ['average', 'ranking', 'demoku', 'yusho'].includes(kind) ? analysisOf(db, kind) : null
      return a ? send(200, { ...stamp, kind, ...a }) : send(400, { error: 'kind は average / ranking / demoku / yusho' })
    }
    if (p === '/api/v1/schedule') {
      const from = isDate(u.searchParams.get('from')) ? u.searchParams.get('from') : today()
      const to = isDate(u.searchParams.get('to')) ? u.searchParams.get('to') : addDays(from, 40)
      return send(200, { ...stamp, from, to, meetings: scheduleOf(db, from, to) })
    }
    if (p === '/api/v1/meeting') {
      const m = meetingOf(db, Number(u.searchParams.get('jcd')), u.searchParams.get('start') ?? '')
      return m ? send(200, { ...stamp, meeting: m }) : send(404, { error: 'その開催は見つかりません（jcd と start=初日 YYYY-MM-DD）' })
    }
    if (p === '/api/v1/features') return send(200, { ...stamp, date, ...featuresOf(db, date, dayContext(db, date)) })
    if (p === '/api/v1/racers') return send(200, { ...stamp, note: '直近180日に出走した選手。勝率は最新の期別成績', racers: racerList(db) })
    if (p === '/api/v1/racer') {
      const id = Number(u.searchParams.get('id'))
      if (!id) return send(400, { error: 'id に登録番号を指定してください（例 4320）' })
      const r = racerOf(db, id)
      return r ? send(200, { ...stamp, racer: r }) : send(404, { error: 'その選手は見つかりません', id })
    }
    if (p === '/api/v1/venue') {
      const jcd = Number(u.searchParams.get('jcd'))
      if (!(jcd >= 1 && jcd <= 24)) return send(400, { error: 'jcd は 1〜24（例 5=多摩川）', venues: VENUE.slice(1).map((v, i) => ({ jcd: i + 1, venue: v })) })
      return send(200, { ...stamp, venue: venueOf(db, jcd) })
    }
    return send(404, { error: 'そのURLはありません', see: '/api/v1' })
  } catch (e) {
    return send(500, { error: 'データの取得に失敗しました', detail: String(e?.message ?? e) })
  } finally { try { db?.close() } catch {} }
}
