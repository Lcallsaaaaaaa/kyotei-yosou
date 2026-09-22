#!/bin/bash
# 昼過ぎに前日ぶんを取り込み直す。
#
# ★なぜ必要か
#   公式の競走成績(Kファイル)は翌日の昼頃に公開される。
#   朝の準備では前日ぶんがまだ無い。
#
# ★2026-08-23 に判明した重大な欠陥
#   当日中に取りに行くと、公式は「全レース終了後に登録されます」とだけ書いた
#   小さなファイルを返す。それを保存してしまうと以後ずっと「既存」扱いになり、
#   二度と取り直されない。8/20・8/21 の結果が丸ごとDBから欠けていた。
#   → download.mjs 側で「5KB未満は保存しない／20KB未満は既存とみなさない」よう修正済み。
#   → ここでは **直近3日** を対象にして、取りこぼしを翌日以降に回収できるようにする。
#
# ★監査でFAILが出たら大きく出す
#   以前は先に進んでしまい、欠損に気づけなかった。
export PATH="/c/Program Files/nodejs:$PATH"
cd "$(dirname "$0")/.."

D1=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
D3=$(date -d "3 days ago" +%Y-%m-%d 2>/dev/null || date -v-3d +%Y-%m-%d)
echo "=== $D3 〜 $D1 の取り込み（3日分さかのぼる）==="

node scripts/download.mjs "$D3" "$D1" 2>&1 | tail -4
node scripts/extract.mjs 2>&1 | tail -2
node scripts/build.mjs   2>&1 | tail -3

for s in odds odds2 odds3 before; do
  echo "--- $s ---"
  node scripts/$s.mjs --from "$D1" --to "$D1" --conc 6 --delay 60 2>&1 | tail -1
done

echo ""
echo "=== 記録の照合（Kファイルが届いたので入れ直す）==="
# ⚠ なぜここでやるか（2026-09-12に判明）
#   05:00の night.sh は前日のKファイルが**まだ公開される前**に走っている。
#   公式のKファイルは翌日の昼ごろ公開で、取り込むのはこの15:00の処理。
#   そのため「当日の速報を取り逃したレース」は翌朝も埋まらず、永久に未照合で残っていた。
#   実例: 2026-09-11 の無料枠18本のうち9本（夜のレース。PCがスリープで速報を取れなかった）。
#   Kファイルを取り込んだ直後のここで、直近3日を入れ直す。
for i in 1 2 3; do
  D=$(date -d "$i days ago" +%Y-%m-%d 2>/dev/null || date -v-${i}d +%Y-%m-%d)
  echo "--- $D ---"
  for s in tansho haishin spot b2; do
    node scripts/$s.mjs --fill --date "$D" --recheck 2>&1 | tail -1
  done
done

echo ""
echo "=== オッズの並びの確認（直近30日）==="
# ⚠ なぜ要るか（2026-09-16）
#   公式ページの3連複オッズの並びが8/28に変わっていて、9月ぶんは当たり目のオッズが
#   払戻と59%しか合っていなかった。エラーは一切出ず、検証の数字だけが静かに狂っていた。
#   当たり目のオッズ×100が払戻と合うかを毎日見ておけば、翌日に気づける。
D30=$(date -d "30 days ago" +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d)
if ! node scripts/odds3.mjs --verify --since "$D30"; then
  echo ""
  echo "###############################################"
  echo "# オッズの並びがずれている。検証の数字を使う  #"
  echo "# 前に odds3.mjs を直すこと。                 #"
  echo "###############################################"
fi

echo "=== 監査 ==="
node scripts/audit.mjs 2>&1 | tail -16
if node scripts/audit.mjs 2>&1 | grep -q "FAIL 0"; then
  echo "監査OK"
else
  echo ""
  echo "###############################################"
  echo "# 監査でFAIL。予想の前に必ず直すこと。         #"
  echo "# 欠損日があれば download → extract → build。 #"
  echo "###############################################"
fi
