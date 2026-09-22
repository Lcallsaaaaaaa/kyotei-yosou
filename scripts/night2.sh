#!/bin/bash
# 当日ぶんを深夜2時に先回りして作る（6時のバッチより前）。
#
#   bash scripts/night2.sh
#
# ★なぜ要るか
#   当日の買い目を作っているのは6時のバッチだけで、PCが寝ていると1日まるごと落ちる
#   （2026-09-01に実際に落ちた）。番組表は前日に公開されるので、展示以外は2時に作れる。
#   展示を入れても精度が変わらないことは2026-08-31に実測済み（57.18% 対 57.38%）。
#   よって2時を本番、6時を保険にする。
#
# ★--nobefore を必ず付ける
#   2時に直前情報を取りに行っても全レース空振りで、5分と150リクエストを捨てるだけ。
#   9/3に実測して確認した（168レース中0レースしか展示が無かった）。
set -e
export PATH="/c/Program Files/nodejs:$PATH"
cd "/c/Users/sames/Desktop/競艇予想"

TODAY=$(date +%Y-%m-%d)
echo "=== $TODAY 02:00  当日ぶんを先回りで作る ==="

echo "--- 1/9 当日の番組表を取り込み ---"
node scripts/download.mjs "$TODAY" "$TODAY" 2>&1 | tail -2
node scripts/extract.mjs 2>&1 | tail -1
# ⚠ ANALYZE は飛ばす（13分かかる）。前日の結果を入れる 05:00 と 15:00 で流している。
node scripts/build.mjs --no-analyze 2>&1 | tail -2

echo "--- 2/9 開催のグレードを判定 ---"
# ⚠ build.mjs は races.grade を書かない。これを回さないと企画枠の自動判別ができない。
#   2026-08-19〜09-05 の18日ぶんが空のままだった。
node scripts/grade.mjs --apply 2>&1 | tail -2

echo "--- 3/9 特徴量を作り直し ---"
node --max-old-space-size=8192 scripts/derive.mjs 2>&1 | tail -2
node --max-old-space-size=8192 scripts/addbefore.mjs 2>&1 | tail -1

echo "--- 4/9 当日の全レースを予想 ---"
node --max-old-space-size=6144 scripts/predict.mjs --date "$TODAY" --trio --json --nobefore \
  --out "data/predict-$TODAY.json" 2>&1 | tail -2

echo "--- 5/9 配信用（自信度0.7645以上）---"
node scripts/haishin.mjs --date "$TODAY" 2>&1 | tail -2

echo "--- 6/9 無料枠（単勝1点・1着確率80%以上）---"
# ⚠ 2/7 のグレード判定より後に置くこと。races.grade が空のまま予想すると
#   高確率帯の較正が壊れる（2026-08-19〜09-05 が実際に空で、前向き実測が
#   検証値96.3%に対し84.0%まで落ちた）。
node scripts/tansho.mjs --date "$TODAY" 2>&1 | tail -2

echo "--- 7/9 B2判定（本命B2級・確率40%未満＝実際に買う候補。記録のみ）---"
# ⚠ これまで06:00の morning.sh だけが記録していた。06:00にPCが寝ていると丸1日抜ける
#   （2026-09-01・09-11 が実際に抜けた）。予想ができたこの時点で記録する。
#   morning.sh 側でもう一度走っても、結果が出た行は書き換えない作りなので壊れない。
node scripts/b2.mjs --date "$TODAY" 2>&1 | tail -4

echo "--- 8/9 企画枠（SG/G1/G2を自動判別）---"
node scripts/spot.mjs --date "$TODAY" --auto 2>&1 | tail -6

echo "--- 9/9 モデルを最新データで学習し直す（合格したときだけ入れ替え）---"
# ★2026-09-14に追加。本番モデルは9/6に作ったきりで、学習データが4/5で止まっていた。
#   同じレースで比べると新しいデータで学習したほうが確率の見積もりが正確だった（retrain.sh 冒頭に数字）。
#   ⚠ 予想と記録（1〜8）が全部終わってから回す。今日の予想は前のモデルのまま、
#     入れ替わった新モデルは 06:00 の朝の更新から使われる。
#   ⚠ 失敗しても今日の予想には影響しない（パイプの末尾が tail なので set -e で止まらない）。
bash scripts/retrain.sh 2>&1 | tail -25

echo ""
echo "=== 完了 $(date +%H:%M:%S) ==="
echo "  配信用:  http://localhost:3940/haishin"
echo "  2点プラン: http://localhost:3940/plan2"
echo "  企画枠:  http://localhost:3940/spot"
