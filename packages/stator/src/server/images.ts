import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

/** Impl #1: sharp, imported lazily so image-free processes never load it.
 *  `threads` caps the libvips worker pool (process-global — libvips has one
 *  pool). sharp's default is the REPORTED core count, which on a shared-cpu
 *  host is the physical machine's (8+ on Fly shared-cpu-1x) — every encode
 *  then fans out that many threads' worth of encoder buffers and CPU demand
 *  on a fractional vCPU. A big AVIF encode under that fan-out is what
 *  swap-thrashed a 512MB host into a lockup. 0 = leave sharp's default. */
export function sharpTransformer(threads = 0): ImageTransformer {
  const load = async () => {
    const { default: sharp } = await import('sharp')
    if (threads > 0) sharp.concurrency(threads)
    return sharp
  }
  return {
    async probe(bytes) {
      const sharp = await load()
      const meta = await sharp(bytes).metadata()
      return { width: meta.width ?? null, height: meta.height ?? null }
    },
    async transform(input, opts) {
      const sharp = await load()
      let pipeline = sharp(input)
      if (opts.width !== undefined && opts.height !== undefined) {
        pipeline = pipeline.resize({ width: opts.width, height: opts.height, fit: 'cover' })
      } else if (opts.width !== undefined) {
        pipeline = pipeline.resize({ width: opts.width, withoutEnlargement: true })
      }
      // AVIF effort 2 (sharp's default is 4): the encoder's CPU/density
      // trade, NOT a visual-quality knob. On-demand serving means a real
      // visitor is waiting on the first encode — measured 16s at effort 4 on
      // a shared-cpu host vs a few seconds at 2, for files a few percent
      // larger. A build step would choose density; an on-demand endpoint
      // chooses the visitor.
      const encoded =
        opts.format === 'avif' ? pipeline.avif({ effort: 2 }) : pipeline.toFormat(opts.format)
      return new Uint8Array(await encoded.toBuffer())
    },
  }
}

export const DEFAULT_IMAGE_WIDTHS = [400, 800, 1200, 1600]

/** Crop aspect allowlist (width/height): square, the photographic landscape
 *  trio, and their portrait duals. A crop `?w=&h=` is valid iff `w` is an
 *  allowlisted width AND `h === round(w / a)` for an allowlisted aspect — the
 *  variant space stays finite (|widths| x |aspects|) while the aspects people
 *  actually shoot in (16:9, 3:2, 4:3) all work. (The first cut required
 *  `h ∈ widths`, which silently forbade every non-square aspect — caught in
 *  review before the URL grammar froze.) */
export const DEFAULT_IMAGE_ASPECT_RATIOS = [1, 4 / 3, 3 / 2, 16 / 9, 3 / 4, 2 / 3, 9 / 16]

/** What the render side needs to emit URLs the endpoint will accept — carried
 *  on the render state so `<Image>`/`<Picture>` can't drift from config. */
export interface ImagesRenderInfo {
  widths: number[]
  aspectRatios: number[]
}

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

const TRANSCODE_TARGETS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif'])

/** Originals-only formats: served verbatim, never a transcode SOURCE either.
 *  GIF because animation doesn't survive naive resizing; SVG because it's a
 *  vector document, not pixels — nothing to probe, resize, or rasterize
 *  (found via an imported favicon living in the media store, where an
 *  uploading admin legitimately puts it). */
const ORIGINAL_ONLY_SOURCES = new Set(['gif', 'svg'])

/** SVG is the one format that can execute script when navigated to directly
 *  (fine inside <img>/favicon contexts, which ignore scripts). Serve it like
 *  GitHub serves avatars: scripts and external loads neutralized, inline
 *  styles allowed, sniffing pinned. */
const SVG_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
}

/** Cold-cache stampede guard: N concurrent requests for the same missing
 *  variant share one encode instead of N. Keyed by cache path. */
const inflight = new Map<string, Promise<void>>()

/** sha1-16 of an original's bytes, memoized per path with `(size, mtime)` as
 *  the recompute key — mtime demoted from identity to cache hint, its correct
 *  role. Same shape and truncation as the query-route `revision()` ledger. */
const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>()
function originalHash(full: string): string {
  const st = statSync(full)
  const hit = hashCache.get(full)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash
  const hash = createHash('sha1').update(readFileSync(full)).digest('hex').slice(0, 16)
  hashCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, hash })
  return hash
}

