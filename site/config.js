// 画面の設定。Netlify に置くのはこのフォルダ（site/）だけ。
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
  noteUrl: '',          // 有料の買い目を売っている note のURL（空なら案内ボタンを出さない）
}
