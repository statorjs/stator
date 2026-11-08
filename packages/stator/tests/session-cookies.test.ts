import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = resolve(new URL('.', import.meta.url).pathname)
const fixtures = resolve(here, 'fixtures')

async function boot(): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
}

/** All Set-Cookie values on a response (getSetCookie keeps them un-merged). */
const setCookies = (res: Response) => res.headers.getSetCookie()

function post(app: StatorApp, cookie?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    // HTML client with no navigate directive → the 204 path.
    Accept: 'text/html',
    Origin: 'http://localhost',
  }
  if (cookie) headers.Cookie = cookie
  return app.fetch(
    new Request('http://localhost/cookie-echo', {
      method: 'POST',
      headers,
      body: new URLSearchParams(),
    }),
  )
}

describe('cookie jar', () => {
  it('writes survive the no-directive 204 path', async () => {
    const app = await boot()
    const res = await post(app)
    assert.equal(res.status, 204)
    const jar = setCookies(res)
    // The app cookie set in the handler is present alongside the session cookie.
    assert.equal(
      jar.some((c) => c.startsWith('seen=yes')),
      true,
    )
    assert.equal(
      jar.some((c) => c.includes('HttpOnly')),
      true,
    )
  })

  it('get() reads the inbound request cookie', async () => {
    const app = await boot()
    // Send an existing session so only app cookies are new, plus pref=dark.
    const res = await post(app, 'stator_sid=fixed-sid; pref=dark')
    const jar = setCookies(res)
    assert.equal(
      jar.some((c) => c.startsWith('echoed=dark')),
      true,
    )
  })
})