/** The freshness dial (spec: image-caching, adjudicated 2026-08-30 — a dial,
 *  not an immutable boolean, because over-caching has no server-side
 *  recovery). Defaults preserve the conservative revalidation contract;
 *  `staleWhileRevalidate` trades must-revalidate for background self-healing
 *  (SWR forbids what must-revalidate demands, so they never co-emit);
 *  `immutable` appends only on top of an explicit long maxAge. */
function cacheControlValue(config: ResolvedImagesConfig): string {
  const { maxAge, staleWhileRevalidate: swr, immutable } = config
  if (maxAge === 0 && swr === 0) return 'public, max-age=0, must-revalidate'
  let value = `public, max-age=${maxAge}`
  if (swr > 0) value += `, stale-while-revalidate=${swr}`
  if (immutable && maxAge > 0) value += ', immutable'
  return value
}

/** Global encode semaphore — DIFFERENT variants queue behind a small number
 *  of concurrent transforms. Without it, one cold-cache gallery page fans a
 *  dozen simultaneous sharp encodes (AVIF is memory-brutal) and OOM-kills a
 *  small host — found the first hour tonysull.co ran on a 512MB Fly machine.
 *  Module-level on purpose: the resource being protected (CPU/memory) is
 *  process-wide, whatever app object serves the request. */
let activeTransforms = 0
const transformQueue: Array<() => void> = []
function acquireTransformSlot(limit: number): Promise<void> {
  return new Promise((resolve) => {
    if (activeTransforms < limit) {
      activeTransforms += 1
      resolve()
    } else {
      transformQueue.push(() => {
        activeTransforms += 1
        resolve()
      })
    }
  })
}
function releaseTransformSlot(): void {
  activeTransforms -= 1
  transformQueue.shift()?.()
}

export interface ResolvedImagesConfig {
  dir: string
  /** URL prefix (leading slash, no trailing). */
  path: string
  widths: number[]
  aspectRatios: number[]
  transformer: ImageTransformer
  /** Max concurrent encodes across ALL variants (default 2). */
  concurrency: number
  /** libvips worker threads per encode (default 0 = sharp's default). */
  threads: number
  /** Encode deadline per request (default 15000ms; 0 disables). Past it the
   *  response degrades to a 302 at the stored original — honest bytes now —
   *  while the encode keeps filling the cache for the next request. */
  encodeTimeoutMs: number
  /** Freshness lifetime in seconds (default 0 = revalidate every use). */
  maxAge: number
  /** Serve-stale window in seconds (default 0). >0 lets a cache render its
   *  copy instantly and revalidate in the background — bounded regret. */
  staleWhileRevalidate: number
  /** Append `immutable` to a long maxAge — the no-recovery marker; only for
   *  apps whose image URLs are write-once by construction. */
  immutable: boolean
}

