-- 凪の予想配信：公開サイト用の置き場（Supabase）
-- Supabase の管理画面 → SQL Editor にこれを貼り付けて「Run」する。1回だけでよい。
--
-- 中身は docs 表1つだけ。PC（scripts/sync-public.mjs）が「1ページ＝1件」で上書きしていく。
--   key の例：meta / races/2026-09-22 / race/20260922-12-08 / tenkai/2026-09-22 / results/30 / racer/4320 / venue/5
-- 有料の買い目はここに送らない作り（sync-public.mjs で二重に止めている）。

create table if not exists public.docs (
  key        text primary key,
  body       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 誰でも「読む」だけはできる。書き込みは service_role の鍵（PCだけが持つ）でしかできない。
alter table public.docs enable row level security;

drop policy if exists "公開データは誰でも読める" on public.docs;
create policy "公開データは誰でも読める"
  on public.docs for select
  to anon, authenticated
  using (true);

-- 画面（anon の鍵）からの書き込み・削除は、ポリシーを作らないことで全部拒否される。

-- ★会員ぶん（2026-09-23 追加）
-- key が paid/ で始まるものは中身が暗号文（{v, period, iv, ct}）。
-- 誰でも読めるが、その月の合言葉がないと中身は読めない。鍵はこちらで預からない。
-- 作り方は scripts/seal.mjs、運用は 会員の仕組み.md を見ること。
