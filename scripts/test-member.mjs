// 会員（月500円・合言葉）の仕組みを確かめる。実装を変えたら必ず通す。
//
//   node scripts/test-member.mjs
//
// ★何を守りたいか
//   ① 画面側（site/app.js）と送信側（scripts/seal.mjs）の計算が**完全に一致**すること
//      ここがずれると、合言葉が正しくても**誰も開けなくなる**。しかも
//      「開けません」としか出ないので、原因に辿りつくのに時間がかかる。
//      → app.js の数値を**ソースから読み出して**突き合わせる（書き写さない）
//   ② 違う合言葉・違う月・書き換えられた暗号文では開かないこと
//   ③ 同じ中身なら同じ暗号文になること（でないと3分ごとに全部送り直して無料枠を食う）
//   ④ 中身が変われば IV も変わること（鍵とIVの使い回しは致命的）
//   ⑤ 平文をまちがって送らないこと（isSealed）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { webcrypto, createHash } from 'node:crypto'
import { seal, open, isSealed, phraseOf, keyOf, periodOf, PBKDF2_ROUNDS, SALT_PREFIX, master } from './seal.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = readFileSync(join(ROOT, 'site', 'app.js'), 'utf8')

let ok = 0, ng = 0
const T = (name, cond, detail = '') => {
  if (cond) { ok++; console.log('  ✓ ' + name + (detail ? '　' + detail : '')) }
  else { ng++; console.log('  ✗ ' + name + (detail ? '　' + detail : '')) }
}
const TT = async (name, fn, want) => {
  let got
  try { got = await fn() } catch (e) { got = 'throw: ' + e.message }
  T(name, got === want, `期待 ${want} / 実際 ${got}`)
}

const MK = master()
const PERIOD = '2026-10'
const PHRASE = phraseOf(PERIOD, MK)
const DOC = { date: '2026-10-09', picks: [{ combo: '1-2-3', p: 0.24 }], note: '日本語も入る' }

console.log('■ 会員（合言葉）の確認')
console.log(`  期間 ${PERIOD} ／ 合言葉 ${PHRASE.slice(0, 10)}…`)
console.log('')

// ---------- ① 画面側と送信側が一致しているか ----------
console.log('【1】画面側(app.js)と送信側(seal.mjs)の計算')
{
  // app.js から実際の数値を読み出す（書き写すと、片方だけ直したときに気づけない）
  const iter = APP.match(/iterations:\s*([\d_]+)/)?.[1]?.replace(/_/g, '')
  const saltLit = APP.match(/salt:\s*e\.encode\('([^']+)'\s*\+\s*period\)/)?.[1]
  const hash = APP.match(/hash:\s*'([^']+)'\s*\}\s*,\s*base\s*,\s*(\d+)\)/)
  const bits = hash?.[2]
  T('app.js から繰り返し回数を読めた', !!iter, String(iter))
  T('app.js からソルトを読めた', !!saltLit, saltLit)
  T('app.js からハッシュと長さを読めた', !!hash, `${hash?.[1]} / ${bits}ビット`)
  T('繰り返し回数が一致', Number(iter) === PBKDF2_ROUNDS, `app ${iter} / seal ${PBKDF2_ROUNDS}`)
  T('ソルトの先頭が一致', saltLit === SALT_PREFIX, `app "${saltLit}" / seal "${SALT_PREFIX}"`)
  T('ハッシュが一致', hash?.[1] === 'SHA-256', hash?.[1])
  T('鍵の長さが一致', Number(bits) === 256, `${bits}ビット / seal 32バイト`)

  // 数字あわせだけでなく、**実際に同じ鍵が出るか**をWebCryptoで確かめる
  const e = new TextEncoder()
  const base = await webcrypto.subtle.importKey('raw', e.encode(PHRASE.trim()), 'PBKDF2', false, ['deriveBits'])
  const got = Buffer.from(await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: e.encode(saltLit + PERIOD), iterations: Number(iter), hash: 'SHA-256' }, base, Number(bits)))
  T('★ 画面側の手順で作った鍵が、送信側の鍵と同じ', got.equals(keyOf(PHRASE, PERIOD)),
    `${got.toString('hex').slice(0, 16)}… / ${keyOf(PHRASE, PERIOD).toString('hex').slice(0, 16)}…`)

  // 画面側の復号そのものを通してみる
  const box = seal(DOC, PERIOD, 'paid/race/x', MK)
  const key = await webcrypto.subtle.importKey('raw', got, 'AES-GCM', false, ['decrypt'])
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(box.iv) }, key, b64(box.ct))
  T('★ 画面側の手順で中身を開ける', JSON.parse(new TextDecoder().decode(plain)).note === DOC.note)
}
console.log('')

