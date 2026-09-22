#!/bin/bash
# モデルを最新データで学習し直す（毎日・night2.sh の最後に呼ぶ）。
#
#   bash scripts/retrain.sh
#   node scripts/retrain-gate.mjs --history     これまでの記録
#
# ★なぜ要るか（2026-09-14）
#   本番モデルは 2026-09-06 に一度作ったきりで、重みを学習したデータは 2026-04-05 まで。
#   それ以降の約5か月（24,747レース）が学習に入っていなかった。
#   同じ 8/6〜9/12 の5,949レースで比べると、学習を 4/5→7/6 まで延ばしたモデルは
#     1着logloss 1.2045→1.1990 ／ 3連単logloss 3.8418→3.8331（日単位ブートストラップで100%）
#     無料枠 予想85.1%→実際80.2% が 85.0%→82.0% に（自信過剰が縮んだ）・回収91.9%→93.9%
#     1着的中は差なし（56.53% 対 56.46%）
#   → 新しいデータで学習し直すほうが、確率の見積もりが正確になる。
#
# ★やること
#   1. 直近28日を学習に使わず残し（＝閾値の元・合否判定に使う）、その手前まで学習
#   2. retrain-gate.mjs --judge で合否（最低ライン＋前のモデルと同じレースで比較）
#   3. 合格なら朝モデル・フルモデル・pred3 をまとめて入れ替え。前のものは *.prev に退避
#      不合格なら何も変えない
#   ⚠ 本番の data/model5.json と pred3 は、合格した場合にしか触らない。
#   ⚠ 1回5分×2本ほど。night2.sh の中で走るので、スリープ抑止が効いている。
set -u
export PATH="/c/Program Files/nodejs:$PATH"
cd "/c/Users/sames/Desktop/競艇予想"

read L CALIB_FROM CALIB_TO < <(node scripts/retrain-gate.mjs --dates)
echo "=== 再学習  結果は${L}まで ／ 学習〜${CALIB_FROM} ／ 判定用に残す ${CALIB_FROM}〜${L} ==="

rm -f data/model5.new.json data/model5-full.new.json
node --max-old-space-size=4096 scripts/model5.mjs --morning \
  --train-to "$CALIB_FROM" --calib-to "$CALIB_TO" \
  --pred3-table pred3_new --out data/model5.new.json 2>&1 | grep -E "学習 |補正 |保存|Error|error"
if [ ! -s data/model5.new.json ]; then
  echo "朝モデルの学習に失敗。本番は前のモデルのまま"
  node scripts/retrain-gate.mjs --discard
  exit 1
fi

node scripts/retrain-gate.mjs --judge
VERDICT=$?
if [ "$VERDICT" -ne 0 ]; then
  echo "不合格（コード $VERDICT）。本番は前のモデルのまま"
  node scripts/retrain-gate.mjs --discard
  rm -f data/model5.new.json
  exit 0
fi

# 合格したのでフルモデル（直前情報あり用）も同じ期間で作る
node --max-old-space-size=4096 scripts/model5.mjs \
  --train-to "$CALIB_FROM" --calib-to "$CALIB_TO" \
  --no-pred3 --out data/model5-full.new.json 2>&1 | grep -E "学習 |保存|Error|error"
if [ ! -s data/model5-full.new.json ]; then
  echo "フルモデルの学習に失敗。朝モデルだけ入れ替える（フルは前のまま）"
fi

node scripts/retrain-gate.mjs --adopt
echo "=== 再学習 完了 $(date +%H:%M:%S) ==="
