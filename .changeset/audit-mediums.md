---
"@statorjs/stator": patch
---

Fixes from the 3.0 security audit.

- **Text with `$` inside a `defer` arm.** The arm was spliced in with a string replacement, so `` $` ``, `$'` and `$&` in rendered text were read as replacement patterns: stored text could duplicate the page's own markup, and 2 KB of it multiplied the response a thousandfold. The text is now inserted as text.
- **Derived `Cache-Control` beside a cookie.** A response the framework marked `public` could also carry a `Set-Cookie` from middleware or a handler, which a cache that stores cookies would replay to other visitors. A response that sets a cookie is no longer marked.
- **Raw `Response` returns.** A handler-built `Response` from an API route, a data route or the image endpoint went out without what the context had gathered: `securityHeaders()` and `cors()` headers were missing, and `rotateSession()` followed by a raw redirect never sent the new session cookie. Those headers and cookies are now merged in; the handler's own headers win.
- **`/__events` body cap.** An event body is limited to 64 KiB, checked while it is read; a larger one is a 413. `events: { maxBytes }` in `stator.config.ts` changes the limit.
- **The anonymous placeholder lock.** A data route that reads no session machine no longer takes a session lock, so one slow request can no longer stall every anonymous visitor's data routes. A session cookie naming a framework scope (`@anonymous`, `@app`) is ignored.
- **`safeLocalPath`.** New export from `@statorjs/stator/server` for return-after-login redirects. The check the docs used to show, `next.startsWith('/')` without `//`, let through `/\host`, which browsers resolve to another site.
