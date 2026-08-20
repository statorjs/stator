---
title: API routes and request response surface
status: shipped
created: 2026-05-21
updated: 2026-06-17
area: runtime
---

## What and Why

The framework's current route primitive (`defineRoute`) is shaped exclusively for GET-style page rendering. It exposes machine state, returns `HtmlFragment`, and doesn't surface most of what's in the underlying HTTP request. Building anything mutation-shaped (form submission, RESTful endpoints, webhooks, third-party callbacks) immediately runs out of road.

The poll demo's "create poll" form is the smallest concrete example. There's no path for a standard `<form action="/new" method="POST">` to dispatch a state machine event, so the demo carries a custom inline `<script>` that intercepts the form, constructs an event descriptor, and POSTs to `/__events`. Works, but it tied the form to a single machine event (which is wrong as a default), broke no-JS submission, and forced every form to ship custom JS.

Three gaps surfaced from one feature:

1. **No way to write mutation-shaped HTTP handlers.** GET routes can't mutate, POST handlers aren't wired into the framework at all.
2. **The request arg is too thin.** Today's `{ params, query }` synthesis drops headers, method, URL, body, and cookies on the floor. Real apps need all of those.
3. **There's no way to influence the response.** Status codes, custom headers, cookies, redirects. The framework owns the response synthesis with no user hooks.

This spec covers all three because they're the same shape of problem and the design for each affects the others.

The deeper why: Stator's whole pitch rests on "explicit declarations enforce architectural commitments." That requires the API surface to make the right shape obvious. Conflating GET (read-only page render) with POST (mutation handler) in one primitive would mean either GET routes can mutate (architecturally wrong) or the type system doesn't enforce the distinction (a missed opportunity). Two primitives encode the intent.

## Success Criteria

- A second route primitive (`defineApiRoute`) exists for POST/PUT/PATCH/DELETE handlers, distinct from `defineRoute`.
- `defineRoute` stays read-only. No `dispatch` helper in its render context. The type system prevents calling it.
- `defineApiRoute` handlers receive a real `Request` object (Web Platform standard) and can read body, headers, cookies, method, URL via the standard API.
- `defineApiRoute` handlers can dispatch machine events via a `dispatch` helper in the context arg.
- `defineApiRoute` handlers can return either a real `Response` or the framework's directives envelope (`{ patches?, directives? }`).
- `defineRoute` render functions can influence the response (status, headers, cookies) via a `response` side-effect object on the render context, without changing the return type.
- File-export convention extends naturally. A single route file can export `GET = defineRoute(...)` and `POST = defineApiRoute(...)`. Discovery finds both, registers both.
- Forms submitted without JS work end-to-end. A `<form action="/new" method="POST">` from a no-JS browser receives a 303 + `Location` when the handler returns a `navigate` directive.
- Forms submitted with the client runtime work. The runtime intercepts submit, POSTs as FormData, receives the JSON envelope, applies patches and directives.

## Constraints

