// The PNGs Bun.Image writes, 8-bit RGBA without interlacing, as pixels and
// back: what a crop needs, since Bun.Image has none.

import { deflateSync, inflateSync } from 'node:zlib'

export type RgbaPixels = { width: number; height: number; pixels: Uint8Array }

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_CHUNK_OVERHEAD = 12
const PNG_HEADER_BYTES = 13

export const RGBA_BYTES = 4

// How each PNG row filter predicts a byte from the ones left of, above and
// above-left of it, by the filter's number.
const ROW_PREDICTORS = [
  () => 0,
  (left: number) => left,
  (_left: number, up: number) => up,
  (left: number, up: number) => Math.floor((left + up) / 2),
  paeth,
] as const

export function decodeRgbaPng(png: Uint8Array): RgbaPixels {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const [bitDepth, colorType, , , interlace] = png.subarray(24, 29)

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error('the PNG is not 8-bit RGBA without interlacing')
  }

  const imageData: Uint8Array[] = []

  for (let offset = PNG_SIGNATURE.length; offset < png.length;) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))

    if (type === 'IDAT') {
      imageData.push(png.subarray(offset + 8, offset + 8 + length))
    }

    offset += length + PNG_CHUNK_OVERHEAD
  }

  const filtered = inflateSync(Buffer.concat(imageData))

  return { width, height, pixels: unfilterRows(filtered, width, height) }
}

// Each row of a PNG starts with the number of the filter that predicts its bytes.
function unfilterRows(filtered: Uint8Array, width: number, height: number) {
  const rowBytes = width * RGBA_BYTES
  const pixels = new Uint8Array(rowBytes * height)

  for (let row = 0; row < height; row++) {
    const filter = byteAt(filtered, row * (rowBytes + 1))
    const predict = ROW_PREDICTORS[filter]

    if (predict === undefined) {
      throw new Error(`unknown PNG row filter ${filter}`)
    }

    const source = row * (rowBytes + 1) + 1
    const target = row * rowBytes

    for (let i = 0; i < rowBytes; i++) {
      const left = i >= RGBA_BYTES ? byteAt(pixels, target + i - RGBA_BYTES) : 0
      const up = row > 0 ? byteAt(pixels, target + i - rowBytes) : 0
      const upLeft =
        row > 0 && i >= RGBA_BYTES ? byteAt(pixels, target + i - rowBytes - RGBA_BYTES) : 0
      // A Uint8Array keeps the sum modulo 256, as the format wants.
      pixels[target + i] = byteAt(filtered, source + i) + predict(left, up, upLeft)
    }
  }

  return pixels
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft
  const fromLeft = Math.abs(estimate - left)
  const fromUp = Math.abs(estimate - up)
  const fromUpLeft = Math.abs(estimate - upLeft)

  if (fromLeft <= fromUp && fromLeft <= fromUpLeft) {
    return left
  }

  return fromUp <= fromUpLeft ? up : upLeft
}

function byteAt(bytes: Uint8Array, index: number) {
  return bytes[index] ?? 0
}

// Every row unfiltered: Bun.Image re-encodes it anyway.
export function encodeRgbaPng({ width, height, pixels }: RgbaPixels) {
  const rowBytes = width * RGBA_BYTES
  const rows = new Uint8Array((rowBytes + 1) * height)

  for (let row = 0; row < height; row++) {
    rows.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1)
  }

  const header = new Uint8Array(PNG_HEADER_BYTES)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header[8] = 8
  header[9] = 6

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(data.length + PNG_CHUNK_OVERHEAD)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(new TextEncoder().encode(type), 4)
  chunk.set(data, 8)
  view.setUint32(data.length + 8, Bun.hash.crc32(chunk.subarray(4, data.length + 8)))

  return chunk
}
