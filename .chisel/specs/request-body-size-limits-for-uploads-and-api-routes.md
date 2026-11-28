---
title: Request body size limits for uploads and API routes
status: shipped
created: 2026-11-22
updated: 2026-11-27
area: server
---

## What and Why

The 3.0 audit capped `/__events` bodies at 64 KiB (`events.maxBytes`, `readCapped` in `server/http.ts`) and left every other request body unbounded, by decision. An API route that calls `request.formData()` or `request.json()` buffers whatever the client sends: undici parses multipart into memory, so a 2 GB POST to any command route is 2 GB of heap before the handler's own `file.size` check can run. The file-uploads recipe says as much and sends the reader to their proxy.

3.1 adds a limit the framework enforces itself, set per project in `stator.config.ts` and overridden per route on `defineApiRoute`. The open part is the default: a cap that appears in a minor breaks apps that upload large files today.

**Where bodies are read** (verified at 3.0.3):

| Surface | Code | Today |
| --- | --- | --- |
| `/__events` | `server/http.ts`, `readCapped` | Capped, `events.maxBytes`, default 65536 |
| Command routes (`POST`/`PUT`/`PATCH`/`DELETE`) | `server/api-route.ts` `runApiRoute` → the handler, through `request.formData()`/`json()`/`text()`/`arrayBuffer()` or `request.raw` (`server/route-request.ts`) | Uncapped, read lazily by the handler |
| App middleware (`middleware.ts`) | plain Hono handlers registered in `server/http.ts`; may call `c.req.json()` and friends | Uncapped |
| Pages and data GET routes | same `RouteRequest`, but a GET carries no body under `@hono/node-server` | Nothing to read |
| Image endpoint, `/__sse`, `/static/*`, `/@stator/inspect`, dev server assets | GET only | Nothing to read |

So there are two uncapped readers, the command-route handler and app middleware, and both see the request through `c.req.raw`.

## Success Criteria

- `requests.maxBodyBytes` in `stator.config.ts` caps every request body outside `/__events`. `maxBodyBytes` on a command route's `defineApiRoute` overrides it for that route and method, up or down.
- A body over its limit is answered `413` with `{ "error": "request body exceeds N bytes" }`. When `Content-Length` declares it, the refusal happens before the handler, before a session is established and before a byte is read. When it does not (chunked), the refusal happens while the body is read, and no more than the limit is ever buffered.
- The 413 goes out whatever the handler does with the failed read: let it throw, catch it, or return its own response.
- A handler that never reads the body is unaffected unless `Content-Length` already put the request over.
- The server log line for a refusal names the route, the limit, where the limit came from, and both keys that raise it.
- 3.1 changes no behaviour for an app that sets neither key. A body larger than the 4.0 default logs one warning per route naming the keys.
- `stator dev` and `stator start` enforce the same limit.

## Constraints

- Non-breaking in 3.1. The default cap is the breaking half and rides 4.0 (the major-cutover pairing in `ROADMAP.md`, Surface hygiene).
- Config holds data, never a switch: a number of bytes, like `events.maxBytes`. The check is framework plumbing, not middleware an app can drop; `dangerouslyDefineMiddleware` does not remove it. `Infinity` is how an app says "no limit" and it is still a number.
- One limit per request, counted over the body as Node hands it over. No per-file or per-field multipart limits.
- No buffering by the framework. The body stays a stream the handler reads when it chooses; the limit only counts what passes.
- `/__events` keeps its own cap and its own reader. This spec does not touch `readCapped`.

## Approach

### Config

A new policy group beside `events`, in `packages/stator/src/config.ts`:

```ts
/** Request policy for everything outside `/__events` (which has its own cap,
 *  `events.maxBytes`). */
requests?: {
  /** Largest request body accepted, in bytes: API routes and anything app
   *  middleware reads. A route can set its own with `maxBodyBytes` on
   *  `defineApiRoute`. `Infinity` accepts any size. Default: no limit in 3.x
   *  (a body over 1048576 logs a warning); 1048576 from 4.0. */
  maxBodyBytes?: number
}
```

