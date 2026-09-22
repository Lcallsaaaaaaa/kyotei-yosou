#!/bin/bash
# 当日の準備と全レース予想（毎朝6時）。
#
#   bash scripts/morning.sh
#
# ★前提
#   朝5時の night.sh が前日ぶんの結果・オッズ・直前情報を取り込み済み。
#   ここでは当日の番組表を入れ、特徴量を作り直し、全レースを予想して記録する。
#
# ★予想は1日固定
#   展示タイムなどの直前情報は締切間際にしか出ないので、朝の予想には入らない。
#   実測では直前情報を入れても1着で+0.24pt・2連単4点で+1.06ptで、
#   レースごとに計算し直す作りに変える価値は無いと判断した（2026-08-29）。
set -e
export PATH="/c/Program Files/nodejs:$PATH"
cd "/c/Users/sames/Desktop/競艇予想"

TODAY=$(date +%Y-%m-%d)
echo "=== $TODAY 06:00  当日の準備と予想 ==="

echo "--- 1/9 当日の番組表を取り込み ---"
node scripts/download.mjs "$TODAY" "$TODAY" 2>&1 | tail -2
node scripts/extract.mjs 2>&1 | tail -1
node scripts/build.mjs 2>&1 | tail -2

echo "--- 2/9 特徴量を作り直し ---"
node --max-old-space-size=8192 scripts/derive.mjs 2>&1 | tail -2
node --max-old-space-size=8192 scripts/addbefore.mjs 2>&1 | tail -2

echo "--- 3/9 当日の全レースを予想 ---"
# ⚠ --trio を外すと JSON が出ない（出力は --trio の枝の中にある）。
#    外すと record3.mjs が何も記録できなくなる。
node --max-old-space-size=6144 scripts/predict.mjs --date "$TODAY" --trio --json \
  --out "data/predict-$TODAY.json" 2>&1 | tail -3

echo "--- 4/9 B2判定（唯一の実行可能な買い方）---"
# 本命がB2級かつ確率40%未満なら単勝1点。オッズを使わないので朝に確定する。
# 1日平均0.85本、43%の日は0本。過去298日で254本・的中36.2%・回収131.5%。
node scripts/b2.mjs --date "$TODAY" 2>&1 | tail -5

echo "--- 5/9 朝の見張り表を作る ---"
# 「どのレースのどの艇を、オッズいくら以上で買うか」の一覧。
# スマホから http://<PCのIP>:3940/asa で見る。
node --max-old-space-size=4096 scripts/watchlist.mjs --date "$TODAY" 2>&1 | tail -5

echo "--- 6/9 3連単・3連複・2連単を記録 ---"
# 買うためではなく、2着3着のデータをためるため。全レース分。
# 単勝の買い判定（auto-bet.mjs → bets）とは別テーブル。
node scripts/record3.mjs --date "$TODAY" 2>&1 | tail -2

echo "--- 7/9 配信用を作る ---"
# ⚠ これは買う判定ではない。当てることを優先した3連複/3連単で、回収率はマイナス。
#   自信度（3連複の上位4点の確率の合計）が0.83以上のレースだけ。1日15本前後。
#   スマホから http://<PCのIP>:3940/haishin で見る。
node scripts/haishin.mjs --date "$TODAY" 2>&1 | tail -2

echo "--- 8/9 無料枠（単勝1点・1着確率80%以上）---"
# ⚠ 02:00の night2.sh が落ちたときの保険。2026-09-12に実際に落ちて（PCがスリープに入り
#   工程3/8で強制終了）、無料枠と企画枠がまるごと記録されなかった。
#   締切を過ぎたレースは記録しない作りなので、ここで拾えるのは06:00以降のレースだけ。
node scripts/tansho.mjs --date "$TODAY" 2>&1 | tail -3

echo "--- 9/9 企画枠（SG/G1/G2を自動判別）---"
node scripts/spot.mjs --date "$TODAY" --auto 2>&1 | tail -4

echo "--- ニュースの自動生成（前日の結果・今日の開催・グレード開催の予告・予想の結果）---"
# 2026-09-23：データの事実だけで書く。content/news/ に置く（公開は sync-public.mjs）
node --max-old-space-size=4096 scripts/news.mjs 2>&1 | tail -1

echo ""
echo "=== 完了 $(date +%H:%M:%S) ==="
echo "  見張り表:      http://localhost:3940/asa"
echo "  配信用:        http://localhost:3940/haishin"
echo "  配信の文面:    node scripts/haishin.mjs --date $TODAY --text"
echo "  3連複2点プラン: http://localhost:3940/plan2"
echo "  2点の文面:     node scripts/haishin.mjs --date $TODAY --text --n 2"
