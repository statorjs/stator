import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Wire tests boot the dev app IN-PROCESS, which needs the transitional Vite dev
// server: the native default (the Vite exit) loads app modules through Node
// loader hooks that vitest's module runner bypasses. Migrates to the
// CLI-subprocess harness when the Vite implementation retires (see the
// framework's dev-native.test.ts for the pattern).
process.env.STATOR_VITE_DEV = '1'


/**
 * The full auth arc over the wire: register → rotated session → post
 * (identity stamped) → forged-identity attempts bounce → logout clears.
 */

process.env.WITH_AUTH_DB = join(mkdtempSync(join(tmpdir(), 'quay-wire-')), 'test.db')

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

beforeAll(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  const { seedHarbormaster } = await import('../lib/seed.ts')
  seedHarbormaster()
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
}, 30_000)

afterAll(async () => {
  await app.close()
})

function sidOf(res: Response): string | null {
  return res.headers.get('set-cookie')?.match(/stator_sid=([^;]+)/)?.[1] ?? null
}

function postForm(path: string, sid: string, fields: Record<string, string>) {
  return app.fetch(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `stator_sid=${sid}`,
      },
      body: new URLSearchParams(fields),
    }),
  )
}

function postEvent(sid: string, machine: string, event: object) {
  return app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Cookie: `stator_sid=${sid}`,
      },
      body: JSON.stringify({ machine, event }),
    }),
  )
}

describe('the auth arc', () => {
  it('register rotates the session and the new identity sticks', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const reg = await postForm('/auth/register', anon, {
      email: 'w@quay.test',
      name: 'Wendell',
      password: 'password-123',
    })
    const authed = sidOf(reg)!
    expect(authed).not.toBe(anon) // fixation defense: fresh id on login

    const html = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${authed}` } }))
    ).text()
    expect(html).toContain('Wendell')
    expect(html).toContain('sign out')

    // the OLD anonymous id gained nothing:
    const oldHtml = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${anon}` } }))
    ).text()
    expect(oldHtml).toContain('Sign in to post')
  })

  it('wrong password bounces without rotation', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const res = await postForm('/auth/login', anon, { email: 'w@quay.test', password: 'nope' })
    expect(sidOf(res)).toBeNull() // no new cookie — failures don't rotate
    expect(await res.text()).toContain('bad-credentials')
  })

  it('posting stamps identity from context; forged events grant nothing', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const authed = sidOf(
      await postForm('/auth/login', anon, { email: 'w@quay.test', password: 'password-123' }),
    )!

    await postForm('/notices/create', authed, { title: 'Mooring fees', body: 'Up 5%.' })
    const html = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${authed}` } }))
    ).text()
    expect(html).toContain('Mooring fees')
    expect(html).toContain('— Wendell')

    // devtools forgery attempts, all uncommitted:
    const fresh = sidOf(await app.fetch(new Request('http://test/')))!
    for (const event of [
      { type: 'POST_NOTICE', title: 'spam', body: 'spam' }, // anonymous: no such transition
      { type: 'LOGIN', email: 'w@quay.test', password: 'guess' }, // guard drop
      { type: 'MODERATE', noticeId: 'n1', action: 'remove' }, // anonymous
    ]) {
      const res = await postEvent(fresh, 'AuthMachine', event)
      const out = (await res.json()) as { committed: boolean }
      expect(out.committed).toBe(false)
    }
  })

  it('logout clears the session outright', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const authed = sidOf(
      await postForm('/auth/login', anon, { email: 'w@quay.test', password: 'password-123' }),
    )!
    const after = sidOf(await postForm('/auth/logout', authed, {}))!
    expect(after).not.toBe(authed)

    for (const sid of [after, authed]) {
      const html = await (
        await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${sid}` } }))
      ).text()
      expect(html).toContain('Sign in to post')
    }
  })
})

