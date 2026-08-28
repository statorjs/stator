import { defineApiRoute } from '@statorjs/stator/server'
import { contentError, discoverKind, outboundLinks, slugify } from '../../lib/content.ts'
import { createPost, postBySlug } from '../../lib/db.ts'
import { photoError, saveOriginal } from '../../lib/media.ts'
import { SYNDICATION_TARGETS, postUrl } from '../../lib/site.ts'
import OwnerMachine from '../../machines/owner.ts'

/**
 * Publishing: the post row is reference data (straight to SQLite), the
 * outbox work is machine work — one guarded PUBLISH_TARGET per outbound
 * link plus every configured syndication endpoint (Bridgy-style POSSE).
 * Authorization is the guard: an unauthenticated session's dispatches
 * simply don't commit, so the post is only created after the first target
 * commits — and for a post with no targets, a probe event checks auth.
 */
export const POST = defineApiRoute({
  reads: [OwnerMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const titleRaw = String(form.get('title') ?? '').trim()
    const content = String(form.get('content') ?? '')
    // Multipart delivers the photo as a File; the urlencoded no-photo form has
    // no entry at all. An empty file input still submits a zero-byte part.
    const photoEntry = form.get('photo')
    const photo = photoEntry instanceof File && photoEntry.size > 0 ? photoEntry : null
    const photoAlt = String(form.get('photo_alt') ?? '').trim()
    // A validation bounce stashes the typed fields in the session machine so
    // the re-rendered form pre-fills — the redirect otherwise lands on a new
    // document with no memory. (The file can't round-trip; text survives.)
    const bounce = async (error: string) => {
      await dispatch(OwnerMachine, {
        type: 'STASH_DRAFT',
        draft: { title: titleRaw, content, photoAlt },
      })
      return { directives: [{ type: 'navigate' as const, to: `/admin?error=${error}` }] }
    }
    if (contentError(content)) return bounce('content')
    const photoProblem = photo ? photoError(photo, photoAlt) : null
    if (photoProblem) return bounce(photoProblem)

    // Auth probe: a zero-target publish still must prove the session. The
    // RETRY_TARGET guard requires `authed` and a bogus key commits nothing
    // downstream (the outbox's own guard drops it). Runs BEFORE any disk
    // write — an unauthenticated request must not store bytes.
    const probe = await dispatch(OwnerMachine, { type: 'RETRY_TARGET', key: '@auth-probe' })
    if (!probe.committed) {
      return { directives: [{ type: 'navigate', to: '/admin?error=not-signed-in' }] }
    }

    const kind = discoverKind(titleRaw, content, photo !== null)
    let slug = slugify(titleRaw !== '' ? titleRaw : content.slice(0, 40))
    if (postBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`
    const saved = photo ? await saveOriginal(photo, slug) : null
    const post = createPost({
      slug,
      kind,
      title: titleRaw === '' ? null : titleRaw,
      content,
      photo_path: saved?.rel ?? null,
      photo_alt: photo ? photoAlt : null,
      photo_width: saved?.width ?? null,
      photo_height: saved?.height ?? null,
    })

    await dispatch(OwnerMachine, { type: 'CLEAR_DRAFT' })
    const targets = [...outboundLinks(content), ...SYNDICATION_TARGETS]
    for (const target of targets) {
      await dispatch(OwnerMachine, {
        type: 'PUBLISH_TARGET',
        postSlug: post.slug,
        sourceUrl: postUrl(post.slug),
        target,
      })
    }
    return { directives: [{ type: 'navigate', to: `/posts/${post.slug}` }] }
  },
})
