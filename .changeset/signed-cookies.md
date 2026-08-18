---
"@statorjs/stator": minor
---

Signed cookies — the sealed short-lived-state primitive. The cookie jar (`stator(c).cookies` / `ctx.cookies`) gains `setSigned`/`getSigned`, adding a tamper-evident signature over a cookie value using an app secret:

```ts
await cookies.setSigned('oauth_state', state, { httpOnly: true, maxAge: 600 })
const state = await cookies.getSigned('oauth_state') // string | undefined
```

This is the substrate for auth flows that hand short-lived state to the browser and must trust it on the way back without server-side storage: the OAuth `state`/PKCE handshake, a magic-link token, a WebAuthn challenge.

- **Secret:** new top-level `secret` in config, falling back to `process.env.STATOR_SECRET` (loadable via `.env`). Use a long random string, kept out of source.
- **`getSigned` returns `undefined`** for a missing *or* invalid signature — a tampered value, or one signed with a since-rotated secret, is never trusted (no `false` to handle, no leak of the distinction).
- **No secret configured → a clear throw** at call time (not a silent weak signature).
- Signing is tamper-*evidence*, not encryption — the value stays client-readable, so seal a nonce, not a secret. Server-stored state keyed by an opaque cookie id remains the env-free alternative.

Continues the 2.3 session-identity thread (auth primitives, part 2). Bundles into 2.4.0 with `.env` loading.
