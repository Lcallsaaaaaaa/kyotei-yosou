import { readFileSync, writeFileSync } from 'node:fs'
const p = 'scripts/strategy.mjs'
let s = readFileSync(p, 'utf8')
const NL = '\n'
const a = 'export const MARGIN = 2.0            // 損益分岐に対する余裕'
if (!s.includes(a)) { console.log('N'); process.exit(1) }
const b = [
  '// ★2026-08-31 全面変更（本人承認）',
  '//   ① 対象を本命1艇 → **全6艇** に広げた',
  '//   ② 確率を **校正**してから必要倍率を計算する（calib.mjs）',
  '//   ③ 余裕を 2.0 → **1.3** に下げた',
  '//   ④ 1日の上限を撤廃',
  '//   歩進検証（45,273レース・2025-11〜2026-08・実際の払戻ベース）:',
  '//     1日46.6本／的中15.74%／平均払戻1,052円／**回収165.58%**／9ヶ月すべて100%超',
  '//   旧条件（本命1艇・余裕2.0・校正なし）は 1日3本・回収193.9% と出ていたが、',
  '//   本数が少なく1日の利益は+847円。新条件は+4,221円で5倍。',
  '//   ⚠ 1レースで複数該当したら**全部買う**。1艇に絞ると回収が9〜21pt下がる（実測）。',
  'export const MARGIN = 1.3            // 損益分岐に対する余裕（校正後の確率に掛ける）',
  'export const USE_CALIB = true        // 確率を校正してから判定するか',
  'export const ALL_LANES = true        // 本命1艇でなく全6艇を対象にするか',
].join(NL)
s = s.replace(a, b)
s = s.replace('export const MAX_BUY = 3             // 単勝は3本まで',
  'export const MAX_BUY = 999           // 上限なし（2026-08-31に3本から変更）')
writeFileSync(p, s)
console.log('ok')
