// 試し読み：登録していない人にも**毎日1レースだけ**無料予想を見せる（2026-10-10 本人指示）。
//
//   「サイトを見るだけなら毎日1レース／それ以外を見るならLINE登録／そのあと、有料会員」
//
// ★なぜ要るのか
//   それまで未登録の人には**1本も見せていなかった**（鍵のかかった案内だけ）。
//   検索やSNSから来た人は中身を一切見ないまま帰るので、入口が閉じていた。
//   英語圏の調査でも「無料の出し方を変える」が効くとなったので、1本だけ開ける。
//
// ★なぜ「日ごとに1回だけ決めて固定」するのか（ここが肝）
//   predict-<日付>.json は**最終レース後まで何度も作り直される**
//   （[[boatrace-predict-file-rewritten]]）。そのつど「15時にいちばん近い無料枠」を
//   選び直すと、更新のたびに別のレースが出る。未登録の人は**画面を開き直すだけで
//   何本も見えてしまう**＝「毎日1レース」が崩れる。
//   だから最初に決めたものを data/taster.json に書いて、その日は二度と変えない。
//
// ★置き場のこと
//   出すのは taster/<日付>（誰でも読める）で、**中に入るのは1本だけ**。
//   「全部置いて画面で1本だけ描く」は駄目。/data/member/free/<日付>.json を
//   直接叩かれて素通しになる（アラートで同じ失敗をしかけた）。
import { readFileSync, writeFileSync } from 'node:fs'

/** 試し読みの pick に入れてよい項目。これ以外が来たら送信を止める。 */
export const TASTER_FIELDS = new Set(['race_id', 'jcd', 'venue', 'race_no', 'deadline', 'closed',
  'lane', 'racer', 'win_probability', 'hit', 'payout'])

/** 15:00。昼過ぎなら、朝に見た人はまだ締切前・夜に見た人は結果まで見られる。 */
export const TASTER_TARGET = 15 * 60

/** 試し読みの中身を確かめる。1本だけ・決まった項目だけ・ほかの予想物なし。
 *  ⚠ 公開側の見張り（assertNoPaid）を緩めるのではなく、**ここだけ別の見張りに差し替える**。 */
export function assertTaster(key, obj) {
  const s = JSON.stringify(obj)
  for (const bad of ['"prediction":', '"picks":', '"trio":[', '"trifecta":[', '"exacta":[', '"tenkai":{', '"honmei"'])
    if (s.includes(bad)) throw new Error(`${key} に ${bad} が入っている。送らずに止める`)
  if (obj == null || typeof obj !== 'object') throw new Error(`${key} が壊れている`)
  if (!('pick' in obj)) throw new Error(`${key} に pick が無い`)
  if (obj.pick === null) return                      // その日まだ無い（空で出すのは正常）
  if (typeof obj.pick !== 'object') throw new Error(`${key} の pick が壊れている`)
  if (Array.isArray(obj.pick)) throw new Error(`${key} の pick が配列になっている。試し読みは1本だけ`)
  for (const k of Object.keys(obj.pick))
    if (!TASTER_FIELDS.has(k)) throw new Error(`${key} の pick に許していない項目 ${k} がある。送らずに止める`)
  if (!obj.pick.race_id) throw new Error(`${key} の pick に race_id が無い`)
}

const mins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''))
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  return h <= 23 && mm <= 59 ? h * 60 + mm : null
}

/** 締切が 15:00 にいちばん近いものを選ぶ。同じ距離なら race_id の小さいほう（毎回同じ答えにする）。 */
export function chooseTaster(picks) {
  if (!picks?.length) return null
  return picks.slice().sort((a, b) => {
    const da = mins(a.deadline), db = mins(b.deadline)
    const ka = da == null ? 1e9 : Math.abs(da - TASTER_TARGET)
    const kb = db == null ? 1e9 : Math.abs(db - TASTER_TARGET)
    return ka - kb || String(a.race_id).localeCompare(String(b.race_id))
  })[0]
}

/** 固定してよいか。まだ一部しか出ていないうちに決めると、朝の終わったレースで1日が終わる。
 *  ⚠ 無料枠は朝にまとめて出るが、常駐は深夜から回っている。その日いちばん最初の回で
 *    「08:35の1本だけ」を掴むと、**その日の試し読みが朝に終わったレースになる**。
 *    午後の枠が入っているか、もう昼を過ぎているときだけ決める。 */
export function canPin(picks, nowMin) {
  if (!picks?.length) return false
  if (picks.some((p) => { const m = mins(p.deadline); return m != null && m >= 14 * 60 })) return true
  return nowMin != null && nowMin >= 12 * 60   // 午後の枠が無い日は、昼を過ぎたら決めてしまう
}

const nowJstMin = () => { const d = new Date(Date.now() + 9 * 3600e3)
  return d.getUTCHours() * 60 + d.getUTCMinutes() }

/**
 * その日の試し読み1本を返す。いちど決めたら動かさない。
 * @param file  固定先（data/taster.json）
 * @param date  YYYY-MM-DD
 * @param picks その日の無料枠（member/free に入れるのと同じ配列）
 * @param opt   { log, keepDays, nowMin }
 */
export function pickTaster(file, date, picks, opt = {}) {
  const log = opt.log ?? (() => {})
  const keepDays = opt.keepDays ?? 60
  let pinned = {}
  try { pinned = JSON.parse(readFileSync(file, 'utf8')) } catch { /* まだ無い */ }
  if (pinned == null || typeof pinned !== 'object' || Array.isArray(pinned)) pinned = {}

  const want = pinned[date]
  if (want) {
    const found = (picks ?? []).find((p) => p.race_id === want)
    if (found) return found
    // 決めたレースが消えた（順延・中止・無料枠から外れた）。印は残したまま、その日は出さない。
    // ★ここで選び直してはいけない。選び直すと「1日1レース」が崩れる。
    return null
  }
  if (!canPin(picks, opt.nowMin ?? nowJstMin())) return null
  const best = chooseTaster(picks)
  if (!best) return null

  pinned[date] = best.race_id
  const cut = new Date(new Date(date + 'T00:00:00Z').getTime() - keepDays * 86400e3).toISOString().slice(0, 10)
  for (const d of Object.keys(pinned)) if (d < cut) delete pinned[d]
  try { writeFileSync(file, JSON.stringify(pinned, null, 2)) }
  catch (e) {
    // 固定できないなら出さない。出すと更新のたびに別のレースが見えてしまう。
    log(`⚠ ${file} に書けません（${e.message}）。固定できないので試し読みは出しません`)
    return null
  }
  return best
}

/** 公開する書類の中身。pick は1本か null。 */
export const tasterDoc = (date, pick, total) => ({ date, pick: pick ?? null, total: total ?? 0 })
