#!/bin/bash
# 指定時刻まで待って予想を出す。
#   bash scripts/auto-run.sh 1605 11 びわこ12R 16:25
# 時計を見て判定するので、途中で止めても再起動すればずれない。
export PATH="/c/Program Files/nodejs:$PATH"
cd "/c/Users/sames/Desktop/競艇予想"
TARGET=$1; JCD=$2; LABEL=$3; DEADLINE=$4
while [ "$(date +%H%M)" -lt "$TARGET" ]; do sleep 15; done
echo "=== $(date '+%H:%M:%S') 実行  $LABEL  締切 $DEADLINE ==="
node --max-old-space-size=6144 scripts/predict.mjs --date 2026-08-20 --jcd "$JCD" --trio
