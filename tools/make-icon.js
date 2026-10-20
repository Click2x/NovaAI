// Generates the app icon locally, no downloads: build/icon.png (256x256, used by the tray) and build/icon.ico (16/32/48/64/128/256, PNG
// frames, used by electron-builder for the exe and the installer). Run: node tools/make-icon.js
// The drawing is a purple rounded square with a white "N", rasterised with 4x4 supersampling so the edges are smooth.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// Shapes in a unit square (0..1). Returns [r,g,b,a] 0..255 or null for "not covered".
const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
const inPoly = (x, y, pts) => {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
// An "N": left stem, right stem, diagonal.
const N_SHAPES = [
  [[0.30, 0.24], [0.40, 0.24], [0.40, 0.76], [0.30, 0.76]],
  [[0.60, 0.24], [0.70, 0.24], [0.70, 0.76], [0.60, 0.76]],
  [[0.30, 0.24], [0.40, 0.24], [0.70, 0.76], [0.60, 0.76]],
]
function colorAt(x, y) {
  if (!inRoundRect(x, y, 0.22)) return null
  if (N_SHAPES.some((p) => inPoly(x, y, p))) return [255, 255, 255, 255]
  const t = (x + y) / 2                                   // diagonal gradient, violet to indigo
  return [Math.round(150 - 60 * t), Math.round(90 - 40 * t), Math.round(220 - 30 * t), 255]
}

function render(size, ss = 4) {
  const out = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = colorAt((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
      if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3] }
    }
    const o = (py * size + px) * 4, n = ss * ss
    out[o] = a ? Math.round(r / a) : 0; out[o + 1] = a ? Math.round(g / a) : 0; out[o + 2] = a ? Math.round(b / a) : 0; out[o + 3] = Math.round(a / n)
  }
  return out
}

function encodeIco(frames) {   // frames: [{ size, png }]
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4)
  const dir = Buffer.alloc(16 * frames.length)
  let offset = 6 + dir.length
  frames.forEach((f, i) => {
    dir[i * 16] = f.size >= 256 ? 0 : f.size; dir[i * 16 + 1] = f.size >= 256 ? 0 : f.size
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6)
    dir.writeUInt32LE(f.png.length, i * 16 + 8); dir.writeUInt32LE(offset, i * 16 + 12)
    offset += f.png.length
  })
  return Buffer.concat([head, dir, ...frames.map((f) => f.png)])
}

function main() {
  const outDir = path.resolve(__dirname, '..', 'build')
  fs.mkdirSync(outDir, { recursive: true })
  const frames = [16, 32, 48, 64, 128, 256].map((size) => ({ size, png: encodePng(size, size, render(size)) }))
  fs.writeFileSync(path.join(outDir, 'icon.png'), frames[frames.length - 1].png)
  fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(frames))
  console.log('wrote', path.join(outDir, 'icon.png'), 'and icon.ico')
}

if (require.main === module) main()
module.exports = { render, encodePng, encodeIco }
