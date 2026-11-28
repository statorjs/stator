import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { dirname, resolve } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { limitLog } from '../src/server/body-limit.ts'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import { BodyTooLargeError } from '../src/server/index.ts'
import { defineApiRoute } from '../src/server/routing.ts'
import { calls } from './fixtures/body-limit/calls.ts'

/**
 * `requests.maxBodyBytes` and a command route's `maxBodyBytes`: a declared
 * `Content-Length` over the limit is refused before the handler runs; a
 * chunked body is counted as it is read and the request ends as a 413 however
 * the handler handles the failed read.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/body-limit')

const boot = (extra: Record<string, unknown> = {}): Promise<StatorApp> =>
  createApp({
    machinesDir: resolve(root, 'machines'),
    routesDir: resolve(root, 'routes'),
    middlewareFile: resolve(root, 'middleware.ts'),
    ...extra,
  })

const limited = (maxBodyBytes: number) => boot({ requests: { maxBodyBytes } })

/** A body with no `Content-Length`: `size` bytes in 1 KiB chunks, pulled. */
function chunked(size: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close()
      const n = Math.min(1024, size - sent)
      sent += n
      controller.enqueue(new Uint8Array(n).fill(97))
    },
  })
}

const post = (
  app: StatorApp,
  path: string,
  body: BodyInit | ReadableStream<Uint8Array>,
  init: RequestInit = {},
) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      body,
      duplex: 'half',
      ...init,
    } as RequestInit),
  )

/** `app.fetch` does not compute a `Content-Length` the way a client does. */
const declared = (n: number): RequestInit => ({ headers: { 'content-length': String(n) } })

const assert413 = async (res: Response, limit: number) => {
  assert.equal(res.status, 413)
  assert.deepEqual(await res.json(), { error: `request body exceeds ${limit} bytes` })
  assert.equal(res.headers.get('x-handler'), null)
  assert.equal(res.headers.get('set-cookie'), null)
}

/** Watch the body-limit logger's warnings for one test. Call after booting:
 *  setting the log level (createApp does) reassigns pino's level methods. */
function watchWarnings(t: TestContext): string[] {
  const lines: string[] = []
  t.mock.method(limitLog, 'warn', (_obj: unknown, msg: string) => {
    lines.push(msg)
  })
  return lines
}

describe('body limit: declared length', () => {
  it('refuses a Content-Length over the limit before the handler runs, with no session', async (t) => {
    const app = await limited(1024)
    const warnings = watchWarnings(t)
    const before = calls.upload
    const res = await post(app, '/upload', 'x'.repeat(2048), declared(2048))
    await assert413(res, 1024)
    assert.equal(calls.upload, before, 'handler not called')
    assert.deepEqual(warnings, [
      "stator: POST /upload refused: body exceeds 1024 bytes (requests.maxBodyBytes). Raise it in stator.config.ts, or set maxBodyBytes on this route's defineApiRoute.",
    ])
  })

  it('names the route file when the route set the limit', async (t) => {
    const app = await boot()
    const warnings = watchWarnings(t)
    const res = await post(app, '/limited', 'x'.repeat(5000), declared(5000))
    await assert413(res, 4096)
    assert.match(
      warnings[0] ?? '',
      /\(maxBodyBytes on .*fixtures\/body-limit\/routes\/limited\.ts\)/,
    )
  })

  it('refuses a declared oversize body even when the handler would not read it', async () => {
    const res = await post(await limited(10), '/upload?read=none', 'x'.repeat(11), declared(11))
    await assert413(res, 10)
  })
})

describe('body limit: counted length', () => {
  it('is a 413 when the handler lets the read throw', async () => {
    await assert413(await post(await limited(4096), '/upload', chunked(10_000)), 4096)
  })

  it('is a 413 when the handler catches the read and returns a 400', async () => {
    await assert413(await post(await limited(4096), '/upload?read=catch', chunked(10_000)), 4096)
  })

  it('is a 413 when the handler returns its own Response', async () => {
    await assert413(await post(await limited(4096), '/upload?read=stream', chunked(10_000)), 4096)
  })

  it('never passes more than the limit to the reader', async () => {
    // The stream handler reports what it got before the error; the 413 hides
    // that from the client, so read the count off a route with a large limit
    // for the comparison and check the refusal stopped the source.
    let pulled = 0
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024
        if (pulled > 1_000_000) return controller.close()
        controller.enqueue(new Uint8Array(1024))
      },
    })
    const res = await post(await limited(4096), '/upload', source)
    assert.equal(res.status, 413)
    assert.ok(pulled < 64 * 1024, `pulled ${pulled} bytes from the source`)
  })

  it('answers normally when the handler ignores an oversize chunked body', async () => {
    const res = await post(await limited(1024), '/upload?read=none', chunked(10_000))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ignored: true })
  })
})

