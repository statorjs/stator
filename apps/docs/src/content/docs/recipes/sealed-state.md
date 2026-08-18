---
title: Signed cookies & sealed state
description: "Hand short-lived state to the browser and trust it when it comes back — the OAuth state/PKCE handshake, a magic-link token, a WebAuthn challenge — with a signed cookie instead of server storage."
sidebar:
  order: 9
---

Some flows need to park a small piece of state in the browser and trust it on the way back — without a database row for every in-flight attempt. The OAuth `state` parameter (CSRF for the provider handshake), a PKCE verifier, a magic-link token, a WebAuthn challenge: you mint it, hand it to the client, and when the client returns it you need to know *you* minted it and no one tampered with it.

A plain cookie can't do that — anyone can set or edit it. A **signed cookie** can: it carries a tamper-evident signature over the value, keyed by an app secret. The client can still read the value (signing is not encryption), but it can't forge one that verifies.

## The secret

Signed cookies need a signing key. Set `secret` in `stator.config.ts`, or `STATOR_SECRET` in the environment (loaded from [`.env` / `.env.local`](/guides/production/)):

```ts
// stator.config.ts
export default defineConfig({
  secret: process.env.STATOR_SECRET, // a long random string, kept out of source
})
```

Calling a signed-cookie method with no secret configured throws a clear error — you find out at the first call, not via a silently weak signature.

## The pattern: seal before the redirect, verify on the callback

The OAuth `state` handshake is the canonical shape. Two handlers, one signed cookie:

```ts
// routes/auth/oauth-start.ts — mint state, seal it, redirect to the provider
import { randomBytes } from 'node:crypto'
import { defineApiRoute } from '@statorjs/stator/server'

export const POST = defineApiRoute({
  reads: [],
  handler: async (_request, { cookies }) => {
    const state = randomBytes(16).toString('hex')
    await cookies.setSigned('oauth_state', state, { httpOnly: true, path: '/', maxAge: 600 })
    const url = `https://provider.example/authorize?client_id=…&state=${state}`
    return { directives: [{ type: 'navigate', to: url }] }
  },
})
```

```ts
// routes/auth/oauth-callback.ts — the provider redirects back with ?state=…
import { defineApiRoute } from '@statorjs/stator/server'

export const GET = defineApiRoute({
  reads: [],
  handler: async (request, { cookies }) => {
    const expected = await cookies.getSigned('oauth_state') // undefined if absent OR tampered
    cookies.delete('oauth_state', { path: '/' }) // single-use — clear it either way
    if (!expected || request.query.state !== expected) {
      return { directives: [{ type: 'navigate', to: '/login?error=bad-state' }] }
    }
    // state verified — now exchange the code, load the user, establish the session.
    // …
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
```

`getSigned` returns `undefined` for a missing cookie *and* for one whose signature doesn't verify — a tampered value, or one signed with a secret you've since rotated. You never see a "present but invalid" case to handle, and you never trust a value you shouldn't. That makes the guard above a plain truthiness check.

## Seal a nonce, not a secret

Signing is tamper-*evidence*, not encryption — the value stays readable by the client. So put a random nonce in the cookie and keep the sensitive mapping server-side, rather than sealing sensitive data directly. The OAuth `state` above is exactly this: a random token whose only job is to match on return. A magic-link or WebAuthn flow is the same shape — seal a random challenge, look up what it maps to when it comes back.

## When you don't need a secret at all

Sealing is a convenience, not a requirement. The env-free alternative is **server-stored state**: write the short-lived value to your `Store` (or an app machine) under an opaque random id, put only that id in a plain cookie, and look it up on return. That trades a signing secret for a storage write — pick sealing when you'd rather not manage state server-side, storage when you'd rather not manage a secret.

This pattern is the framework side of third-party auth: Stator gives you `sid`, [claims, and session lifecycle](/recipes/authentication/) plus sealed state, and your auth library owns the provider, token exchange, and user store.
