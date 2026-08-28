import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Framework image serving — the promotion of the pattern proven in
 * `examples/indie-blog` (spec `images-are-part-of-stator-*`). Mounted only
 * when `stator.config.ts` declares `images: { dir }`; an unconfigured app has
 * no routes here and never loads a transformer.
 *
 * The contract, unchanged from the proof: the URL's **extension is the
 * delivery format** (request `x.webp` of a stored `x.jpg` and the endpoint
 * converts — it never lies about an extension; there is no Accept-header or
 * user-agent negotiation, ever), `?w=` resizes to an allowlisted width, and
 * `?w=&h=` cover-crops to an exact box — BOTH dimensions must come from the
 * allowlist, so the variant space stays bounded (widths² at worst, never an
 * open crop parameter). Variants cache on disk beside the originals
 * (`.variants/`), regenerated when the original is newer. GIFs serve as
 * originals only — animation does not survive naive resizing.
 */

/**
 * The transformer seam: pure bytes-in/bytes-out, so the default (sharp) is
 * swappable for another library. The framework owns everything around it —
 * path resolution, the disk cache, conditional GET — adapters only transform.
 */
export interface ImageTransformer {
  /** Intrinsic dimensions. Called at WRITE time by app upload handlers (via
   *  `probeImage`), never during a render — dimensions are data, not IO. */
  probe(bytes: Uint8Array): Promise<{ width: number | null; height: number | null }>
  /** Resize (optional) and/or re-encode to `format`. Width alone never
   *  enlarges; width+height is an exact cover-cropped box (art direction
   *  needs predictable geometry, so enlargement is allowed there). */
  transform(
    input: Uint8Array,
    opts: { width?: number; height?: number; format: 'jpeg' | 'png' | 'webp' | 'avif' },
  ): Promise<Uint8Array>
}

/** Impl #1: sharp, imported lazily so image-free processes never load it. */
export function sharpTransformer(): ImageTransformer {
  return {
    async probe(bytes) {
      const { default: sharp } = await import('sharp')
      const meta = await sharp(bytes).metadata()
      return { width: meta.width ?? null, height: meta.height ?? null }
    },
    async transform(input, opts) {
      const { default: sharp } = await import('sharp')
      let pipeline = sharp(input)
      if (opts.width !== undefined && opts.height !== undefined) {
        pipeline = pipeline.resize({ width: opts.width, height: opts.height, fit: 'cover' })
      } else if (opts.width !== undefined) {
        pipeline = pipeline.resize({ width: opts.width, withoutEnlargement: true })
      }
      return new Uint8Array(await pipeline.toFormat(opts.format).toBuffer())
    },
  }
}

export const DEFAULT_IMAGE_WIDTHS = [400, 800, 1200, 1600]

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
}

const TRANSCODE_TARGETS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif'])

export interface ResolvedImagesConfig {
  dir: string
  /** URL prefix (leading slash, no trailing). */
  path: string
  widths: number[]
  transformer: ImageTransformer
}

export function resolveImagesConfig(config: {
  dir: string
  path?: string
  widths?: number[]
  transformer?: ImageTransformer
}): ResolvedImagesConfig {
  const dir = resolve(config.dir)
  const path = (config.path ?? `/${basename(dir)}`).replace(/\/$/, '')
  return {
    dir,
    path: path.startsWith('/') ? path : `/${path}`,
    widths: config.widths ?? DEFAULT_IMAGE_WIDTHS,
    transformer: config.transformer ?? sharpTransformer(),
  }
}

/** Write-time probe for app upload handlers — the render never does this.
 *  Defaults to the sharp transformer; pass your configured one if you swapped
 *  it. (First dogfood finding: an earlier signature took the whole resolved
 *  config, which apps don't hold — bytes + optional transformer is the shape
 *  an upload handler actually has in hand.) */
export async function probeImage(
  bytes: Uint8Array,
  transformer: ImageTransformer = sharpTransformer(),
): Promise<{ width: number | null; height: number | null }> {
  return transformer.probe(bytes)
}

/** Find the stored original for a requested relative path, whatever its
 *  extension — containment-checked against the images dir. */
function resolveOriginal(
  config: ResolvedImagesConfig,
  rel: string,
): { full: string; ext: string } | null {
  const dot = rel.lastIndexOf('.')
  if (dot === -1) return null
  const base = rel.slice(0, dot)
  for (const ext of Object.keys(IMAGE_CONTENT_TYPES)) {
    const full = resolve(config.dir, `${base}.${ext}`)
    if (!full.startsWith(config.dir + sep)) return null
    if (existsSync(full)) return { full, ext }
  }
  return null
}

/**
 * Serve one image request: `rel` is the path under the endpoint prefix,
 * `widthParam` the raw `?w=` value (undefined = original size). Returns a
 * complete `Response` — 200 with caching headers, 304 on a validator match,
 * 400 for an off-allowlist width, 404 otherwise.
 */
export async function serveImage(
  config: ResolvedImagesConfig,
  rel: string,
  widthParam: string | undefined,
  heightParam: string | undefined,
  ifNoneMatch: string | null,
): Promise<Response> {
  let width: number | undefined
  if (widthParam !== undefined) {
    width = Number(widthParam)
    if (!config.widths.includes(width)) {
      return new Response(`w must be one of ${config.widths.join(', ')}`, { status: 400 })
    }
  }
  let height: number | undefined
  if (heightParam !== undefined) {
    // A crop needs both axes, each from the allowlist — the DoS bound.
    height = Number(heightParam)
    if (width === undefined || !config.widths.includes(height)) {
      return new Response(`h requires w, both from ${config.widths.join(', ')}`, { status: 400 })
    }
  }

  const dot = rel.lastIndexOf('.')
  const requestedExt = rel.slice(dot + 1).toLowerCase()
  const contentType = IMAGE_CONTENT_TYPES[requestedExt]
  if (!contentType) return new Response('not found', { status: 404 })

  const original = resolveOriginal(config, rel)
  if (!original) return new Response('not found', { status: 404 })

  let file: string
  const sameFormat =
    IMAGE_CONTENT_TYPES[original.ext] === contentType && width === undefined && height === undefined
  if (sameFormat) {
    file = original.full
  } else {
    if (!TRANSCODE_TARGETS.has(requestedExt) || original.ext === 'gif') {
      return new Response('not found', { status: 404 })
    }
    const cache = join(
      config.dir,
      '.variants',
      `${rel.slice(0, dot)}-${width ?? 'orig'}${height !== undefined ? `x${height}` : ''}.${requestedExt}`,
    )
    const fresh = existsSync(cache) && statSync(cache).mtimeMs >= statSync(original.full).mtimeMs
    if (!fresh) {
      const format =
        requestedExt === 'jpg' ? 'jpeg' : (requestedExt as 'jpeg' | 'png' | 'webp' | 'avif')
      const out = await config.transformer.transform(
        new Uint8Array(await readFile(original.full)),
        { width, height, format },
      )
      mkdirSync(dirname(cache), { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(cache, out)
    }
    file = cache
  }

  try {
    const st = await stat(file)
    const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`
    const headers = {
      'Content-Type': contentType,
      ETag: etag,
      'Cache-Control': 'public, max-age=0, must-revalidate',
    }
    if (ifNoneMatch?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(new Uint8Array(await readFile(file)), { headers })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
