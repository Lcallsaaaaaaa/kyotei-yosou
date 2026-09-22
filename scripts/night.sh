#!/bin/bash
# 前日の結果を集めて分析する（毎朝5時）。
#
#   bash scripts/night.sh
#
# ★なぜ朝5時か
#   前日の全レースが終わっていて、確定オッズも配当も出そろっている。
#   ここで前日ぶんを固めておけば、6時の予想が最新の特徴量で走れる。
#
# ★やること
#   1. 前日までの結果（Kファイル）を取り込む
#   2. 前日の確定オッズ（単勝・複勝／2連単2連複／3連単3連複）と直前情報を取る
#   3. 前日に記録した予想に、当たり・払戻を埋める
#   4. たまった分の成績を出す
set -e
export PATH="/c/Program Files/nodejs:$PATH"
cd "/c/Users/sames/Desktop/競艇予想"

TODAY=$(date +%Y-%m-%d)
YEST=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
echo "=== $TODAY 05:00  前日($YEST)の収集と分析 ==="

echo "--- 1/4 前日までの結果を取り込み ---"
node scripts/daily.mjs 2>&1 | tail -3

echo "--- 2/4 前日の確定オッズと直前情報 ---"
node scripts/odds.mjs  --from "$YEST" --to "$YEST" --conc 6 --delay 60 2>&1 | tail -1
node scripts/odds2.mjs --from "$YEST" --to "$YEST" --conc 6 --delay 60 2>&1 | tail -1
node scripts/odds3.mjs --from "$YEST" --to "$YEST" --conc 6 --delay 60 2>&1 | tail -1
node scripts/before.mjs --from "$YEST" --to "$YEST" --conc 6 --delay 60 2>&1 | tail -1

# ★開催のグレードを判定して races.grade に書く。
#   build.mjs は grade を書かないので、これを回さないと NULL のままになる。
#   2026-08-19〜09-05 の18日ぶんが空のまま気づかず、企画枠の自動判別ができなかった。
#   判定は開催名から行い、1号艇のA1率で検算している（SG/G1は98.5%、G3以下は13〜21%）。
node scripts/grade.mjs --apply 2>&1 | tail -2

echo "--- 3/4 前日の予想に結果を埋める ---"
node scripts/record3.mjs --fill 2>&1 | tail -2
# 配信用（3連複/3連単）も同じタイミングで照合する。買う判定とは別テーブル。
# 当日は公式の結果ページ（速報）で埋めているので、--recheck で競走成績と突き合わせ直す。
# 食い違いがあれば警告が出る。速報の取り違えが残らないようにするため。
node scripts/haishin.mjs --fill --date "$YEST" --recheck 2>&1 | tail -3
# B2判定も競走成績で照合し直す（当日は速報で埋めている）
node scripts/b2.mjs --fill --date "$YEST" 2>&1 | tail -1
# 無料枠（単勝1点）も競走成績で照合し直す
node scripts/tansho.mjs --fill --date "$YEST" --recheck 2>&1 | tail -2
# 取りこぼした古い日ぶんも拾う（速報が取れなかった日など）
node scripts/haishin.mjs --fill 2>&1 | tail -1
node scripts/tansho.mjs --fill 2>&1 | tail -1

echo "--- 4/4 たまった分の成績 ---"
node scripts/record3.mjs --report 2>&1 | tail -22
echo ""
echo "--- 配信用の成績 ---"
node scripts/haishin.mjs --report 2>&1 | tail -18
echo ""
echo "--- 無料枠（単勝1点）の成績 ---"
node scripts/tansho.mjs --report 2>&1 | tail -14
echo ""
echo "--- B2判定の成績 ---"
node scripts/b2.mjs --report 2>&1 | tail -12

echo ""
echo "--- 単勝の判定記録（bets）---"
node -e "
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync('data/boatrace.db')
const y = process.argv[1]
const r = db.prepare(\`SELECT decision, COUNT(*) n FROM bets WHERE date=? GROUP BY decision\`).all(y)
console.log('  ' + y + ': ' + (r.map(x => x.decision + ' ' + x.n).join(' / ') || '記録なし'))
db.close()
" "$YEST"

echo ""
echo "=== 完了 $(date +%H:%M:%S) ==="
