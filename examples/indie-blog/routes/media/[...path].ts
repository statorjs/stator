import { readFile, stat } from 'node:fs/promises'
import { defineApiRoute } from '@statorjs/stator/server'
import { VARIANT_WIDTHS, variantFile } from '../../lib/media.ts'

/**
 * Serve uploaded media by dated catch-all path, with on-demand variants:
 * the URL's extension is the delivery format (request `x.webp` of a stored
 * `x.jpg` and the endpoint converts — it never lies about an extension), and
 * `?w=` resizes to an allowlisted width. Variants cache on disk beside the
 * originals. Raw `Response`s bypass the data-route ETag machinery, so
 * conditional-GET is hand-rolled: strong ETag from the served file's
 * size+mtime, bodyless 304 on a match.
 */
export const GET = defineApiRoute({
  method: 'GET',
  handler: async (request) => {
    const w = request.query.w
    let width: number | null = null
    if (w !== undefined) {
      width = Number(w)
      if (!VARIANT_WIDTHS.includes(width)) {
        return new Response(`w must be one of ${VARIANT_WIDTHS.join(', ')}`, { status: 400 })
      }
    }
    const media = await variantFile(request.params.path ?? '', width).catch(() => null)
    if (!media) return new Response('not found', { status: 404 })
    try {
      const st = await stat(media.full)
      const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`
      const headers = {
        'Content-Type': media.contentType,
        ETag: etag,
        'Cache-Control': 'public, max-age=0, must-revalidate',
      }
      const inm = request.headers.get('if-none-match')
      if (inm?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
        return new Response(null, { status: 304, headers })
      }
      return new Response(new Uint8Array(await readFile(media.full)), { headers })
    } catch {
      return new Response('not found', { status: 404 })
    }
  },
})
