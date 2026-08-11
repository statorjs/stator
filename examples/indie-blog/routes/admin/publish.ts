import { defineApiRoute } from '@statorjs/stator/server'
import { contentError, discoverKind, outboundLinks, slugify } from '../../lib/content.ts'
import { createPost, postBySlug } from '../../lib/db.ts'
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
    if (contentError(content)) {
      return { directives: [{ type: 'navigate', to: '/admin?error=content' }] }
    }

    // Auth probe: a zero-target publish still must prove the session. The
    // RETRY_TARGET guard requires `authed` and a bogus key commits nothing
    // downstream (the outbox's own guard drops it).
    const probe = await dispatch(OwnerMachine, { type: 'RETRY_TARGET', key: '@auth-probe' })
    if (!probe.committed) {
      return { directives: [{ type: 'navigate', to: '/admin?error=not-signed-in' }] }
    }

    const kind = discoverKind(titleRaw, content)
    let slug = slugify(titleRaw !== '' ? titleRaw : content.slice(0, 40))
    if (postBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`
    const post = createPost({ slug, kind, title: titleRaw === '' ? null : titleRaw, content })

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