export function resolveImagesConfig(config: {
  dir: string
  path?: string
  widths?: number[]
  aspectRatios?: number[]
  transformer?: ImageTransformer
  concurrency?: number
  threads?: number
  encodeTimeoutMs?: number
  maxAge?: number
  staleWhileRevalidate?: number
  immutable?: boolean
}): ResolvedImagesConfig {
  const dir = resolve(config.dir)
  const path = (config.path ?? `/${basename(dir)}`).replace(/\/$/, '')
  const threads = Math.max(0, config.threads ?? 0)
  return {
    dir,
    path: path.startsWith('/') ? path : `/${path}`,
    widths: config.widths ?? DEFAULT_IMAGE_WIDTHS,
    aspectRatios: config.aspectRatios ?? DEFAULT_IMAGE_ASPECT_RATIOS,
    transformer: config.transformer ?? sharpTransformer(threads),
    concurrency: Math.max(1, config.concurrency ?? 2),
    threads,
    encodeTimeoutMs: Math.max(0, config.encodeTimeoutMs ?? 15_000),
    maxAge: Math.max(0, config.maxAge ?? 0),
    staleWhileRevalidate: Math.max(0, config.staleWhileRevalidate ?? 0),
    immutable: config.immutable ?? false,
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
  // No dotfile path segments: keeps the `.variants/` cache (and anything
  // hidden) unreachable through the endpoint — no variants-of-variants.
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return null
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
    // A crop needs both axes: `w` from the width allowlist, `h` derived from
    // an allowlisted aspect — the finite-variant DoS bound, |widths|x|aspects|.
    height = Number(heightParam)
    const w = width
    if (w === undefined || !config.aspectRatios.some((a) => height === Math.round(w / a))) {
      return new Response('h requires w, and w/h must match an allowlisted aspect', { status: 400 })
    }
  }

  const dot = rel.lastIndexOf('.')
  const requestedExt = rel.slice(dot + 1).toLowerCase()
  const contentType = IMAGE_CONTENT_TYPES[requestedExt]
  if (!contentType) return new Response('not found', { status: 404 })

  const original = resolveOriginal(config, rel)
  if (!original) return new Response('not found', { status: 404 })

  // Content-hash validators (spec: image-caching). ETags are per-URL and the
  // transform params ARE the URL, so hash(original) is the complete entropy;
  // the params suffix on variants is labeling for humans, not identity. The
  // encoder is deliberately excluded (an upgrade must not mass-bust visually
  // identical pixels) — which breaks the byte-identity promise a strong ETag
  // makes, so variants carry WEAK validators; originals stay strong.
  let hash: string
  try {
    hash = originalHash(original.full)
  } catch {
    return new Response('not found', { status: 404 })
  }
  const sameFormat =
    IMAGE_CONTENT_TYPES[original.ext] === contentType && width === undefined && height === undefined
  const sizeLabel = `${width ?? 'orig'}${height !== undefined ? `x${height}` : ''}`
  const etag = sameFormat ? `"${hash}"` : `W/"${hash}-${sizeLabel}-${requestedExt}"`
  const headers = {
    'Content-Type': contentType,
    ETag: etag,
    'Cache-Control': cacheControlValue(config),
    ...(requestedExt === 'svg' ? SVG_SECURITY_HEADERS : undefined),
  }
  // Early 304 — validators derive from the ORIGINAL, so a match answers
  // before any encode work (or even a variant file) exists.
  const bare = etag.replace(/^W\//, '')
  if (ifNoneMatch?.split(',').some((t) => t.trim().replace(/^W\//, '') === bare)) {
    return new Response(null, { status: 304, headers })
  }

  let file: string
  if (sameFormat) {
    file = original.full
  } else {
    if (!TRANSCODE_TARGETS.has(requestedExt) || ORIGINAL_ONLY_SOURCES.has(original.ext)) {
      return new Response('not found', { status: 404 })
    }
    // The source-hash lives IN the cache filename: freshness is a pure
    // existence check — a changed original hashes to a different name and
    // simply misses. (Replaces mtime comparison, which mtime-preserving and
    // mtime-resetting copies each fooled in one direction. Stale-hash
    // siblings are identifiable garbage for a future `stator images gc`.)
    const cache = join(
      config.dir,
      '.variants',
      `${rel.slice(0, dot)}-${hash.slice(0, 8)}-${sizeLabel}.${requestedExt}`,
    )
    if (!existsSync(cache)) {
      let job = inflight.get(cache)
      if (!job) {
        const format =
          requestedExt === 'jpg' ? 'jpeg' : (requestedExt as 'jpeg' | 'png' | 'webp' | 'avif')
        job = (async () => {
          await acquireTransformSlot(config.concurrency)
          try {
            const out = await config.transformer.transform(
              new Uint8Array(await readFile(original.full)),
              { width, height, format },
            )
            mkdirSync(dirname(cache), { recursive: true })
            const { writeFile } = await import('node:fs/promises')
            await writeFile(cache, out)
          } finally {
            releaseTransformSlot()
          }
        })().finally(() => inflight.delete(cache))
        inflight.set(cache, job)
      }
      // The on-demand contract is "first requester sees a SMALL delay" —
      // enforce it. A pathological encode (large AVIF on a starved host) can
      // take 30s+ or swap-thrash the machine; past the deadline this request
      // degrades to the stored original (a redirect, so the Content-Type
      // stays honest) while the encode keeps running to fill the cache. The
      // browser renders real pixels now; the next visitor gets the variant.
      if (config.encodeTimeoutMs > 0) {
        const finished = await new Promise<boolean>((done) => {
          const timer = setTimeout(() => done(false), config.encodeTimeoutMs)
          const settle = () => {
            clearTimeout(timer)
            done(true) // rejection included — the `await job` below rethrows it
          }
          job.then(settle, settle)
        })
        if (!finished) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${config.path}/${rel.slice(0, dot)}.${original.ext}`,
              'Cache-Control': 'no-store',
            },
          })
        }
      }
      await job
    }
    file = cache
  }

  try {
    return new Response(new Uint8Array(await readFile(file)), { headers })
  } catch {
    return new Response('not found', { status: 404 })
  }
}
