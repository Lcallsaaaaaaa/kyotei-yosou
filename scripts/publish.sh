#!/usr/bin/env bash
# サイトを公開する（データ送信 → 静的HTML → 点検 → デプロイ）。
#
#   bash scripts/publish.sh
#
# ★これが無いと、朝のバッチで予想ができてもサイトには何も出ません。
#   2026-09-25に「トップがほぼ空」に見えたのは、公開が手動のままだったためです。
#
# ★点検で止まったらデプロイしません。
#   有料の中身が公開側に混ざっている／1着確率が漏れている場合は、そこで止まります。
set -u
# ⚠ pipefail が無いと「| tail」の終了コード（いつも0）を見てしまい、
#    点検が止めたのにデプロイが走る（2026-09-26に実際に走った）。
set -o pipefail
cd "$(dirname "$0")/.."

echo "=== 公開 $(date +%H:%M:%S) ==="

echo "--- 1/4 データをR2へ送る ---"
if ! node scripts/sync-public.mjs --once --write-local 2>&1 | tail -3; then
  echo "✗ 送信で失敗しました。公開を中止します"; exit 1
fi

echo ""
echo "--- 2/4 静的HTMLを書き出す ---"
node scripts/prerender.mjs 2>&1 | tail -2

echo ""
echo "--- 3/4 点検 ---"
if ! node scripts/audit-public.mjs 2>&1 | tail -3; then
  echo "✗ 公開データの点検で止まりました。デプロイしません"; exit 1
fi
node scripts/seo-audit.mjs 2>&1 | tail -1

echo ""
echo "--- 4/4 Cloudflare Pages へ ---"
node scripts/deploy.mjs 2>&1 | grep -E "組み立て|Compiled Worker|Functions bundle|Deployment complete|✗" || true

echo ""
echo "=== 公開おわり $(date +%H:%M:%S) ==="
