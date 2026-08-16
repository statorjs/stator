import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

function boot() {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    middlewareFile: resolve(fixtures, 'mw-claims-echo.ts'),
  })
}

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''

describe('session claims', () => {
  it('persists claims and loads them on a later request for the same session', async () => {
    const app = await boot()
    const r1 = await app.fetch(
      new Request('http://localhost/', {
        headers: { 'x-set-claims': JSON.stringify({ userId: 'u1' }) },
      }),
    )
    const cookie = cookieOf(r1)
    const r2 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(JSON.parse(r2.headers.get('x-claims') ?? 'null')).toEqual({ userId: 'u1' })
  })

  it('a fresh session has no claims', async () => {
    const app = await boot()
    const r = await app.fetch(new Request('http://localhost/'))
    expect(r.headers.get('x-claims')).toBeNull()
  })

  it('clearClaims removes them for subsequent requests', async () => {
    const app = await boot()
    const r1 = await app.fetch(
      new Request('http://localhost/', {
        headers: { 'x-set-claims': JSON.stringify({ userId: 'u1' }) },
      }),
    )
    const cookie = cookieOf(r1)
    await app.fetch(
      new Request('http://localhost/', { headers: { Cookie: cookie, 'x-clear-claims': '1' } }),
    )
    const r3 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(r3.headers.get('x-claims')).toBeNull()
  })
})