// ---------- ② 開くべきもの・開かないもの ----------
console.log('【2】開く／開かない')
{
  const box = seal(DOC, PERIOD, 'paid/race/x', MK)
  T('正しい合言葉で開く', open(box, PHRASE).date === DOC.date)
  T('前後の空白があっても開く', open(box, '  ' + PHRASE + '  ').date === DOC.date)
  await TT('違う合言葉では開かない', () => { try { open(box, 'nagi-2610-AAAA-BBBB-CCCC'); return '開いた' } catch { return '開かない' } }, '開かない')
  await TT('1文字違いでも開かない', () => {
    const w = PHRASE.slice(0, -1) + (PHRASE.at(-1) === 'A' ? 'B' : 'A')
    try { open(box, w); return '開いた' } catch { return '開かない' }
  }, '開かない')
  await TT('先月の合言葉では開かない', () => { try { open(box, phraseOf('2026-09', MK)); return '開いた' } catch { return '開かない' } }, '開かない')
  await TT('来月の合言葉では開かない', () => { try { open(box, phraseOf('2026-11', MK)); return '開いた' } catch { return '開かない' } }, '開かない')
  await TT('空の合言葉では開かない', () => { try { open(box, ''); return '開いた' } catch { return '開かない' } }, '開かない')

  // 書き換え（GCMの認証タグが効いているか）
  const t1 = { ...box, ct: Buffer.concat([Buffer.from([0]), Buffer.from(box.ct, 'base64').subarray(1)]).toString('base64') }
  await TT('中身を1バイト書き換えたら開かない', () => { try { open(t1, PHRASE); return '開いた' } catch { return '開かない' } }, '開かない')
  const t2 = { ...box, iv: Buffer.from(Buffer.from(box.iv, 'base64').map((b, i) => (i ? b : b ^ 1))).toString('base64') }
  await TT('IVを書き換えたら開かない', () => { try { open(t2, PHRASE); return '開いた' } catch { return '開かない' } }, '開かない')
  const t3 = { ...box, ct: Buffer.from(box.ct, 'base64').subarray(0, -1).toString('base64') }
  await TT('認証タグを削っても開かない', () => { try { open(t3, PHRASE); return '開いた' } catch { return '開かない' } }, '開かない')
}
console.log('')

// ---------- ③ 同じ中身なら同じ暗号文（送信をはぶく仕組みが効くか） ----------
console.log('【3】送信をはぶく仕組み（指紋くらべ）')
{
  const a = seal(DOC, PERIOD, 'paid/race/x', MK)
  const b = seal(DOC, PERIOD, 'paid/race/x', MK)
  T('同じ中身なら暗号文も同じ', a.ct === b.ct && a.iv === b.iv,
    '違うと3分ごとに全部送り直して無料枠を使い切る')
  const c = seal({ ...DOC, note: 'ちょっと変えた' }, PERIOD, 'paid/race/x', MK)
  T('中身が変われば暗号文も変わる', c.ct !== a.ct)
  T('★ 中身が変われば IV も変わる', c.iv !== a.iv, '同じ鍵で同じIVを使い回すのは致命的')
  const d = seal(DOC, PERIOD, 'paid/race/y', MK)
  T('置き場所が違えば IV も違う', d.iv !== a.iv)
  const e = seal(DOC, '2026-09', 'paid/race/x', MK)
  T('月が違えば IV も違う', e.iv !== a.iv)
}
console.log('')

