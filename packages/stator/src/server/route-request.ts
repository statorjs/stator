import type { Context } from 'hono'
import type { RouteRequest } from './routing.ts'
import { readClaims, sessionUse } from './session.ts'

/** A read-tracking view over the request's headers. Any read marks the
 *  response as request-varying (layer 3: a page that consulted a header may
 *  differ per visitor, so it is never cache-marked). Methods are bound to the
 *  real Headers, so the view behaves as one. */
function trackedHeaders(c: Context, headers: Headers): Headers {
  return new Proxy(headers, {
    get(target, prop) {
      sessionUse(c).varied = true
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Wrap Hono's request into the framework's RouteRequest shape. The raw
 * `Request` is exposed for escape hatches, plus a small layer of convenience
 * (params + query) the framework already does at routing time.
 */
export function buildRouteRequest(c: Context, paramNames: string[]): RouteRequest {
  const raw = c.req.raw
  const params: Record<string, string> = {}
  for (const name of paramNames) {
    const v = c.req.param(name)
    if (v !== undefined) params[name] = v
  }
  const query: Record<string, string | undefined> = c.req.query()
  const headers = trackedHeaders(c, raw.headers)

  return {
    raw,
    params,
    query,
    get method() {
      return raw.method
    },
    get url() {
      return raw.url
    },
    get headers() {
      return headers
    },
    claims: <T = unknown>() => readClaims<T>(c),
    formData: () => raw.formData(),
    json: <T = unknown>() => raw.json() as Promise<T>,
    text: () => raw.text(),
    arrayBuffer: () => raw.arrayBuffer(),
  }
}