```ts title="stator.config.ts"
export default defineConfig({
  requests: { maxBodyBytes: 1024 * 1024 },
})
```

`requests` is the group, in the plural-noun style of `sessions` and `events`, and leaves room for the next sibling (a read timeout is the obvious one). The leaf is `maxBodyBytes` rather than `maxBytes` so the route-level field can carry the same name: on a route, a bare `maxBytes` could as easily mean the response.

### Per route

On the command config and definition in `packages/stator/src/server/routing.ts`:

```ts
export interface DefineApiRouteConfig<TReads extends ReadonlyArray<AnyMachineDef>> {
  method?: CommandMethod   // from [[defineapiroute-takes-any-http-method]]
  /** Largest request body this route accepts, in bytes. Overrides
   *  `requests.maxBodyBytes` for this route and method. */
  maxBodyBytes?: number
  reads?: TReads
  handler: …
}
```

```ts
// routes/admin/publish.ts — a 10 MiB photo plus the form around it
export const POST = defineApiRoute({
  maxBodyBytes: 12 * 1024 * 1024,
  reads: [PostsMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    …
  },
})
```

Not on `DefineQueryRouteConfig`: a data GET has no body, and the excess-property error says so. `defineApiRoute` throws at definition time on a value that is not a positive number (`Infinity` allowed), naming the field. `ApiRouteDefinition` carries the number; nothing else about the definition changes.

The limit for a request resolves in this order:

1. `maxBodyBytes` on the matched route's definition for the request's method.
2. `requests.maxBodyBytes`.
3. The default: none in 3.x, 1048576 in 4.0.

A request that matches no route (a webhook handled entirely in `middleware.ts`, or a path about to 404) gets 2 then 3.

### The default

3.1 ships no default cap. 4.0 defaults to 1 MiB.

A default cap in a minor is a behaviour change with no non-breaking reading: `examples/indie-blog` accepts 10 MiB photos (`lib/media.ts`, `MAX_PHOTO_BYTES`) and the file-uploads recipe teaches streaming large files to disk, so any default tight enough to mean something refuses requests that work today. The pairing policy has a clean split here. The mechanism, both keys and the 413 are additive and ship now. The default is the cutover and is recorded for 4.0.

What makes the wait honest is the warning. In 3.x, with no limit resolved for a request, the same counter that would enforce a limit measures the body, and the first one over 1 MiB on a given route logs once per process:

```
stator: POST /admin/publish received a 6291456-byte body and no limit is set. 4.0 will refuse
bodies over 1048576 bytes by default. Set maxBodyBytes on this route's defineApiRoute, or
requests.maxBodyBytes in stator.config.ts.
```

Only the apps the cutover would break hear about it, on the route it would break, with the fix. An app that sets either key (including `Infinity`) never sees it.

1 MiB for 4.0 because the per-route override makes a tight default livable: JSON and form posts are far under it, and an upload route is exactly where an author should state a number. For comparison, from memory and not re-verified for this spec: SvelteKit's adapter-node defaults `BODY_SIZE_LIMIT` to 512 KB, Next.js server actions default `bodySizeLimit` to 1 MB, nginx defaults `client_max_body_size` to 1 MB. Stator would sit with them.

Docs and examples set the keys from 3.1 on, so new apps are capped on day one and the examples are ready for the cutover: the file-uploads recipe's avatar route gains `maxBodyBytes`, and `examples/indie-blog/routes/admin/publish.ts` gains the 12 MiB shown above.

### Enforcement

One piece of framework plumbing in a new `packages/stator/src/server/body-limit.ts`, registered in `buildHonoApp` (`server/http.ts`) after the cross-site guard and before the app's own middleware, so a body read in `middleware.ts` is counted too and a cross-site write is still refused as a 403 first. It runs with or without the security defaults.

Per request:

