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

# ★重い処理が重なっていないか確かめてから始める（2026-11-12）。
#   このスクリプトは長らく**何も確認せずに derive を始めて**いた。
#   搭載7.8GBのこの機械では derive が2本走ると食い合って共倒れする
#   （heavy.mjs の注意書きのとおり）。
#   11/12 01:31、当日ぶんが無いので ensure-day を手で走らせた直後に、
#   02:00 の night2 がそこへ突っ込む形になりかけた。
#   走っているなら2分おきに最大60分待つ。それでも終わらなければ今回は見送る。
#   見送っても ensure-day（06:30〜22:30・30分毎）と recover.mjs が拾うので、
#   当日ぶんが消えることはない。
for i in $(seq 1 30); do
  node scripts/heavy.mjs --quiet && break
  echo "重い処理が走っています。2分待ちます（$i/30）"
  sleep 120
done
if ! node scripts/heavy.mjs --quiet; then
  echo "重い処理が終わらないので今回は見送ります（ensure-day が拾います）"
  exit 0
fi

echo "--- 1/9 当日の番組表を取り込み ---"
node scripts/download.mjs "$TODAY" "$TODAY" 2>&1 | tail -2
node scripts/extract.mjs 2>&1 | tail -1
# ⚠ ANALYZE は飛ばす（13分かかる）。前日の結果を入れる 05:00 と 15:00 で流している。
# ⚠ 範囲も絞る（2026-11-13）。
#   ここは長らく範囲指定なし＝**全期間1,549ファイルの作り直し**だった。
#   それが役目という設計だったが、搭載7.8GBのこの機械では終わらない。
#   実際 night2 は 11/07 を最後に**一度も完走していない**（ログが step 1/9 で止まる）。
#   11/13 02:05 に始まった build は16分たって実メモリ1MB＝完全に追い出されていた。
#   全期間の作り直しは catchup(15:00) が同じ `build.mjs`（範囲なし）で担当しているので、
#   ここは直近14日で足りる。morning.sh が 10/22 に同じ理由で絞ったのと同じ判断。
SINCE=$(date -d '14 days ago' +%F)
node scripts/build.mjs --since "$SINCE" --no-analyze 2>&1 | tail -2

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

echo "--- 9/9 モデルの再学習は別タスクへ移しました（2026-10-20）---"
# ★ここに `bash scripts/retrain.sh` があったが、タスク boatrace-retrain へ切り出した。
#   理由：**1〜8 の途中で死ぬと 9 まで届かず、再学習が丸ごと飛ぶ**。
#   10/18・10/19・10/20 と3日続けて飛び、本番モデルは10/17のまま止まっていた。
#   一番長い処理の一番最後は、一番落ちやすい場所だった。
#
#   新しい置き場：scripts/auto-retrain.bat → ensure-retrain.sh → retrain.sh
#     03:30 から30分ごと・09:00 まで。回すかは retrain-needed.mjs が決める
#     （今日もう済んだ／重い処理が走っている／feat が古い／3回試した→回さない）。
#   ⚠ ここに戻さないこと。戻すと二重に走る（needed 判定で片方は空振りするが無駄）。
echo "  → タスク boatrace-retrain が 03:30〜09:00 に面倒を見ます"

echo ""
echo "=== 完了 $(date +%H:%M:%S) ==="
echo "  配信用:  http://localhost:3940/haishin"
echo "  2点プラン: http://localhost:3940/plan2"
echo "  企画枠:  http://localhost:3940/spot"
