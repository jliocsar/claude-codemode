// Pictures for the model: the images a program returns, taken out of its value
// to travel as image blocks, PDF pages Read wrote out as pictures, and zooming
// into an image file at its own pixels.
//
// Bun.Image decodes, scales and encodes, but has no crop. Its PNG output is
// always 8-bit RGBA, so the crop slices that (png.ts) and Bun.Image scales it.

import { join } from 'node:path'
import { z } from 'zod'
import { decodeRgbaPng, encodeRgbaPng, RGBA_BYTES, type RgbaPixels } from './png.ts'

export type ModelImage = { mediaType: string; base64: string }

export type JsonValue = z.infer<typeof jsonValueSchema>

export type ZoomRegion = z.infer<typeof zoomRegionSchema>

// Read's own cap on the long edge of a picture it hands the model.
const MODEL_IMAGE_EDGE = 2000
const PAGE_FILES = new Bun.Glob('page-*.{jpg,jpeg,png}')
const ZOOMED_MEDIA_TYPE = 'image/png'

const jsonValueSchema = z.json()
const jsonArraySchema = z.array(jsonValueSchema)
const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

export const zoomRegionSchema = z.object({
  x: z.int().min(0),
  y: z.int().min(0),
  width: z.int().min(1),
  height: z.int().min(1),
})

// Read's record for a picture, and for PDF pages read as pictures.
const imageRecordSchema = z
  .object({
    type: z.literal('image'),
    file: z
      .object({ base64: z.string().min(1), type: z.string().startsWith('image/') })
      .catchall(jsonValueSchema),
  })
  .catchall(jsonValueSchema)
const pageImagesRecordSchema = z
  .object({
    type: z.literal('parts'),
    pages: z.array(
      z.object({ base64: z.string(), mediaType: z.string() }).catchall(jsonValueSchema),
    ),
  })
  .catchall(jsonValueSchema)

// Read's record for PDF pages it wrote out as pictures. The pictures stay in
// files the engine keeps for the session, never in what a plugin is handed.
const extractedPagesRecordSchema = z
  .object({
    type: z.literal('parts'),
    file: z.object({ outputDir: z.string() }).catchall(jsonValueSchema),
    pages: z.undefined().optional(),
  })
  .catchall(jsonValueSchema)

// Read's PDF pages record with its pictures loaded from the engine's own
// output directory, as `pages`; any other result as it was.
export async function withPageImages(result: JsonValue) {
  const extracted = extractedPagesRecordSchema.safeParse(result)

  if (!extracted.success) {
    return result
  }

  const { outputDir } = extracted.data.file
  const names = await Array.fromAsync(PAGE_FILES.scan({ cwd: outputDir }))
  const pageNumber = (name: string) => Number(/\d+/u.exec(name)?.[0] ?? 0)
  const pages = await Promise.all(
    names
      .toSorted((left, right) => pageNumber(left) - pageNumber(right))
      .map(async (name) => {
        const page = Bun.file(join(outputDir, name))

        return { base64: (await page.bytes()).toBase64(), mediaType: page.type }
      }),
  )

  return { ...extracted.data, pages }
}

// The value with each picture's bytes swapped for `[image N]`, the rest of its
// record (sizes, region) kept, and the pictures in that order.
export function takeOutImages(value: JsonValue) {
  const images: ModelImage[] = []

  const takeOut = (image: ModelImage) => {
    images.push(image)

    return `[image ${images.length}]`
  }

  const walk = (node: JsonValue): JsonValue => {
    const image = imageRecordSchema.safeParse(node)

    if (image.success) {
      const { file } = image.data

      return {
        ...image.data,
        file: { ...file, base64: takeOut({ mediaType: file.type, base64: file.base64 }) },
      }
    }

    const pageImages = pageImagesRecordSchema.safeParse(node)

    if (pageImages.success) {
      return {
        ...pageImages.data,
        pages: pageImages.data.pages.map((page) =>
          page.base64 === ''
            ? page
            : { ...page, base64: takeOut({ mediaType: page.mediaType, base64: page.base64 }) },
        ),
      }
    }

    const array = jsonArraySchema.safeParse(node)

    if (array.success) {
      return array.data.map(walk)
    }

    const object = jsonObjectSchema.safeParse(node)

    if (object.success) {
      return Object.fromEntries(
        Object.entries(object.data).map(([key, child]) => [key, walk(child)]),
      )
    }

    return node
  }

  return { value: walk(value), images }
}

// A region of the picture at its own pixels, each one enlarged to a square
// block, as large as Read would show a picture. A region past the long-edge
// cap is scaled down instead.
export async function zoomImage(source: Blob, region: ZoomRegion) {
  const decoded = decodeRgbaPng(await new Bun.Image(source).png({ compressionLevel: 0 }).bytes())

  if (region.x >= decoded.width || region.y >= decoded.height) {
    throw new Error(`the region starts outside the ${decoded.width}×${decoded.height} image`)
  }

  const width = Math.min(region.width, decoded.width - region.x)
  const height = Math.min(region.height, decoded.height - region.y)
  const cropped = encodeRgbaPng(cropPixels(decoded, { ...region, width, height }))
  const fit = MODEL_IMAGE_EDGE / Math.max(width, height)
  const scale = fit >= 1 ? Math.floor(fit) : fit
  const shown = new Bun.Image(cropped).resize(
    Math.max(1, Math.floor(width * scale)),
    Math.max(1, Math.floor(height * scale)),
    fit >= 1 ? { filter: 'nearest' } : {},
  )
  const base64 = await shown.png().toBase64()

  return {
    type: 'image',
    file: {
      base64,
      type: ZOOMED_MEDIA_TYPE,
      dimensions: {
        originalWidth: width,
        originalHeight: height,
        displayWidth: shown.width,
        displayHeight: shown.height,
      },
    },
    region: { x: region.x, y: region.y, width, height },
  } as const
}

function cropPixels(image: RgbaPixels, region: ZoomRegion): RgbaPixels {
  const rowBytes = region.width * RGBA_BYTES
  const pixels = new Uint8Array(rowBytes * region.height)

  for (let row = 0; row < region.height; row++) {
    const start = ((region.y + row) * image.width + region.x) * RGBA_BYTES
    pixels.set(image.pixels.subarray(start, start + rowBytes), row * rowBytes)
  }

  return { width: region.width, height: region.height, pixels }
}
