import { readFile, stat } from 'node:fs/promises'
import { defineApiRoute } from '@statorjs/stator/server'
import { mediaFile } from '../../lib/media.ts'

/**
 * Serve uploaded media by dated catch-all path (`/media/2026/08/slug.jpg`).
 * Raw `Response`s bypass the data-route ETag machinery, so conditional-GET is
 * hand-rolled here: strong ETag from size+mtime, bodyless 304 on a match.
 * (On-demand resized/re-encoded variants — `?w=`, format by extension — are
 * the next step on this route; originals only for now.)
 */
export const GET = defineApiRoute({
  method: 'GET',
  handler: async (request) => {
    const media = mediaFile(request.params.path ?? '')
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
