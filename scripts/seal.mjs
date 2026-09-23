// 有料会員向けの中身を「合言葉」で開けるようにする仕組み。
//
// ★なぜ暗号にするのか（2026-09-23）
//   公開の置き場（Supabase の docs 表）は anon の鍵で誰でも読める作りにしてある。
//   そこに有料の中身を平文で置けば当然もれる。ログイン（RLS）で守る手もあるが、
//   設定を1か所まちがえた瞬間に全部もれるうえ、まちがいに気づけない。
//   そこで「置き場は誰でも読めるが、中身は合言葉がないと読めない」形にした。
//   鍵は合言葉からその場で作るので、こちらが鍵を預かる必要もない。
//
// ★合言葉
//   月替わり。master（data/paid-secret.json）と年月から決まるので、控えを持たなくても何度でも出せる。
//   例： nagi-2610-7K3M-QW9X
//   note のメンバーシップ（月額）に合わせて月替わりにしてある。
//   解約した人は翌月の合言葉を受け取れない＝解約の反映が自動になる。
//
// ★IV を決め打ちにしている理由
//   毎回ランダムだと、中身が同じでも暗号文が変わる → 送信をはぶく仕組み（指紋くらべ）が効かず、
//   3分ごとに全部を送り直して無料枠を食いつぶす。そこで IV は「master＋中身」から作る。
//   中身が同じなら同じ暗号文、中身が変われば別の IV になるので、鍵と IV の使い回しは起きない。
import { createHmac, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET = join(ROOT, 'data', 'paid-secret.json')

// 打ちまちがえやすい文字（0 O 1 I など）を外した32文字
const ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export const PBKDF2_ROUNDS = 210_000
export const SALT_PREFIX = 'nagi-paid-v1|'

/** master を読む（無ければ作る）。data/ は git に載らない。 */
export function master() {
  if (!existsSync(SECRET)) {
    mkdirSync(dirname(SECRET), { recursive: true })
    writeFileSync(SECRET, JSON.stringify({ master: randomBytes(32).toString('hex'),
      created: new Date().toISOString(), note: 'これを失うと過去の合言葉が出せなくなる。控えを取ること。' }, null, 2))
    console.error(`※ ${SECRET} を作りました。これを失うと過去の合言葉が出せません。控えを取ってください。`)
  }
  const m = JSON.parse(readFileSync(SECRET, 'utf8')).master
  if (!m || m.length < 32) throw new Error('data/paid-secret.json の master が不正')
  return Buffer.from(m, 'hex')
}

/** 日付（YYYY-MM-DD）→ 期間（YYYY-MM）。月替わり。 */
export const periodOf = (date) => String(date).slice(0, 7)

/** 期間の合言葉。何度呼んでも同じものが出る。 */
export function phraseOf(period, mk = master()) {
  const raw = createHmac('sha256', mk).update('passphrase:' + period).digest()
  let s = ''
  for (let i = 0; i < 8; i++) s += ABC[raw[i] % 32]
  return `nagi-${period.slice(2, 4)}${period.slice(5, 7)}-${s.slice(0, 4)}-${s.slice(4)}`
}

/** 合言葉 → 鍵。ブラウザ側（app.js）も同じ計算をする。 */
export const keyOf = (phrase, period) =>
  pbkdf2Sync(phrase.trim(), SALT_PREFIX + period, PBKDF2_ROUNDS, 32, 'sha256')

/** 中身を閉じる。docKey は IV を分けるために混ぜているだけで、秘密ではない。 */
export function seal(obj, period, docKey, mk = master()) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8')
  const fp = createHash('sha256').update(plain).digest('hex')
  const iv = createHmac('sha256', mk).update(`iv:${period}|${docKey}|${fp}`).digest().subarray(0, 12)
  const c = createCipheriv('aes-256-gcm', keyOf(phraseOf(period, mk), period), iv)
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return { v: 1, period, iv: iv.toString('base64'), ct: ct.toString('base64') }
}

/** 閉じたものを開く（送る前の確認用）。 */
export function open(box, phrase) {
  const buf = Buffer.from(box.ct, 'base64')
  const d = createDecipheriv('aes-256-gcm', keyOf(phrase, box.period), Buffer.from(box.iv, 'base64'))
  d.setAuthTag(buf.subarray(buf.length - 16))
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'))
}

/** 閉じたものの形をしているか（平文をまちがって送らないための確認） */
export function isSealed(o) {
  const k = Object.keys(o ?? {}).sort().join(',')
  return k === 'ct,iv,period,v' && typeof o.ct === 'string' && typeof o.iv === 'string'
}