describe('coarse admission at the edge (claims projection)', () => {
  // Send an explicit Cookie header (postForm only sends the session id).
  function withCookies(path: string, cookie: string, fields: Record<string, string>) {
    return app.fetch(
      new Request(`http://test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams(fields),
      }),
    )
  }
  // Raw name=value of every Set-Cookie (drop attributes), for replay.
  const cookiePairs = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '')

  it('anonymous is redirected from /profile to /login, with a returnTo stashed', async () => {
    const res = await app.fetch(new Request('http://test/profile'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    // returnTo remembers where they were headed.
    expect(cookiePairs(res).some((p) => p.startsWith('returnTo='))).toBe(true)
  })

  it('after signing in, the stashed returnTo brings you back to /profile', async () => {
    // A member to sign in as.
    const anon0 = sidOf(await app.fetch(new Request('http://test/')))!
    await postForm('/auth/register', anon0, {
      email: 'gate@quay.test',
      name: 'Gatekeeper',
      password: 'password-123',
    })

    // Anonymous hits /profile → gets bounced, collecting the session + returnTo.
    const bounced = await app.fetch(new Request('http://test/profile'))
    const cookie = cookiePairs(bounced).join('; ')

    // Sign in carrying that cookie → the login route reads returnTo and sends
    // us back there (not to '/').
    const login = await withCookies('/auth/login', cookie, {
      email: 'gate@quay.test',
      password: 'password-123',
    })
    const body = (await login.json()) as { directives: Array<{ type: string; to: string }> }
    expect(body.directives[0]).toMatchObject({ type: 'navigate', to: '/profile' })

    // And the rotated session is now admitted to /profile (200, not a redirect).
    const authed = sidOf(login)!
    const page = await app.fetch(
      new Request('http://test/profile', { headers: { Cookie: `stator_sid=${authed}` } }),
    )
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Display name')
  })

  it('a forged returnTo is ignored — no open redirect', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    // Attacker-planted absolute target.
    const login = await withCookies(
      '/auth/login',
      `stator_sid=${anon}; returnTo=${encodeURIComponent('//evil.example')}`,
      { email: 'gate@quay.test', password: 'password-123' },
    )
    const body = (await login.json()) as { directives: Array<{ type: string; to: string }> }
    expect(body.directives[0]).toMatchObject({ type: 'navigate', to: '/' })
  })
})

describe('members-only visibility', () => {
  it("private notices never reach a visitor's wire — and do reach members", async () => {
    const anon0 = sidOf(await app.fetch(new Request('http://test/')))!
    const member = sidOf(
      await postForm('/auth/register', anon0, {
        email: 'keeper@quay.test',
        name: 'Keeper',
        password: 'password-123',
      }),
    )!
    await postForm('/notices/create', member, {
      title: 'Public tide chart',
      body: 'For all.',
    })
    await postForm('/notices/create', member, {
      title: 'Secret members regatta',
      body: 'Berth 9, dawn.',
      membersOnly: 'on',
    })

    // A member sees both — including the private notice's body, which is the
    // real property (the content reached them, not just a badge).
    const memberHtml = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${member}` } }))
    ).text()
    expect(memberHtml).toContain('Public tide chart')
    expect(memberHtml).toContain('Secret members regatta')
    expect(memberHtml).toContain('Berth 9')

    // …a visitor's HTML contains no trace of the private one — not hidden,
    // absent. Server-side filtering means it never crossed the wire.
    const visitor = sidOf(await app.fetch(new Request('http://test/')))!
    const visitorHtml = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${visitor}` } }))
    ).text()
    expect(visitorHtml).toContain('Public tide chart')
    expect(visitorHtml).not.toContain('Secret members regatta')
    expect(visitorHtml).not.toContain('Berth 9')
  })
})

describe('@set cannot forge identity or escalate privilege', () => {
  it('a member @set over /__events is rejected (reserved) and grants nothing', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const member = sidOf(
      await postForm('/auth/register', anon, {
        email: 'mallory@quay.test',
        name: 'Mallory',
        password: 'password-123',
      }),
    )!

    // A plain member cannot moderate — the role guard drops it.
    const before = (await (
      await postEvent(member, 'AuthMachine', { type: 'MODERATE', noticeId: 'n1', action: 'remove' })
    ).json()) as { committed: boolean }
    expect(before.committed).toBe(false)

    // The built-in @set is refused at the wire boundary…
    const set = await postEvent(member, 'AuthMachine', {
      type: '@set',
      key: 'role',
      value: 'harbormaster',
    })
    expect(set.status).toBe(400)

    // …so MODERATE is still guard-dropped: no self-promotion happened.
    const after = (await (
      await postEvent(member, 'AuthMachine', { type: 'MODERATE', noticeId: 'n1', action: 'remove' })
    ).json()) as { committed: boolean }
    expect(after.committed).toBe(false)
  })
})

describe('the JSON board — /api/notices', () => {
  it('one URL, viewer-decided body: members see all, visitors only public', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const member = sidOf(
      await postForm('/auth/register', anon, {
        email: 'api@quay.test',
        name: 'Apia',
        password: 'password-123',
      }),
    )!
    await postForm('/notices/create', member, {
      title: 'API public notice',
      body: 'For every reader.',
    })
    await postForm('/notices/create', member, {
      title: 'API members notice',
      body: 'Slip 3.',
      membersOnly: 'on',
    })

    const asMember = (await (
      await app.fetch(
        new Request('http://test/api/notices', { headers: { Cookie: `stator_sid=${member}` } }),
      )
    ).json()) as { viewer: string; notices: Array<{ title: string; author: string }> }
    expect(asMember.viewer).toBe('member')
    const memberTitles = asMember.notices.map((n) => n.title)
    expect(memberTitles).toContain('API public notice')
    expect(memberTitles).toContain('API members notice')
    expect(asMember.notices.find((n) => n.title === 'API public notice')!.author).toBe('Apia')

    // A fresh visitor at the SAME URL: the members-only notice is absent
    // from the body, not flagged in it — the page's server-side filtering
    // rule, holding on the API plane.
    const visitorRes = await app.fetch(new Request('http://test/api/notices'))
    expect(visitorRes.headers.get('content-type')).toContain('application/json')
    expect(visitorRes.headers.get('etag')).toBeTruthy()
    const asVisitor = (await visitorRes.json()) as {
      viewer: string
      notices: Array<{ title: string }>
    }
    expect(asVisitor.viewer).toBe('visitor')
    const visitorTitles = asVisitor.notices.map((n) => n.title)
    expect(visitorTitles).toContain('API public notice')
    expect(visitorTitles).not.toContain('API members notice')
    expect(JSON.stringify(asVisitor)).not.toContain('Slip 3')
  })
})
