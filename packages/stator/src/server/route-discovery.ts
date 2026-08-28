import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleLoader } from './discovery.ts'
import { dataFileExtensions } from './query-route.ts'
import {
  type ApiRouteDefinition,
  isStatorApiRoute,
  isStatorQueryRoute,
  isStatorRoute,
  type QueryRouteDefinition,
  type RouteDefinition,
} from './routing.ts'

const nativeLoader: ModuleLoader = (file) => import(/* @vite-ignore */ pathToFileURL(file).href)

/** HTTP methods a route file may export. GET goes through `defineRoute`
 *  (page rendering) or `defineApiRoute({ method: 'GET' })` (data route);
 *  the rest go through `defineApiRoute` (command handlers). */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface DiscoveredRoute {
  /** Hono-shaped URL pattern. Path params are `:name`. */
  urlPath: string
  /** Names of path parameters in the order they appear in `urlPath`.
   *  Empty for static routes. */
  paramNames: string[]
  filePath: string
  /** GET route: a page (defineRoute) or a data route (defineApiRoute with
   *  method: 'GET'), discriminated by brand. At most one. */
  GET?: RouteDefinition | QueryRouteDefinition
  /** API routes by method. */
  POST?: ApiRouteDefinition
  PUT?: ApiRouteDefinition
  PATCH?: ApiRouteDefinition
  DELETE?: ApiRouteDefinition
}

/**
 * Walk the routes directory recursively and build URL patterns from file
 * paths. Conventions:
 *
 *   - `routes/foo.ts`           → `/foo`
 *   - `routes/foo/index.ts`     → `/foo`
 *   - `routes/foo/[id].ts`      → `/foo/:id`   (path param `id`)
 *   - `routes/[a]/[b].ts`       → `/:a/:b`
 *   - `routes/foo/[...rest].ts` → `/foo/*rest` (catch-all: terminal, matches
 *     zero+ segments, param is the raw remainder incl. slashes)
 *
 * Files may export any combination of `GET`/`POST`/`PUT`/`PATCH`/`DELETE`.
 * GET is a `defineRoute` (page renderer) or a `defineApiRoute` declaring
 * `method: 'GET'` (data route); the others are `defineApiRoute` commands.
 *
 * Files that don't export anything under an HTTP-method name are silently
 * skipped. With recursive walking, the routes tree often contains utility
 * files (templates, helpers) that aren't routes, and throwing on them would
 * force separate trees. A file that DOES export an HTTP-method name but with
 * the wrong constructor is a hard error, never a skip — a skip here surfaces
 * as an unexplained 404 and a dev banner counting one route short.
 */
export async function discoverRoutes(
  dir: string,
  load: ModuleLoader = nativeLoader,
): Promise<DiscoveredRoute[]> {
  const absDir = resolve(dir)
  const files = await walkRouteFiles(absDir)
  const routes: DiscoveredRoute[] = []

  for (const filePath of files) {
    const mod = await load(filePath)

    // GET is a page (defineRoute) or a data route (defineApiRoute with
    // method: 'GET'); POST/PUT/PATCH/DELETE are command API routes.
    const get =
      isStatorRoute(mod.GET) || isStatorQueryRoute(mod.GET)
        ? (mod.GET as RouteDefinition | QueryRouteDefinition)
        : undefined
    const post = isStatorApiRoute(mod.POST) ? (mod.POST as ApiRouteDefinition) : undefined
    const put = isStatorApiRoute(mod.PUT) ? (mod.PUT as ApiRouteDefinition) : undefined
    const patch = isStatorApiRoute(mod.PATCH) ? (mod.PATCH as ApiRouteDefinition) : undefined
    const del = isStatorApiRoute(mod.DELETE) ? (mod.DELETE as ApiRouteDefinition) : undefined

    // Catch the easy mistake: GET defined with `defineApiRoute`, or a
    // mutation method defined with `defineRoute`. Throw with a clear hint.
    // These run BEFORE the not-a-route skip below: a file whose only export
    // is a mis-constructed method name must error, not vanish as a utility.
    if (mod.GET && !get) {
      throw new Error(
        isStatorApiRoute(mod.GET)
          ? `stator: ${filePath} exports GET from defineApiRoute() without method: 'GET'. ` +
              `A GET is a page (defineRoute) or a data route (defineApiRoute({ method: 'GET', … })).`
          : `stator: ${filePath} exports GET but it is neither a defineRoute (page) nor a ` +
              `defineApiRoute({ method: 'GET' }) (data route).`,
      )
    }
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      if (!mod[m]) continue
      if (isStatorQueryRoute(mod[m])) {
        throw new Error(
          `stator: ${filePath} exports ${m} created with method: 'GET' — the declared method ` +
            `must match the export name. Data routes are GET-only.`,
        )
      }
      if (!isStatorApiRoute(mod[m])) {
        throw new Error(
          `stator: ${filePath} exports ${m} but it is not a defineApiRoute. ` +
            `${m} handlers must be created with defineApiRoute(); defineRoute() is GET-only.`,
        )
      }
    }

    if (!get && !post && !put && !patch && !del) {
      // An extension-named file (feed.xml.ts) is unambiguously a route file —
      // exporting nothing route-shaped from one is a mistake, not a utility.
      const secondExt = extname(basename(filePath, extname(filePath))).slice(1)
      if (dataFileExtensions.has(secondExt)) {
        throw new Error(
          `stator: ${filePath} is named like a data route (.${secondExt}${extname(filePath)}) ` +
            `but exports no route. Export GET = defineApiRoute({ method: 'GET', … }) or rename the file.`,
        )
      }
      continue
    }

    const { urlPath, paramNames } = filePathToRoute(absDir, filePath)
    routes.push({
      urlPath,
      paramNames,
      filePath,
      GET: get,
      POST: post,
      PUT: put,
      PATCH: patch,
      DELETE: del,
    })
  }

  return sortRoutes(mergeByUrlPath(routes))
}

