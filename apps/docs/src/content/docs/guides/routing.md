---
title: Routing and pages
description: "File-based .stator pages, path params, and query access."
sidebar:
  order: 6
---

Routes are files under `routes/`. A `.stator` file is a page; a `.ts` file is an [API route](/guides/api-routes/).

## File-based pages

`routes/index.stator` → `/`, `routes/cart.stator` → `/cart`. Discovery is automatic.

## Path params

A `[name]` segment captures into `request.params` (always strings):

```
routes/product/[id].stator   →   /product/p1   →   params.id === "p1"
```

More specific routes win over param routes (`/product/new` beats `/product/[id]`).

## Query and request

Access the request in frontmatter via `Stator.request`:

```astro
---
const { params, query } = Stator.request
---
```

`query` collapses repeated keys to the first value.

## Declare machine reads

`Stator.reads([...])` hands the page live machine instances:

```astro
---
import CartMachine from '../machines/cart.ts'
const [cart] = Stator.reads([CartMachine])
---
```

## Layouts via composition

Wrap pages in a layout component that exposes slots with `<children>`:

```astro
<!-- customer-layout.stator -->
<header><children name="header" /></header>
<main><children /></main>
```

```astro
<CustomerLayout><CartPage cart={cart} /></CustomerLayout>
```

## Response side effects

Set status, headers, or cookies during render via `Stator.response`:

```astro
---
const res = Stator.response
if (!user) res.status = 401
---
```

## Live updates

Add a pragma to opt the route into [SSE](/guides/realtime-sse/):

```astro
---
// @stator live
---
```

## Missing things: the `when()` 404 idiom

Dynamic routes validate their params in the frontmatter and branch — there is
no first-class 404 API in 1.0:

```astro
---
const found = catalog.bySlug(String(params.slug))
---
{when(!found, () => (
  <section>
    <h1>Never stocked that.</h1>
    <p><a href="/">Back to the shop.</a></p>
  </section>
))}
{when(!!found, () => (
  /* the real page */
))}
```

Set a real status code where it matters (crawlers): `Stator.response.status = 404`
in the frontmatter's not-found path.
