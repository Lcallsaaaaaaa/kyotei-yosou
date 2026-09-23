// 画面の設定。Netlify / Cloudflare Pages に置くのはこのフォルダ（site/）だけ。
//
// mode:
//   'local'    … このPCで試すとき。site/_local/ に書き出したデータを読む（node scripts/sync-public.mjs --local）
//   'supabase' … 公開するとき。Supabase の docs 表を読む
//
// ⚠ ここに入れてよいのは anon（公開用・読むだけ）の鍵だけ。
//   service_role の鍵は書き込みができる強い鍵なので、絶対にここへ入れない（data/supabase.json にだけ置く）。
window.NAGI = {
  mode: 'local',
  supabaseUrl: '',      // 例 'https://xxxx.supabase.co'
  supabaseAnonKey: '',  // Supabase → Project Settings → API → anon public
  noteUrl: '',          // 会員（月300円）を売る note のメンバーシップのURL（空なら案内ボタンを出さない）

  // ---- 検索とアクセス解析 ----
  siteName: '凪の予想配信',
  siteUrl: '',          // 例 'https://nagi-kyotei.com'（末尾のスラッシュなし）
                        //   ここを入れると canonical・OGP・sitemap.xml が正しいURLになる。
                        //   空のままだと sitemap が作れず、検索に出るまでが遅くなる。
  gaId: '',             // GA4 の測定ID 例 'G-XXXXXXXXXX'（空ならアクセス解析を読み込まない）
  // Search Console の所有権確認は DNS(TXT)で行う。HTMLタグ方式にしたいときは index.html に直接貼ること
  //   （JSで足しても Search Console は読み取れない）
}