1. `GET`, `HEAD`, and `POST /__events` pass straight through. So does a request with no body.
2. Resolve the limit: `matchPath(matchers, c.req.path)`, then the definition under the request's method, then the config value. The matcher list is the one dispatch uses; `matchers` moves above the middleware block.
3. **Declared length.** `Content-Length` over the limit is refused now: 413, no session established (`runApiRoute` is what calls `getOrCreateSessionId`, and it never runs), no body read. The unread body is `@hono/node-server`'s to clear: 1.19.17 drains up to 64 MiB or 500 ms after the response and then destroys the socket (`autoCleanupIncoming`, on by default, which neither `create-app.ts` nor `dev-native.ts` turns off).
4. **Counted length.** Otherwise the body is piped through a counting `TransformStream` and the request is replaced, the way Hono's own middleware replaces it: `c.req.raw = new Request(raw, { body: counted, duplex: 'half' })`. `buildRouteRequest` reads `c.req.raw` when the route runs, so `request.formData()`, `request.json()`, `request.text()`, `request.arrayBuffer()`, `request.raw` and Hono's `c.req.*` in middleware all read the counted stream. When the count passes the limit the stream errors with `BodyTooLargeError` and a flag is set on the request.
5. After `next()`, a set flag replaces whatever response exists with the 413. This is what makes the outcome independent of the handler: a handler that lets `formData()` reject, one that catches it and returns a 400, and one that returns its own `Response` all end as 413.

Counting runs even when `Content-Length` is present and under the limit. Node's parser will not deliver more than the declared length, so under `stator start` the count can only agree; it is there so the limit does not depend on the adapter, which is the stance `readCapped` takes for `/__events`.

Steps 3 to 5 were run as a prototype against Hono 4.13.13 and `@hono/node-server` 1.19.17 with a real socket: a chunked body over the limit ends as 413 whether the handler throws, catches, or reads through `c.req.text()`; a declared body over the limit is 413 without the handler running; a handler that ignores a chunked body answers normally.

**What the handler sees.** The read it awaited rejects with a `BodyTooLargeError` (`name: 'BodyTooLargeError'`, `limit: number`), exported from `@statorjs/stator/server`. Most handlers do nothing about it. `runApiRoute`'s catch (`server/api-route.ts`) recognises the error and returns without logging "api route handler threw", since the middleware has already logged the refusal and will set the response. A handler that streams to disk (`pipeline(Readable.fromWeb(file.stream()), …)` from the recipe) gets the rejection mid-write and owns its partial file, as it already does for a client that disconnects.

**Read lazily, or not at all.** Nothing is counted until something reads, so a route that never touches the body never trips the counter; only step 3 can refuse it. Anything the handler did before reading (a dispatch, a claims write) has happened by the time a chunked body overflows. The docs say to read the body first, which is what every example already does.

**The response.** `413` with `{ "error": "request body exceeds 1048576 bytes" }`, the shape `/__events` uses. It is assigned as a fresh response so headers and cookies the handler set do not ride along. The client is told the number, not the config key. The log line carries the rest, at `warn`:

```
stator: POST /admin/publish refused: body exceeds 1048576 bytes (requests.maxBodyBytes). Raise it
in stator.config.ts, or set maxBodyBytes on this route's defineApiRoute.
```

with `(maxBodyBytes on routes/admin/publish.ts)` in place of the config key when the route set the limit.

**Multipart.** One limit over the whole request. `formData()` holds every part in memory, so the request total is the number that bounds the heap; a per-file limit would be a second, smaller number inside the first, and the handler already has it (`file.size`, as the recipe shows). The limit should be the largest file plus the form around it.

**Proxies.** The count is of body bytes as Node delivers them: after chunked decoding, before any `Content-Encoding` the handler might undo itself. A proxy in front applies its own limit first and answers with its own page, so the effective limit is the smaller of the two; the production guide says to set the proxy's at or above the app's. A buffering proxy turns chunked uploads into declared ones, which moves refusals from step 4 to step 3 and changes nothing else. `X-Forwarded-*` plays no part.

### Wiring

`HttpConfig` gains `maxBodyBytes?: number` (the resolved project value, undefined when unset). `CreateAppConfig` (`server/create-app.ts`) and `DevAppConfig` (`server/dev.ts`) gain `requests?: { maxBodyBytes?: number }` and pass `config.requests?.maxBodyBytes` down, beside `eventMaxBytes` in `create-app.ts` and `dev-native.ts`. `cli/commands/start.ts` and `cli/commands/dev.ts` pass `requests: config.requests`.

