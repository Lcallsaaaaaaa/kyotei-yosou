#!/bin/bash
# 前日ぶんの判定と結果をまとめる（毎日15:30・auto-results.bat から呼ばれる）。
#
#   bash scripts/results.sh
#
# ★2026-10-15に .bat の中の長い1行から切り出した。
#   理由：**スリープ抑止（keepawake-run.ps1）に渡せるのは .sh のパスだけ**で、
#   .bat に直接書いた複合コマンドは渡せなかった。
#   10/15、実行中にPCが寝て 05:00・06:00・15:30 のタスクが3本とも途中で死に、
#   その日のニュース記事が1本も作られなかった（[[boatrace-sleep-kills-batch]]）。
#
# ★順番に意味がある（元の .bat のコメントをそのまま引き継ぐ）
#   auto-catchup（15:00）がKファイル・オッズ・締切を取り込んだ後に走るので、通信は要らない。
#   1. paper-day    前日ぶんを「紙の上で」1日分判定する（全レース・締切前オッズのみ・締切順・1日の上限つき）
#   2. results      実際に買ったぶん（bets）を精算する
#   3. paper-report 1の判定を払戻と突き合わせて採点する
#   4. x-post       結果の投稿文を作る
#   ⚠ bt-build は 2026-10-09 にここから外した（night.sh の05:00へ移動）。
#     レース中に8GBのヒープを要求して常駐5本をメモリから追い出し、サイトの更新を40分止めた。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/c/Program Files/nodejs:$PATH"

TODAY="$(date +%F)"
YDAY="$(date -d '1 day ago' +%F)"

node scripts/paper-day.mjs --date "$YDAY" > "logs/paper-$YDAY.txt" 2>&1
node scripts/results.mjs > "logs/results-$TODAY.txt" 2>&1 \
  && node scripts/paper-report.mjs --date "$YDAY" >> "logs/results-$TODAY.txt" 2>&1
node scripts/x-post.mjs --result >> "logs/results-$TODAY.txt" 2>&1
exit 0
