---
title: Gated routes and redirects
description: "Protect a page, send someone to login, and come back after — the patterns from with-auth, distilled."
sidebar:
  order: 2
---

The [authentication recipe](/recipes/authentication/) gets people signed in. This one answers the next question: **how do I protect a page?** — plus the redirect idioms that go with it. Everything here is lifted from the [`with-auth` example](https://github.com/statorjs/stator/tree/main/examples/with-auth) (`pnpm create stator my-app --template with-auth`).

## Gate a page: honest status, deliberate arms

The default shape — used by with-auth's `/profile` — is a frontmatter guard plus explicit `when()` arms:

```astro
---
import AuthMachine from '../machines/auth.ts'

const [auth] = Stator.reads([AuthMachine])
if (!auth.isAuthenticated) Stator.response.status = 401
---
{when(read(auth, (a) => !a.isAuthenticated), () => (
  <p>You're not signed in — <a href="/login">sign in</a> first.</p>
))}
{when(read(auth, (a) => a.isAuthenticated), () => (
  <section>{/* the real page */}</section>
))}
```

Three things this shape gets right:

- **The status is honest.** The frontmatter runs on the server, so the response is a real `401` — crawlers, monitoring, and `curl` see the truth, not a 200 with a sad paragraph in it.
- **The signed-out view is deliberate.** An inactive `when()` arm renders *nothing* — the protected markup isn't hidden in the HTML, it was never sent. Private content stays server-side by construction.
- **Both arms are declared.** The signed-out experience is designed, not an accident of missing data.

## Redirect from a page

When a page is meaningless without identity (a settings form, a dashboard), send the visitor to login instead of describing it:

```astro
---
const [auth] = Stator.reads([AuthMachine])
if (!auth.isAuthenticated) {
  Stator.response.status = 302
  Stator.response.headers.set('Location', '/login')
}
---
```

One caveat, and it matters: **the template still renders.** A redirect status doesn't stop the render pass — the browser ignores the body of a 3xx, but the body is still produced. So the template must stay renderable when signed out, and anything private stays inside an `isAuthenticated` arm regardless of the redirect. When in doubt, prefer the 401-plus-prompt shape above; redirect when there is genuinely nothing to show.

## Redirect from an API route

Form-shaped flows (login, logout, create-and-view) redirect from the [API route](/guides/api-routes/) that handled the POST, with a `navigate` directive:

```ts
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch, rotateSession }) => {
    const form = await request.formData()
    const { committed } = await dispatch(AuthMachine, {
      type: 'LOGIN',
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    })
    if (!committed) {
      return { directives: [{ type: 'navigate', to: '/login?error=bad-credentials' }] }
    }
    rotateSession()
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
```

The directive adapts to the caller: an enhanced submit gets a client-side navigation, and a raw browser form POST gets an HTTP-native **303 + Location** — post/redirect/get for free, no double-submit on refresh. (A `reload` directive becomes a 303 back to the referer, and unsafe `to:` URLs are coerced to `/`.) The `?error=bad-credentials` query is the companion idiom: the login page reads it and renders a friendly banner, so a guard drop round-trips into UI without any client code.

## Come back after login

Carry the destination through the flow as a query parameter — it composes from the two idioms above:

```astro
---
if (!auth.isAuthenticated) {
  const here = new URL(Stator.request.url).pathname
  Stator.response.status = 302
  Stator.response.headers.set('Location', `/login?next=${encodeURIComponent(here)}`)
}
---
```

The login form echoes `next` in a hidden field, and the login API route navigates to it on success — validating it's a same-site path first (`next.startsWith('/')`, no `//`), never a full URL, so the login flow can't be used as an open redirect.

## Role-gating

Same shapes, different selector. With-auth's admin role gates like this:

```astro
if (!auth.isHarbormaster) Stator.response.status = 403
```

:::caution[Page gating is presentation, not security]
The page guard controls what renders; it is not the permission model. Enforcement lives on the machines — [authorization is guards](/recipes/authentication/#authorization-is-guards), and a role-guarded transition drops a forbidden event no matter what page it was sent from. A hidden button is UX; the guard is the law.
:::

## Section-wide gating

There is no route middleware yet — gating `/admin/**` in one place is on the radar, but today each page in a section carries its own guard line. The repetition is one line per page, and the enforcement doesn't live there anyway (see the caution above), so the cost is cosmetic. If you're building a large gated section, a shared layout component can own the signed-out arm so each page only repeats the status line.
