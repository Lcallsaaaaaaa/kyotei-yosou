#!/bin/bash
# 今日の分を手で作り直す（番組表はすでにDBに入っている前提）。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
TODAY="$(date +%F)"
echo "=== $TODAY 復旧開始 $(date +%H:%M:%S) ==="
echo "--- 1/7 グレード判定 ---"
node scripts/grade.mjs --apply 2>&1 | tail -2
echo "--- 2/7 特徴量 $(date +%H:%M:%S) ---"
node --max-old-space-size=8192 scripts/derive.mjs 2>&1 | tail -2
echo "--- 3/7 直前情報 $(date +%H:%M:%S) ---"
node --max-old-space-size=8192 scripts/addbefore.mjs 2>&1 | tail -1
echo "--- 4/7 予想 $(date +%H:%M:%S) ---"
node --max-old-space-size=6144 scripts/predict.mjs --date "$TODAY" --trio --json --nobefore --out "data/predict-$TODAY.json" 2>&1 | tail -2
echo "--- 5/7 配信 $(date +%H:%M:%S) ---"
node scripts/haishin.mjs --date "$TODAY" 2>&1 | tail -2
echo "--- 6/7 無料枠 ---"
node scripts/tansho.mjs --date "$TODAY" 2>&1 | tail -2
echo "--- 7/7 B2・企画枠 ---"
node scripts/b2.mjs --date "$TODAY" 2>&1 | tail -2
node scripts/spot.mjs --date "$TODAY" --auto 2>&1 | tail -3
echo "=== 完了 $(date +%H:%M:%S) ==="