describe('body limit: under the limit', () => {
  it('passes the body intact to every reader', async () => {
    const app = await limited(64 * 1024)
    const text = 'x'.repeat(5000)

    const asText = await post(app, '/upload?read=text', chunked(5000))
    assert.deepEqual(await asText.json(), { size: 5000 })

    const asBuffer = await post(app, '/upload?read=buffer', text)
    assert.deepEqual(await asBuffer.json(), { size: 5000 })

    const asJson = await post(app, '/upload?read=json', JSON.stringify({ text }), {
      headers: { 'content-type': 'application/json' },
    })
    assert.deepEqual(await asJson.json(), { size: JSON.stringify({ text }).length })

    const form = new FormData()
    form.set('file', new File([text], 'a.txt'))
    const asForm = await post(app, '/upload?read=form', form)
    assert.deepEqual(await asForm.json(), { size: 5000 })

    const asRaw = await post(app, '/upload?read=stream', chunked(5000))
    assert.equal(await asRaw.text(), 'streamed 5000')
  })
})

describe('body limit: resolution', () => {
  it('a route limit above the project value admits; below it refuses', async () => {
    const app = await limited(100)
    const above = await post(app, '/limited', 'x'.repeat(1000))
    assert.deepEqual(await above.json(), { size: 1000 })
    const put = await app.fetch(
      new Request('http://localhost/limited', { method: 'PUT', body: 'x'.repeat(80) }),
    )
    await assert413(put, 64)
  })

  it('keeps separate limits for POST and PUT on one URL', async () => {
    const app = await boot()
    const okPost = await post(app, '/limited', chunked(1000))
    assert.equal(okPost.status, 200)
    const put = await app.fetch(
      new Request('http://localhost/limited', {
        method: 'PUT',
        body: chunked(1000),
        duplex: 'half',
      } as RequestInit),
    )
    await assert413(put, 64)
  })

  it('Infinity on a route admits under a finite project value', async () => {
    const res = await post(await limited(10), '/open', chunked(50_000))
    assert.deepEqual(await res.json(), { size: 50_000 })
  })

  it("counts a body read in middleware, with the route's limit when a route matches", async () => {
    const app = await limited(1_000_000)
    await assert413(await post(app, '/hook', chunked(100)), 32)
    const ok = await post(app, '/hook', 'x'.repeat(20))
    assert.deepEqual(await ok.json(), { middleware: 20 })
  })

  it("counts a body read in middleware with the project's limit when no route matches", async () => {
    const app = await limited(50)
    await assert413(await post(app, '/webhook', chunked(100)), 50)
    const ok = await post(app, '/webhook', 'x'.repeat(40))
    assert.deepEqual(await ok.json(), { middleware: 40 })
  })

  it('leaves /__events to events.maxBytes', async () => {
    const app = await boot({ requests: { maxBodyBytes: 10 }, events: { gate: 'off' } })
    const res = await post(
      app,
      '/__events',
      JSON.stringify({ machine: 'Nope', event: { type: 'X' } }),
      {
        headers: { 'content-type': 'application/json', 'x-stator-route': 'GET /page' },
      },
    )
    assert.notEqual(res.status, 413)
    const tooBig = await post(
      app,
      '/__events',
      JSON.stringify({ machine: 'Nope', event: { type: 'X', pad: 'x'.repeat(70_000) } }),
      { headers: { 'content-type': 'application/json', 'x-stator-route': 'GET /page' } },
    )
    assert.equal(tooBig.status, 413)
    assert.deepEqual(await tooBig.json(), { error: 'event body exceeds 65536 bytes' })
  })

  it('applies without the security defaults', async () => {
    const res = await post(
      await boot({ requests: { maxBodyBytes: 10 }, middlewareFile: undefined }),
      '/upload',
      'x'.repeat(11),
    )
    assert.equal(res.status, 413)
  })
})

