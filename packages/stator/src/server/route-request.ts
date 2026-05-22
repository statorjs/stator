import type { Context } from 'hono'
import type { RouteRequest } from './routing.ts'

/**
 * Wrap Hono's request into the framework's RouteRequest shape. The raw
 * `Request` is exposed for escape hatches, plus a small layer of convenience
 * (params + query) the framework already does at routing time.
 */
export function buildRouteRequest(
  c: Context,
  paramNames: string[],
): RouteRequest {
  const raw = c.req.raw
  const params: Record<string, string> = {}
  for (const name of paramNames) {
    const v = c.req.param(name)
    if (v !== undefined) params[name] = v
  }
  const query: Record<string, string | undefined> = c.req.query()

  return {
    raw,
    params,
    query,
    get method() { return raw.method },
    get url() { return raw.url },
    get headers() { return raw.headers },
    formData: () => raw.formData(),
    json: <T = unknown>() => raw.json() as Promise<T>,
    text: () => raw.text(),
    arrayBuffer: () => raw.arrayBuffer(),
  }
}
