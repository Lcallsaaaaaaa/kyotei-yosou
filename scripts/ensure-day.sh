#!/bin/bash
# その日の持ち物が欠けていたら作り直す（30分ごと・auto-ensure.bat から呼ばれる）。
#
#   bash scripts/ensure-day.sh
#
# ★なぜ .sh を挟むのか
#   **スリープ抑止（keepawake-run.ps1）に渡せるのは .sh のパスだけ**。
#   .bat に書いた複合コマンドは渡せない（scripts/results.sh と同じ理由）。
#   ふだんは数秒で終わるが、予想を作り直す回は derive/addbefore で40分かかるので、
#   その間に寝られると直す係ごと死ぬ。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/c/Program Files/nodejs:$PATH"

# ⚠ ここでログへリダイレクトしないこと（2026-10-20に踏んだ）。
#   auto-ensure.bat が同じ logs/ensure-run-<日付>.log を開いたまま呼ぶので、
#   Windows のロックで "Device or resource busy" になり **中身が一切動かない**。
#   それでも .bat は exit 0 と報告する。画面に出せば .bat 側が拾ってくれる。
# ⚠ 終了コードをそのまま返すこと（2026-10-22に踏んだ）。
#   `exit 0` で握りつぶしていたので、中身が失敗してもタスクの結果は 0（成功）になり、
#   10/22は60分の無駄骨を2回繰り返しながら**どちらも「成功」と記録**されていた。
#   kesson.mjs が作られた原因そのもの（動いているのに何も作っていない）を再現していた。
node scripts/ensure-day.mjs
exit $?