`cli/commands/dev.ts` does not pass `config.events` today, so `events.gate` and `events.maxBytes` from `stator.config.ts` are ignored under `stator dev` (`start.ts` passes them). That is a bug of its own; the one-line fix lands with this wiring unless the `/__events` work gets there first.

## Alternatives Considered

- **A default cap in 3.1.** Closes the hole for every app on upgrade, which is the argument for it, and a security fix is the usual excuse for a breaking minor. Against: nothing is being exploited that a proxy limit does not already stop, 3.0 left this open on purpose, and the failure is a production upload that starts returning 413 after a minor bump. A generous default (say 16 MiB) breaks fewer apps and protects almost nothing: 16 MiB times a few dozen concurrent requests is still the heap.
- **No default ever, key only.** Never breaks anyone and leaves the safe posture as something each app has to find. The 4.0 default is the point of adding the key.
- **Warn at boot when the key is unset.** Every app sees it on every start, including the ones with no upload route and nothing to fix. The measured warning reaches only the routes that would break.
- **Hono's `bodyLimit` middleware.** In 4.13.13 it trusts `Content-Length` when present and, when absent, reads the whole body into an array of chunks before the handler runs (`hono/dist/middleware/body-limit/index.js`). That buffers every chunked upload in memory, which undoes the recipe's streaming path, and it has no per-route resolution.
- **Enforce inside `RouteRequest`'s read methods.** Smaller, but `request.raw` and app middleware would bypass it, and those are the two places nobody would think to look.
- **Per-file and per-field multipart limits.** Needs a streaming multipart parser in place of `Request.formData()`. A real feature with its own surface; the request total covers the memory risk.
- **A `body: { maxBytes }` group on both config and route.** Matches `events.maxBytes` leaf for leaf. Costs a nested object on every upload route for one number, and `requests` is the better home for the next request-level policy.
- **`false` for "no limit".** `caching: false` is the precedent, but there `false` removes a block. Here the type stays `number` and `Infinity` means what it says.

## Not in 3.1

The key name (`requests.maxBodyBytes`, `maxBodyBytes` on the route) and the 4.0 default (1 MiB) are settled; see the decision record below. Three things were left out on purpose:

- **A read timeout.** A limit on size does nothing about a body that arrives one byte a second. `requests.bodyTimeoutMs` is the natural sibling. Unscheduled.
- **A `stator check` lint.** A static pass could flag a route that calls `request.formData()` with no `maxBodyBytes`. Cheap to add later, noisy if wrong; the runtime warning covers it for now.
- **Folding `readCapped` into `body-limit.ts`.** The `/__events` reader could become "apply the limit, then `text()`". Held back so this change did not edit the `/__events` handler while other 3.1 work is in it; it can follow once refusal reasons has merged.

## Implementation Notes

Two PRs. PR 1 depends on [[defineapiroute-takes-any-http-method]] having landed (both edit the same interfaces and the same object literal in `routing.ts`).

**PR 1 — the limit (M).** Changeset: minor. "Request bodies can be capped: `requests.maxBodyBytes` in `stator.config.ts` sets a limit for every API route and anything middleware reads, and `maxBodyBytes` on `defineApiRoute` overrides it per route. A body over its limit is refused with a 413. No limit applies unless one is set; a body over 1 MiB on a route with none logs a warning, because 4.0 will default to 1 MiB."

