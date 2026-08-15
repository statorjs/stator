/**
 * Match an incoming `Origin` against an allowlist of patterns — shared by the
 * cross-site write guard (`trustedOrigins`) and `cors()`. Patterns are origins
 * with a scheme, either exact (`https://app.example.com`) or wildcard-subdomain
 * (`https://*.example.com`).
 *
 * Boundary-safe by construction: `https://*.example.com` matches `app.example.com`
 * and `a.b.example.com` (any depth), and NEVER `example.com.evil.com` (suffix
 * attack), `evilexample.com` (no label boundary), or the apex `example.com` (list
 * it explicitly if wanted). Scheme must match; port matches when the pattern omits
 * one, else must be equal. Malformed origins and patterns fail closed (no match).
 */
export function matchOrigin(
  origin: string | undefined | null,
  patterns: readonly string[],
): boolean {
  if (!origin) return false
  let incoming: URL
  try {
    incoming = new URL(origin)
  } catch {
    return false
  }
  return patterns.some((pattern) => matchOne(incoming, pattern))
}

/** `scheme://*.rest` — `rest` may carry a `:port`, split off below. */
const WILDCARD = /^([a-z][a-z0-9+.-]*):\/\/\*\.([^/]+)$/i

function matchOne(incoming: URL, pattern: string): boolean {
  const wild = WILDCARD.exec(pattern)
  if (wild) {
    const rawScheme = wild[1]
    const rawRest = wild[2]
    if (rawScheme === undefined || rawRest === undefined) return false
    const scheme = rawScheme.toLowerCase()
    let domain = rawRest.toLowerCase()
    let port = ''
    const colon = domain.lastIndexOf(':')
    if (colon !== -1) {
      port = domain.slice(colon + 1)
      domain = domain.slice(0, colon)
    }
    if (incoming.protocol !== `${scheme}:`) return false
    if (port && incoming.port !== port) return false
    const host = incoming.hostname.toLowerCase()
    // A non-empty subdomain label before `.domain` (any depth), on a label
    // boundary — the leading dot is what defeats the suffix attack.
    return host.length > domain.length + 1 && host.endsWith(`.${domain}`)
  }

  let pat: URL
  try {
    pat = new URL(pattern)
  } catch {
    return false
  }
  if (incoming.protocol !== pat.protocol) return false
  if (incoming.hostname.toLowerCase() !== pat.hostname.toLowerCase()) return false
  // A pattern with no explicit port matches any port; with one, it must be equal.
  if (pat.port && incoming.port !== pat.port) return false
  return true
}
