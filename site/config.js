// 画面の設定。Netlify / Cloudflare Pages に置くのはこのフォルダ（site/）だけ。
//
// mode:
//   'local'    … このPCで試すとき。site/_local/ に書き出したデータを読む（node scripts/sync-public.mjs --local）
//   'r2'       … 公開するとき（本命）。同じドメインの /data/ から読む。中身は Cloudflare R2。
//                 Pages の Settings → Functions → R2 bucket bindings で 変数名 DATA を割り当てること。
//   'supabase' … Supabase の docs 表を読む（R2 に移す前の方式。いまは使わない）
//
// ⚠ ここに入れてよいのは anon（公開用・読むだけ）の鍵だけ。
//   service_role の鍵は書き込みができる強い鍵なので、絶対にここへ入れない（data/supabase.json にだけ置く）。
window.NAGI = {
  mode: 'r2',
  // ---- メール登録（無料）。Supabase の認証だけを使う ----
  //   公開してよい鍵だけ。service_role / secret は絶対にここへ入れない。
  supabaseUrl: 'https://fvhjuleiaycmavdorokp.supabase.co',
  supabaseAnonKey: 'sb_publishable_tDZtdMhMYU4oDBEXSIPIAg_lYyRRFHL',
  noteUrl: '',          // 会員（月300円）を売る note のメンバーシップのURL（空なら案内ボタンを出さない）

  // ---- 検索とアクセス解析 ----
  siteName: 'ボートレース研究所',
  siteUrl: '',          // 例 'https://nagi-kyotei.com'（末尾のスラッシュなし）
                        //   ここを入れると canonical・OGP・sitemap.xml が正しいURLになる。
                        //   空のままだと sitemap が作れず、検索に出るまでが遅くなる。
  gaId: '',             // GA4 の測定ID 例 'G-XXXXXXXXXX'（空ならアクセス解析を読み込まない）
  // Search Console の所有権確認は DNS(TXT)で行う。HTMLタグ方式にしたいときは index.html に直接貼ること
  //   （JSで足しても Search Console は読み取れない）
}