- New `packages/stator/src/server/body-limit.ts`: `BodyTooLargeError`, the middleware factory (takes the matcher lookup and the project value), the once-per-route warning set, the 413 builder.
- `packages/stator/src/server/http.ts`: `HttpConfig.maxBodyBytes`; hoist `matchers` above the middleware block; one `app.use('*', …)` between the cross-site guard and the app handlers. Nothing in the `/__events`, `/__sse` or GET dispatch handlers.
- `packages/stator/src/server/routing.ts`: `maxBodyBytes?` on `DefineApiRouteConfig` and `ApiRouteDefinition`; validation and copy in `defineApiRoute`.
- `packages/stator/src/server/api-route.ts`: the handler catch recognises `BodyTooLargeError`.
- `packages/stator/src/config.ts`, `server/create-app.ts`, `server/dev.ts`, `server/dev-native.ts`, `cli/commands/start.ts`, `cli/commands/dev.ts`: the `requests` group and its threading (and `events` in `dev.ts`, see Wiring).
- `packages/stator/src/server/index.ts`: export `BodyTooLargeError`.
- Tests, new `packages/stator/tests/body-limit.test.ts` with routes under `tests/fixtures/body-limit/`:
  - declared over the limit → 413, handler not called, no `Set-Cookie`;
  - chunked over the limit → 413 when the handler lets the read throw, when it catches and returns 400, and when it returns its own `Response`; the handler's headers are not on the 413;
  - under the limit → the handler's response, body intact, for `formData()`, `json()`, `text()`, `arrayBuffer()` and `request.raw`;
  - a route `maxBodyBytes` above the project value admits, one below it refuses, and `POST` and `PUT` on one URL keep separate limits;
  - `Infinity` on a route under a finite project value admits;
  - a body read in `middleware.ts` is counted, with the route's limit when a route matches and the project's when none does;
  - a handler that ignores a chunked oversize body answers normally;
  - `/__events` is still governed by `events.maxBytes` alone;
  - nothing set: a 2 MiB body is accepted and warns once for two requests to the same route; with either key set, no warning;
  - `defineApiRoute({ maxBodyBytes: 0 })`, `-1`, `NaN` throw; `method: 'GET'` with `maxBodyBytes` is a type error (`tests/api-route-method-typing.test-d.ts`);
  - one test over a real socket (`serve` on port 0, `node:http` client writing chunks) for the declared and chunked refusals, since `app.fetch` never exercises the adapter's cleanup.
- `packages/stator/tests/security-regressions.test.ts`: untouched; its `/__events` cases double as the "events cap is separate" regression.

**PR 2 — docs and examples (S).** No changeset (docs and examples are ignored packages) unless folded into PR 1.

- `apps/docs/src/content/docs/reference/config.md`: the `requests` group beside `events`.
- `apps/docs/src/content/docs/reference/server.md`: `maxBodyBytes?` on `DefineApiRouteConfig`; `BodyTooLargeError`.
- `apps/docs/src/content/docs/guides/api-routes.md`: a short "Body size" section (the two keys, the 413, read the body first).
- `apps/docs/src/content/docs/recipes/file-uploads.md`: `maxBodyBytes` on the avatar route; the "size limit at the edge" bullet becomes "keep the proxy's limit at or above the app's"; a line in the streaming section that the limit applies to streamed bodies and the handler cleans up its partial file.
- `apps/docs/src/content/docs/recipes/receiving-webhooks.md`: one sentence, a webhook route is a good place for a small `maxBodyBytes`.
- `apps/docs/src/content/docs/guides/production.md`: proxy limits and the 4.0 default.
- `examples/indie-blog/routes/admin/publish.ts`: `maxBodyBytes: 12 * 1024 * 1024`; a test in `examples/indie-blog/tests/photos.test.ts` that a 10 MiB photo still publishes.

**For the 4.0 ledger** (`ROADMAP.md`, Surface hygiene, "Parked for the next major"; not edited by this spec): *The default request body limit. 3.1 shipped `requests.maxBodyBytes` and the per-route `maxBodyBytes` with no default and a warning over 1 MiB. 4.0 sets the default to 1048576 and drops the warning.*

## Decision record (2026-11-22, Tony)

- No default limit in 3.1, with the once-per-route warning over 1 MiB; a 1 MiB default at 4.0. Accepted on the basis that 4.0 is now planned (it is the release that requires schemas for wire-crossing events), so the default is not far behind.
- Accepted as recommended: `requests.maxBodyBytes` with `maxBodyBytes` on the route; one whole-request limit for multipart; the limit applies with or without the security defaults (`Infinity` opts out); `BodyTooLargeError` is exported from `/server`.
