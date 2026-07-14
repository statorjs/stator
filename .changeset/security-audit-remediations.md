---
"@statorjs/stator": patch
---

Security hardening across the server, engine, template, and wire layers. Same-origin apps are unaffected; the behavior changes only reject abusive or unsafe inputs.

- **Engine `@set` is no longer dispatchable from the wire.** The built-in `@set` context-write (which powers client-island `bind:value`) is now honored only by client-island actors; server actors ignore it and `/__events` rejects any reserved `@`-prefixed event with a 400. Previously a client could `@set` arbitrary context on any session machine, bypassing every guard (privilege escalation / identity forgery).
- **Static file serving is contained to its root.** `/static/*` now verifies the resolved path stays under `staticDir`, closing an absolute-path escape (`/static//etc/passwd`) that allowed unauthenticated arbitrary file reads.
- **URL-scheme sanitization.** `href`/`src` and other url-bearing attributes strip `javascript:`/`vbscript:` (both at render and on live diffs; `data:` images preserved); navigation directives and server redirects reject `javascript:`/`vbscript:`/`data:` targets and only bounce back to a same-origin `Referer`.
- **Attribute escaping** now also escapes single quotes (`'`), closing a single-quoted-attribute breakout.
- **CSRF origin check.** Mutating routes (`/__events` and API routes) reject browser requests whose `Sec-Fetch-Site`/`Origin` is cross-site; cookieless server-to-server callers are unaffected.
- **Session-lock timeout.** A hung mutation no longer wedges a session's mutation path indefinitely.
- **`style:list`** reactive property values are cut at the first `;` to prevent CSS declaration injection.