- No convention-based RPC. The framework does not auto-map form field names to machine event payload fields, does not generate endpoint URLs from machine event names, does not auto-bind form fields to function arguments. Handlers are explicit code.
- The request arg uses the Web Platform's `Request` API where it fits. `request.headers.get('...')`, `request.formData()`, `request.json()`, `request.method`, `request.url`. We do not invent parallel APIs for things the platform already has.
- Path params and query strings are exposed alongside the Request (as `request.params` and `request.query`) because parsing them yourself is annoying and we already do the work during route matching. The underlying Request is also accessible (likely as `request.raw`) for escape hatches.
- The response side-effect object on `defineRoute` mirrors the Web Platform's Response shape where it fits: `response.headers` is a real `Headers` instance, `response.status` is a settable number property. The exception is cookies, which get a focused `response.cookies.set(name, value, options)` helper because the cookie attribute model (`Path`, `HttpOnly`, `SameSite`, `Max-Age`, signing) is enough of its own thing to deserve its own API.
- `live: true` stays only on `defineRoute`. SSE-on-an-API-route makes no sense (mutations are one-shot; there's nothing to subscribe to after the handler returns).
- The framework continues to own the session cookie (`stator_sid`). Users setting cookies through `response.cookies.set` get their own cookies in the response alongside the framework's session cookie.

## Approach

### `defineRoute` (unchanged primary purpose, gains response side-effect surface)

```ts
defineRoute({
  reads: [VoterMachine],
  live?: boolean,
  render: ({ VoterMachine, response }, request) => {
    response.status = 404
    response.headers.set('Cache-Control', 'no-store')
    response.cookies.set('preference', 'dark', { httpOnly: true })
    return layout(notFoundPage())
  },
})
```

The render context (first arg) gains a `response` field of type:

```ts
interface RouteResponseContext {
  status: number             // settable, default 200
  headers: Headers           // mutable Web-standard Headers instance
  cookies: {
    set(name: string, value: string, options?: CookieOptions): void
    delete(name: string): void
  }
}
```

The render function still returns `HtmlFragment`. The framework synthesizes the final HTTP response by combining the rendered HTML with whatever side effects the handler wrote to `response`.

### `defineApiRoute` (new primitive)

```ts
defineApiRoute({
  reads?: MachineDef[],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const question = String(form.get('question') ?? '').trim()
    const options = form.getAll('option').map(String).filter(Boolean)

    if (!question || options.length < 2) {
      return new Response('invalid', { status: 400 })
    }

    await dispatch('VoterMachine', { type: 'CREATE_POLL', question, options })
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
```

Return type:

```ts
type ApiRouteResult =
  | Response                                             // raw escape hatch
  | { patches?: Patch[]; directives?: Directive[] }      // typed envelope
```

The handler receives:

- `request` — a `Request`-shaped object. Standard Web API plus `params` and `query` convenience fields. The raw `Request` is reachable for things our wrapper doesn't expose directly.
- A helpers object with at minimum `dispatch(machineName, event)` for invoking machine events.

`dispatch` is the same path the framework uses internally for `/__events`. It loads the target machine if not already loaded, processes the event under the dispatch context, persists touched machines, fires cross-machine subscriptions, captures patches for the response envelope.

### Request shape (both primitives)

```ts
interface RouteRequest {
  raw: Request              // the real Request
  params: Record<string, string>
  query: Record<string, string | undefined>
  // delegate the rest to raw via getters or proxying
  readonly method: string
  readonly url: string
  readonly headers: Headers
  formData(): Promise<FormData>
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}
```

Same shape on `defineRoute` and `defineApiRoute`. GETs ignore body access; API routes use it.

### Response synthesis from directives envelope

For API routes that return `{ patches?, directives? }`:

- Client-runtime requests (`Accept: application/json`) get the JSON envelope verbatim.
- HTML clients (`Accept: text/html` or unspecified, typical for raw browser form POSTs) get an HTTP-native equivalent. The first `navigate` directive becomes a 303 + `Location`. Absent directives, the framework re-renders the page the form came from. Patches are not applicable to HTML clients.

### File discovery

`routes/new.ts` can export any of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Each export is either a `defineRoute` (GET only) or a `defineApiRoute` (the rest). Discovery and registration extends to all of these in the same recursive walk that already handles `[id]` params.

### Client runtime changes

After applying patches, run `applyDirectives(data.directives ?? [])`. New `stator:directive-applied` event fires per directive (mirrors `stator:patch-applied`). Submit handling already exists in the client runtime; for forms whose action is not `/__events`, the handler builds FormData, POSTs to the form's action, and processes the response identically to an /__events response.

## Alternatives Considered

- **One primitive (`defineRoute`) handling both GET and POST**, widened return type. Rejected because conflating the two primitives lets GET handlers call `dispatch`, undermining the architectural "GETs are read-only" guarantee. The type system enforcement is worth the second primitive.
- **Unify on `/__events` for forms** (forms POST with `__machine` and `__type` hidden fields). Considered to keep "one path for events." Rejected because forms aren't tied to single machine events. A form may dispatch to multiple machines, call external services, do work outside the event protocol. Forcing every form into the event shape forecloses that.
- **Custom HTTP response headers** (HTMX-style `HX-Redirect`). Considered for the navigate case. Rejected because our protocol owns a JSON envelope; sideband headers split the response between body and headers, easier for consumers to miss. Covered in detail in the response-directives spec.
- **Module-level `cookies()` / `headers()` imports** (Next.js App Router). Rejected because Stator's existing philosophy is explicit context, no hidden globals. AsyncLocalStorage-backed module functions work but surprise on testing and tie shared code to the framework's runtime.
- **Mutable `Astro.response`** (full Web Response object on the context). Considered. Picked a hybrid: standard `Headers` for headers, native `status` property, focused helper for cookies. Cookies are weird enough (`SameSite`, `HttpOnly`, signing) to deserve their own API rather than being managed via the raw `Set-Cookie` header.

## Open Questions

- Cookie signing. Today the framework's session cookie is unsigned (just a UUID, not a security boundary). User cookies via `response.cookies.set(...)` might want to be signable. Defer: ship unsigned for the first cut, add signing as an option later.
- File uploads via `formData()`. Standard Web API supports them; the framework just needs to not get in the way. Probably falls out for free; worth a test.
- `defineRoute` and `defineApiRoute` returning different envelope shapes for the live SSE case. SSE is GET-only today, so this doesn't come up. Document as a non-issue rather than a deferred decision.
- Streaming responses (long-lived bodies that aren't SSE). API route handler returning a streaming `Response` should work because we're handing the framework a real `Response`. Worth verifying.
- How the handler accesses other utilities (logger, store, current session id). Probably extend the helpers arg over time, but ship MVP with just `dispatch`. Don't pre-build surface for things nobody's asked for.

## Implementation Notes

**Shipped** (commit "Add poll demo, path params, defineApiRoute, response directives + side-effect surface"). `defineApiRoute({ reads, handler })` lives in `routing.ts`; `runApiRoute` in `api-route.ts` executes it. The handler receives the full `RouteRequest` (see [[route-request-context-with-path-params-and-query]]) plus `ApiRouteHelpers` with `dispatch`, and returns an `ApiRouteResult` (`{ patches?, directives? }`). Dogfooded by `apps/poll/routes/new.ts` (`POST = defineApiRoute(...)`), which validates the form, `dispatch`es `CREATE_POLL` to `VoterMachine`, and returns a `navigate` directive. (That `dispatch('VoterMachine', ...)` call is the magic-string smell now addressed by [[typed-events-and-machine-mediated-dispatch]].)