// ---------- ④ 合言葉の形 ----------
console.log('【4】合言葉の形')
{
  T('形が nagi-YYMM-XXXX-XXXX-XXXX', /^nagi-\d{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(PHRASE), PHRASE)
  T('紛らわしい文字(0 O 1 I)が入っていない', !/[01OI]/.test(PHRASE.slice(10)))
  T('何度呼んでも同じ', phraseOf(PERIOD, MK) === PHRASE)
  T('月が違えば別の合言葉', phraseOf('2026-11', MK) !== PHRASE)
  T('年月が読み取れる形', PHRASE.startsWith('nagi-2610-'))
  // 画面側の読み取り（periodOfPhrase）と合うか
  const re = APP.match(/periodOfPhrase\s*=\s*\(p\)\s*=>\s*\{[^}]*match\((\/[^/]+\/[a-z]*)\)/)?.[1]
  T('app.js の読み取り式を取り出せた', !!re, re)
  if (re) {
    const m = PHRASE.match(new RegExp(re.replace(/^\/|\/[a-z]*$/g, ''), re.endsWith('i') ? 'i' : ''))
    T('★ 画面側が合言葉から月を正しく取り出せる', m && `20${m[1]}-${m[2]}` === PERIOD,
      m ? `20${m[1]}-${m[2]}` : '取り出せない')
  }
}
console.log('')

// ---------- ⑤ 平文を送らないための見張り ----------
console.log('【5】平文をまちがって送らないか')
{
  const box = seal(DOC, PERIOD, 'paid/race/x', MK)
  T('閉じたものは「閉じている」と判定される', isSealed(box))
  T('平文は「閉じている」と判定されない', !isSealed(DOC))
  T('null でも落ちない', !isSealed(null))
  T('似た形でも中身が無ければ弾く', !isSealed({ v: 1, period: PERIOD, iv: 1, ct: 2 }))
  T('項目が1つ欠けたら弾く', !isSealed({ v: 1, period: PERIOD, iv: 'a' }))
  T('余計な項目があれば弾く', !isSealed({ ...box, extra: 1 }), '平文が紛れた箱を通さないため')
}
console.log('')

// ---------- ⑥ 月替わりのふるまい ----------
console.log('【6】月替わり')
{
  T('日付から月を出せる', periodOf('2026-10-09') === '2026-10')
  T('月末でも同じ月', periodOf('2026-10-31') === '2026-10')
  T('翌月1日は翌月', periodOf('2026-11-01') === '2026-11')
  // 先月の会員は、先月の中身は開けたまま（解約しても過去は見られる）
  const sep = seal(DOC, '2026-09', 'paid/race/x', MK)
  T('先月の合言葉で先月の中身は開ける', open(sep, phraseOf('2026-09', MK)).date === DOC.date,
    '解約しても過去ぶんは見られる＝意図どおり')
  await TT('先月の合言葉で今月の中身は開けない', () => {
    try { open(seal(DOC, PERIOD, 'paid/race/x', MK), phraseOf('2026-09', MK)); return '開いた' } catch { return '開かない' }
  }, '開かない', '解約が翌月に自動で効く')
}
console.log('')

// ---------- ⑦ 鍵の置き方（画面側のコードを読む） ----------
console.log('【7】鍵の置き方')
{
  T('鍵は取り出せない形で作っている', /importKey\('raw',\s*new Uint8Array\(bits\),\s*'AES-GCM',\s*false/.test(APP),
    'extractable:false＝よそのJSに持ち出されない')
  T('復号だけの鍵（暗号化はできない）', /'AES-GCM',\s*false,\s*\['decrypt'\]/.test(APP))
  T('合言葉そのものは保存していない', !/localStorage\.setItem\(MEM,\s*JSON\.stringify\(\{\s*phrase/.test(APP))
  T('localStorage に入れるのは月だけ', /localStorage\.setItem\(MEM,\s*JSON\.stringify\(\{\s*period\s*\}\)\)/.test(APP))
  T('IndexedDBが使えなくても動く（その回だけ覚える）', /memKey\s*=\s*\{\s*period,\s*key\s*\}/.test(APP))
  T('鍵を消す手段がある', /async function clearKey\(\)/.test(APP))
}
console.log('')

// ---------- ⑧ ログインに要る「確認用の箱」 ----------
// ★これが無いと誰もログインできない（memberPage が paid/check/<月> で確かめている）
console.log('【8】確認用の箱（paid/check）')
{
  const nextPeriod = (pp) => { const [y, m] = pp.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}` }
  T('翌月の計算（12月→翌年1月）', nextPeriod('2026-12') === '2027-01', nextPeriod('2026-12'))
  T('翌月の計算（ふつうの月）', nextPeriod('2026-10') === '2026-11')
  // 送信側が「今月ぶん」と「翌月ぶん」の両方を作っているか
  const SRC = readFileSync(join(ROOT, 'scripts', 'sync-public.mjs'), 'utf8')
  T('★ 送信側が翌月ぶんも作っている', SRC.includes('paid/check/${nxt}'),
    '来月の合言葉は月末に配るので、月末時点で箱が無いと弾かれる')

  // 本番に実在するか（ここが落ちたら会員がログインできない）
  const d = new Date()
  const cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  for (const period of [cur, nextPeriod(cur)]) {
    let state = '届かない'
    try {
      const r = await fetch(`https://boatrace-nagi.top/data/paid/check/${period}.json?cb=${Date.now()}`,
        { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) state = `HTTP ${r.status}`
      else {
        const box = await r.json()
        try { state = open(box, phraseOf(period, MK)).ok === true ? '開く' : '中身が変' }
        catch { state = '開かない' }
      }
    } catch (e) { state = 'つながらない（' + e.name + '）' }
    T(`★ 本番の ${period} の箱が、その月の合言葉で開く`, state === '開く', state)
  }
}
console.log('')

// ---------- ⑨ 鍵と印のずれ ----------
console.log('【9】鍵（IndexedDB）と印（localStorage）のずれ')
{
  // ⚠ 正規表現は使わない。ヘレドキュメント越しに書くとエスケープが潰れる
  //   （[[bash-heredoc-backslash]]）。文字列として含まれるかだけを見る。
  T('鍵が無ければ印も消す',
    APP.includes('if (localStorage.getItem(MEM)) localStorage.removeItem(MEM)'),
    'IndexedDBだけ消えると「会員です」と出て何も開かない状態になる')
  T('会員ページが実際の鍵を見ている',
    APP.includes('await loadKey()') && APP.indexOf('await loadKey()') < APP.indexOf('const st = memberState()'))
  T('合言葉は確認用の箱で検証してから通す', APP.includes('paid/check/${period}'))
  T('確かめられないときは会員として通さない', APP.includes('await clearKey(); go.disabled = false'))
}
console.log('')

console.log(`合計 ${ok + ng}項目　✓ ${ok}　✗ ${ng}`)
if (ng) { console.log('★ 直すまで公開しないこと'); process.exitCode = 1 }
else console.log('✓ すべて通りました')
