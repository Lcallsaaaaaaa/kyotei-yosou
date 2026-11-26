#!/bin/bash
# 再学習が今日まだ済んでいなければ回す（30分ごと・auto-retrain.bat から呼ばれる）。
#
#   bash scripts/ensure-retrain.sh
#
# ★なぜ night2.sh から切り出したか（2026-10-20）
#   再学習は night2.sh の 9/9（最後）に置いてあった。night2 が 1〜8 の途中で死ぬと
#   **9 まで届かず再学習が丸ごと飛ぶ**。10/18・10/19・10/20 と3日続けて飛び、
#   本番モデルは 10/17 のまま止まっていた。
#   「一番長い処理の、一番最後」は、一番落ちやすい場所だった。
#
# ★回すかどうかは retrain-needed.mjs が決める（終了コード 0=回す / 1=回さない）
#   ・今日もう学習した／重い処理が走っている／昨日の結果が未取り込み／3回試した
#   のどれかなら回さない。だから30分ごとに呼んでも無駄打ちにならない。
#
# ★retrain.sh 自体には手を入れていない
#   合否の門（retrain-gate）も、不合格なら本番を触らない決まりもそのまま。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/c/Program Files/nodejs:$PATH"

if ! node scripts/retrain-needed.mjs; then
  exit 0
fi

# ⚠ 終了コードをそのまま返すこと（2026-10-22）。
#   `exit 0` で握りつぶすと、失敗してもタスクの結果が 0（成功）になり気づけない。
#   ensure-day.sh で同じ握りつぶしを作り、10/22に60分の無駄骨を2回「成功」と記録した。
bash scripts/retrain.sh
exit $?
