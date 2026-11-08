import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'


/**
 * The full auth arc over the wire: register → rotated session → post
 * (identity stamped) → forged-identity attempts bounce → logout clears.
 */

process.env.WITH_AUTH_DB = join(mkdtempSync(join(tmpdir(), 'quay-wire-')), 'test.db')

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  const { seedHarbormaster } = await import('../lib/seed.ts')
  seedHarbormaster()
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
}, { timeout: 30_000 })

after(async () => {
  await app.close()
})

function sidOf(res: Response): string | null {
  // Lazy sessions can establish AND rotate in one request (login), emitting
  // two stator_sid Set-Cookies — the LAST one is the live sid (browser rule).
  const matches = [...(res.headers.get('set-cookie') ?? '').matchAll(/stator_sid=([^;,\s]+)/g)]
  return matches.at(-1)?.[1] ?? null
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
    assert.notEqual(authed, anon) // fixation defense: fresh id on login

    const html = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${authed}` } }))
    ).text()
    assert.ok(html.includes('Wendell'))
    assert.ok(html.includes('sign out'))

    // the OLD anonymous id gained nothing:
    const oldHtml = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${anon}` } }))
    ).text()
    assert.ok(oldHtml.includes('Sign in to post'))
  })

  it('wrong password bounces without rotation', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const res = await postForm('/auth/login', anon, { email: 'w@quay.test', password: 'nope' })
    assert.equal(sidOf(res), null) // no new cookie — failures don't rotate
    assert.ok((await res.text()).includes('bad-credentials'))
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
    assert.ok(html.includes('Mooring fees'))
    assert.ok(html.includes('— Wendell'))

    // devtools forgery attempts, all uncommitted:
    const fresh = sidOf(await app.fetch(new Request('http://test/')))!
    for (const event of [
      { type: 'POST_NOTICE', title: 'spam', body: 'spam' }, // anonymous: no such transition
      { type: 'LOGIN', email: 'w@quay.test', password: 'guess' }, // guard drop
      { type: 'MODERATE', noticeId: 'n1', action: 'remove' }, // anonymous
    ]) {
      const res = await postEvent(fresh, 'AuthMachine', event)
      const out = (await res.json()) as { committed: boolean }
      assert.equal(out.committed, false)
    }
  })

  it('logout clears the session outright', async () => {
    const anon = sidOf(await app.fetch(new Request('http://test/')))!
    const authed = sidOf(
      await postForm('/auth/login', anon, { email: 'w@quay.test', password: 'password-123' }),
    )!
    const after = sidOf(await postForm('/auth/logout', authed, {}))!
    assert.notEqual(after, authed)

    for (const sid of [after, authed]) {
      const html = await (
        await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${sid}` } }))
      ).text()
      assert.ok(html.includes('Sign in to post'))
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
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/login')
    // returnTo remembers where they were headed.
    assert.equal(cookiePairs(res).some((p) => p.startsWith('returnTo=')), true)
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
    assert.partialDeepStrictEqual(body.directives[0], { type: 'navigate', to: '/profile' })

    // And the rotated session is now admitted to /profile (200, not a redirect).
    const authed = sidOf(login)!
    const page = await app.fetch(
      new Request('http://test/profile', { headers: { Cookie: `stator_sid=${authed}` } }),
    )
    assert.equal(page.status, 200)
    assert.ok((await page.text()).includes('Display name'))
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
    assert.partialDeepStrictEqual(body.directives[0], { type: 'navigate', to: '/' })
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
    assert.ok(memberHtml.includes('Public tide chart'))
    assert.ok(memberHtml.includes('Secret members regatta'))
    assert.ok(memberHtml.includes('Berth 9'))

    // …a visitor's HTML contains no trace of the private one — not hidden,
    // absent. Server-side filtering means it never crossed the wire.
    const visitor = sidOf(await app.fetch(new Request('http://test/')))!
    const visitorHtml = await (
      await app.fetch(new Request('http://test/', { headers: { Cookie: `stator_sid=${visitor}` } }))
    ).text()
    assert.ok(visitorHtml.includes('Public tide chart'))
    assert.ok(!visitorHtml.includes('Secret members regatta'))
    assert.ok(!visitorHtml.includes('Berth 9'))
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
    assert.equal(before.committed, false)

    // The built-in @set is refused at the wire boundary…
    const set = await postEvent(member, 'AuthMachine', {
      type: '@set',
      key: 'role',
      value: 'harbormaster',
    })
    assert.equal(set.status, 400)

    // …so MODERATE is still guard-dropped: no self-promotion happened.
    const after = (await (
      await postEvent(member, 'AuthMachine', { type: 'MODERATE', noticeId: 'n1', action: 'remove' })
    ).json()) as { committed: boolean }
    assert.equal(after.committed, false)
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
    assert.equal(asMember.viewer, 'member')
    const memberTitles = asMember.notices.map((n) => n.title)
    assert.ok(memberTitles.includes('API public notice'))
    assert.ok(memberTitles.includes('API members notice'))
    assert.equal(asMember.notices.find((n) => n.title === 'API public notice')!.author, 'Apia')

    // A fresh visitor at the SAME URL: the members-only notice is absent
    // from the body, not flagged in it — the page's server-side filtering
    // rule, holding on the API plane.
    const visitorRes = await app.fetch(new Request('http://test/api/notices'))
    assert.ok((visitorRes.headers.get('content-type')).includes('application/json'))
    assert.ok(visitorRes.headers.get('etag'))
    const asVisitor = (await visitorRes.json()) as {
      viewer: string
      notices: Array<{ title: string }>
    }
    assert.equal(asVisitor.viewer, 'visitor')
    const visitorTitles = asVisitor.notices.map((n) => n.title)
    assert.ok(visitorTitles.includes('API public notice'))
    assert.ok(!visitorTitles.includes('API members notice'))
    assert.ok(!(JSON.stringify(asVisitor)).includes('Slip 3'))
  })
})
