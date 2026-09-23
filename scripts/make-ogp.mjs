// SNSに貼ったときに出る画像（site/ogp.png・1200×630）を作る。
//
//   node scripts/make-ogp.mjs
//
// 画像が無いと、X や note にURLを貼ったときに文字だけの寂しい見た目になり、押されにくい。
// ここでは外部の道具を使わず、点を1つずつ塗って PNG を組み立てている（文字は入れていない）。
// サイト名入りの絵を用意できたら、site/ogp.png を差し替えるだけでよい。
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 1200, H = 630
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 画面と同じ色（style.css の --accent / --ground）
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const DEEP = hex('#0b3f45'), ACCENT = hex('#0f5e61'), FOAM = hex('#d8ebe9'), SIGNAL = hex('#c96f1c')
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))))

const px = Buffer.alloc(W * H * 3)
const set = (x, y, c) => { const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2] }

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // 地の色：上が深く、下がやや明るい（凪いだ水面のつもり）
    let c = mix(DEEP, ACCENT, y / H * 0.9)
    // 波を4本。下にいくほど大きく、間隔も広げる
    for (let k = 0; k < 4; k++) {
      const base = H * (0.52 + k * 0.13)
      const amp = 16 + k * 10, len = 420 + k * 140
      const wave = base + Math.sin((x / len + k * 0.6) * Math.PI * 2) * amp
      const d = Math.abs(y - wave)
      if (d < 2.2) c = mix(c, FOAM, (2.2 - d) / 2.2 * (0.5 - k * 0.08))
      else if (y > wave) c = mix(c, DEEP, 0.045)
    }
    set(x, y, c)
  }
}
// 右下に合図の色の線（style.css の --signal）。ただの飾り
for (let y = H - 10; y < H; y++) for (let x = 0; x < W; x++) set(x, y, SIGNAL)

// ---------- PNG に組み立てる ----------
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
})()
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8bit・RGB
// 各行の先頭に「加工なし」の印(0)を付ける決まり
const raw = Buffer.alloc(H * (W * 3 + 1))
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3)
}
const out = join(ROOT, 'site', 'ogp.png')
writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]))
console.log(`${out} を作りました（${W}×${H}）`)
