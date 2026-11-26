#!/usr/bin/env bash
# 静的HTML（検索エンジンとSNSが見るほう）を作り直して公開する。
# 毎晩 23:40 の boatrace-publish タスクから auto-publish.bat 経由で呼ばれる。
# 中身と順番は scripts/publish-static.mjs に書いてある。レース中は自分で止まる。
set -u
cd "$(dirname "$0")/.." || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
node scripts/publish-static.mjs
exit $?
