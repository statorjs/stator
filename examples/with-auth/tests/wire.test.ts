import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