/**
 * Merge routes that resolve to the same URL pattern (e.g. `about.stator`
 * contributing GET and `about.ts` contributing POST). Same method on two files
 * for one URL is a hard error.
 */
function mergeByUrlPath(routes: DiscoveredRoute[]): DiscoveredRoute[] {
  const byPath = new Map<string, DiscoveredRoute>()
  for (const r of routes) {
    const existing = byPath.get(r.urlPath)
    if (!existing) {
      byPath.set(r.urlPath, r)
      continue
    }
    for (const m of HTTP_METHODS) {
      if (r[m] === undefined) continue
      if (existing[m] !== undefined) {
        throw new Error(
          `stator: two files define ${m} for "${r.urlPath}" ` +
            `(${existing.filePath} and ${r.filePath}). A URL may have at most one handler per method.`,
        )
      }
      ;(existing as unknown as Record<string, unknown>)[m] = r[m]
    }
  }
  return [...byPath.values()]
}

/**
 * Sort routes most-specific-first (Astro's model). At match time the first
 * matcher that matches wins, so order encodes priority:
 *   - routes without a rest/catch-all segment rank before those with one
 *   - per segment, left to right: static (0) > suffixed param `:id.json` (1)
 *     > bare param (2) > rest (3) — a suffixed param outranks a bare one so
 *     `/p/:id.json` wins `/p/abc.json` before `/p/:id` can swallow it
 *   - more segments before fewer
 *   - ties alphabetically by urlPath
 */
export function sortRoutes(routes: DiscoveredRoute[]): DiscoveredRoute[] {
  const kinds = (urlPath: string): number[] =>
    urlPath
      .split('/')
      .filter(Boolean)
      .map((seg) =>
        seg.startsWith('*') ? 3 : seg.startsWith(':') ? (seg.includes('.') ? 1 : 2) : 0,
      )

  return [...routes].sort((a, b) => {
    const ka = kinds(a.urlPath)
    const kb = kinds(b.urlPath)
    const aRest = ka.includes(3)
    const bRest = kb.includes(3)
    if (aRest !== bRest) return aRest ? 1 : -1 // no-rest first
    const len = Math.min(ka.length, kb.length)
    for (let i = 0; i < len; i++) {
      if (ka[i] !== kb[i]) return ka[i]! - kb[i]! // lower kind = more specific
    }
    if (ka.length !== kb.length) return kb.length - ka.length // more segments first
    return a.urlPath < b.urlPath ? -1 : a.urlPath > b.urlPath ? 1 : 0
  })
}

async function walkRouteFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  // A missing routes dir means "no routes yet", not an error.
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  for (const e of entries) {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walkRouteFiles(full)))
      continue
    }
    if (!e.isFile()) continue
    const ext = extname(e.name)
    // `.stator` route pages compile (via the loader) to a module exporting GET;
    // `.ts`/`.js` carry API handlers (and merge with a same-named page).
    if (ext !== '.ts' && ext !== '.js' && ext !== '.stator') continue
    out.push(full)
  }
  return out
}

/**
 * Turn an absolute file path inside the routes dir into a `/foo/:bar` URL
 * pattern plus the list of param names extracted from `[brackets]`.
 */
export function filePathToRoute(
  absDir: string,
  filePath: string,
): { urlPath: string; paramNames: string[] } {
  const ext = extname(filePath)
  const rel = relative(absDir, filePath)
  const dirSegments = dirname(rel)
    .split(sep)
    .filter((s) => s && s !== '.')
  // Strip a residual `.stator` too: production builds compile route pages to
  // sibling `<name>.stator.ts` files, which must map to the same URL as the
  // `<name>.stator` source did in dev.
  const fileBase = basename(rel, ext).replace(/\.stator$/, '')
  const segments = fileBase === 'index' ? dirSegments : [...dirSegments, fileBase]

  if (segments.length === 0) return { urlPath: '/', paramNames: [] }

  const paramNames: string[] = []
  const urlSegments = segments.map((seg) => {
    // Rest / catch-all: `[...name]` → `*name` (matches zero or more segments).
    const rest = seg.match(/^\[\.\.\.(.+)\]$/)
    if (rest) {
      const name = rest[1]!
      paramNames.push(name)
      return `*${name}`
    }
    // Param, optionally with a literal extension suffix: `[id].json` →
    // `:id.json` (param `id`; the URL literally ends in `.json`). This is the
    // data-route extension convention composing with dynamic segments — the
    // suffix stays out of the captured value at match time.
    const m = seg.match(/^\[([^\]]+)\](\.[\w.]+)?$/)
    if (m) {
      const name = m[1]!
      if (name.startsWith('...')) {
        throw new Error(
          `stator: rest segment [${name}]${m[2] ?? ''} cannot carry an extension suffix — ` +
            `a rest param spans whole segments.`,
        )
      }
      paramNames.push(name)
      return `:${name}${m[2] ?? ''}`
    }
    return seg
  })

  return { urlPath: `/${urlSegments.join('/')}`, paramNames }
}