describe('body limit: the 3.x warning', () => {
  it('with nothing set, accepts a 2 MiB body and warns once for two requests to one route', async (t) => {
    const app = await boot()
    const warnings = watchWarnings(t)
    const size = 2 * 1024 * 1024
    for (let i = 0; i < 2; i++) {
      const res = await post(app, '/upload', chunked(size))
      assert.deepEqual(await res.json(), { size })
    }
    assert.deepEqual(warnings, [
      `stator: POST /upload received a ${size}-byte body and no limit is set. 4.0 will refuse bodies over 1048576 bytes by default. Set maxBodyBytes on this route's defineApiRoute, or requests.maxBodyBytes in stator.config.ts.`,
    ])
  })

  it('does not warn when either key is set', async (t) => {
    const size = 2 * 1024 * 1024
    const projectInfinity = await boot({ requests: { maxBodyBytes: Infinity } })
    const projectLarge = await limited(4 * 1024 * 1024)
    const routeInfinity = await boot()
    const warnings = watchWarnings(t)
    assert.equal((await post(projectInfinity, '/upload', chunked(size))).status, 200)
    assert.equal((await post(projectLarge, '/upload', chunked(size))).status, 200)
    assert.equal((await post(routeInfinity, '/open', chunked(size))).status, 200)
    assert.deepEqual(warnings, [])
  })
})

describe('body limit: definition and config', () => {
  it('defineApiRoute throws on a limit that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, '1024']) {
      assert.throws(
        () => defineApiRoute({ maxBodyBytes: bad as number, handler: () => ({}) }),
        /stator: defineApiRoute maxBodyBytes must be a positive number of bytes/,
        String(bad),
      )
    }
    assert.equal(
      defineApiRoute({ maxBodyBytes: Infinity, handler: () => ({}) }).maxBodyBytes,
      Infinity,
    )
  })

  it('requests.maxBodyBytes must be a positive number', async () => {
    await assert.rejects(
      limited(0),
      /stator: requests\.maxBodyBytes must be a positive number of bytes/,
    )
  })

  it('BodyTooLargeError carries the limit', () => {
    const err = new BodyTooLargeError(10)
    assert.equal(err.name, 'BodyTooLargeError')
    assert.equal(err.limit, 10)
    assert.ok(err instanceof Error)
  })
})

describe('body limit: over a real socket', () => {
  /** POST over node:http, writing `chunks` of 1 KiB; `declared` sets a
   *  Content-Length, otherwise the body is chunked. */
  const send = (port: number, chunks: number, declared?: number) =>
    new Promise<{ status: number; body: string }>((done, fail) => {
      const req = httpRequest(
        {
          port,
          host: '127.0.0.1',
          method: 'POST',
          path: '/upload',
          headers: declared === undefined ? {} : { 'content-length': String(declared) },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d) => {
            body += d
          })
          res.on('end', () => done({ status: res.statusCode ?? 0, body }))
        },
      )
      // The server may answer and close before the body is all written.
      req.on('error', (err) => {
        if (
          (err as NodeJS.ErrnoException).code !== 'EPIPE' &&
          (err as NodeJS.ErrnoException).code !== 'ECONNRESET'
        )
          fail(err)
      })
      let i = 0
      const write = () => {
        while (i < chunks) {
          i++
          if (!req.write(Buffer.alloc(1024, 97))) return void req.once('drain', write)
        }
        req.end()
      }
      write()
    })

  it('refuses declared and chunked bodies over the limit', async () => {
    const app = await limited(4096)
    const { port } = await app.listen(0)
    try {
      const declared = await send(port, 16, 16 * 1024)
      assert.equal(declared.status, 413)
      assert.deepEqual(JSON.parse(declared.body), { error: 'request body exceeds 4096 bytes' })
      const counted = await send(port, 16)
      assert.equal(counted.status, 413)
      assert.deepEqual(JSON.parse(counted.body), { error: 'request body exceeds 4096 bytes' })
      const fits = await send(port, 2)
      assert.equal(fits.status, 200)
      assert.deepEqual(JSON.parse(fits.body), { size: 2048 })
    } finally {
      await app.close()
    }
  })
})
