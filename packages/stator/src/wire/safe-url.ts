/**
 * URL-scheme safety — shared by the client directive applier (`wire/apply.ts`)
 * and the server render/redirect paths (`template/html.ts`,
 * `server/recompute.ts`, `server/api-route.ts`). One implementation so the two
 * planes can't drift on what counts as a dangerous URL.
 *
 * The framework does no URL-scheme validation otherwise, so a user-controlled
 * `href`/`src` or navigation target can carry `javascript:` (script execution)
 * or an off-site/`data:` document. These helpers reject the never-legitimate
 * schemes while leaving ordinary relative and `http(s)`/`mailto:`/`tel:` URLs —
 * and, for attributes, `data:` images — untouched.
 */

/** Normalize for the scheme check ONLY (we still render the original value).
 *  Browsers ignore leading control chars/whitespace and strip TAB/LF/CR from
 *  within a scheme, so `\x01java\tscript:` must be caught. The `^` anchor in
 *  the callers means removing interior whitespace can't create a false match on
 *  a legitimate `http(s)` URL. Strips ASCII space/controls (<= 0x20) and C1
 *  controls (0x7f–0x9f) without embedding a control-char regex literal. */
function stripForSchemeCheck(url: string): string {
  let out = ''
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i)
    if (code > 0x20 && !(code >= 0x7f && code <= 0x9f)) out += url[i]
  }
  return out
}

/** Script-executing schemes — never legitimate in any attribute or navigation. */
const SCRIPT_SCHEME = /^(?:javascript|vbscript):/i
/** Adds `data:` — dangerous as a navigation target (renders as a document),
 *  but allowed in resource attributes like `img src` (data-URI images). */
const NAV_SCHEME = /^(?:javascript|vbscript|data):/i

/** Safe as a navigation target (`location.href`, an HTTP redirect)? */
export function isSafeNavigationUrl(url: string): boolean {
  return !NAV_SCHEME.test(stripForSchemeCheck(url))
}

/** Coerce a navigation target: dangerous-scheme URLs collapse to `fallback`. */
export function safeNavigationUrl(url: string, fallback = '/'): string {
  return isSafeNavigationUrl(url) ? url : fallback
}

/**
 * A path on this site, for "send them back where they came from": `target`
 * when it is one, else `fallback`. A value read from a query string, a form
 * field or a cookie is the visitor's to choose, and a redirect to it is only
 * safe when it cannot leave the origin.
 *
 * `target.startsWith('/')` is not that test. `//host` is another origin, and
 * so is `/\host`: browsers read a backslash as a slash. This resolves the
 * value the way a browser would and keeps it only if it stayed put.
 */
export function safeLocalPath(target: string | null | undefined, fallback = '/'): string {
  if (!target) return fallback
  if (target[0] !== '/' || target[1] === '/' || target.includes('\\')) return fallback
  for (let i = 0; i < target.length; i++) {
    const code = target.charCodeAt(i)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return fallback
  }
  const base = 'http://local.invalid'
  try {
    return new URL(target, base).origin === base ? target : fallback
  } catch {
    return fallback
  }
}

/** Attribute names whose values are fetched/navigated as URLs. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'background',
  'cite',
  'ping',
])

export function isUrlAttribute(name: string): boolean {
  return URL_ATTRS.has(name.toLowerCase())
}

/** Sanitize a URL attribute value: strip an ever-illegitimate script scheme
 *  (`javascript:`/`vbscript:`) to an empty value; leave everything else
 *  (relative, http(s), mailto, tel, and `data:` images) intact. */
export function safeAttrUrl(value: string): string {
  return SCRIPT_SCHEME.test(stripForSchemeCheck(value)) ? '' : value
}
