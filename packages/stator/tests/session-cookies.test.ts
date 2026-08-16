import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    expect(res.status).toBe(204)
    const jar = setCookies(res)
    // The app cookie set in the handler is present alongside the session cookie.
    expect(jar.some((c) => c.startsWith('seen=yes'))).toBe(true)
    expect(jar.some((c) => c.includes('HttpOnly'))).toBe(true)
  })

  it('get() reads the inbound request cookie', async () => {
    const app = await boot()
    // Send an existing session so only app cookies are new, plus pref=dark.
    const res = await post(app, 'stator_sid=fixed-sid; pref=dark')
    const jar = setCookies(res)
    expect(jar.some((c) => c.startsWith('echoed=dark'))).toBe(true)
  })
})
