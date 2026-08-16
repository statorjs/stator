---
"@statorjs/stator": minor
---

Cross-site (CSRF) write protection is now composable and config-tunable. The guard Stator already applied — `Sec-Fetch-Site`/`Origin` on state-changing requests — is exported as `crossSiteGuard()` and applied ahead of route matching, so a cross-site write to an unknown path returns 403 rather than revealing the route with a 404. Two config knobs, both data (no behavior toggles):

- `trustedOrigins` — origins allowed to make cross-site writes despite the guard, exact (`https://app.example.com`) or wildcard-subdomain (`https://*.example.com`). Matching is boundary-safe: `https://*.example.com` matches `app.example.com` and `a.b.example.com`, never `example.com.evil.com` or the apex.
- `sessions.cookie.sameSite: 'Strict'` — the controlled posture. Sets the session cookie `SameSite=Strict` (withheld from every cross-site request) and flips the guard to allowlist-only for same-site writes too, so `trustedOrigins` becomes the whole gate.

Non-breaking: with no config the behavior is exactly as before (same-origin/same-site allowed, cross-site blocked).
