# rebox migration — paper-cut log

Evidence artifact from migrating reboxcontainer.com (Astro/Decap CMS) onto
Stator, in a separate `aquamarine` monorepo (not an in-tree example — a real
external app build). Format: what happened → what it cost → what would help.
Dated; append as found.

---

## 1. `:global()` silently unscopes the WHOLE selector, not just the wrapped part — RESOLVED (2026-10-01→02)

Porting `src/components/blocks/*.astro` to `.stator` components, a
`div :global(svg) { color: ... }` rule in the Quote block (reaching a
`raw()`-injected icon) compiled to the literal global rule `div svg { ... }`,
turning an unrelated component's icons (Features, `fill="currentColor"`) the
same color as their own background — invisible, no error. Root cause and the
full trail (including a second, related gap found swapping fixture `<img>`
tags for the real `<Image>`/`<Picture>` components, and the `:where()`
specificity fix that followed) are captured in this repo's own history
instead of re-narrated here — see:

- `d589503` Treat `@statorjs/stator` as a `.stator` component library
- `424e658` Per-route, usage-driven scoped CSS for the production build
- `a9077fe` Dogfood scoped styles for real: `<Image>` gets a real style, two gaps close
- `355c839` Fix two correctness bugs the real `<Image>` style surfaced (the `:where()` specificity fix + the comment-aware specifier scanner)
- `.chisel/specs/stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation.md`

Published as `@statorjs/stator@2.11.0-next.1`; `aquamarine/apps/rebox`
verified against the real npm-published package, not just the local checkout.

---

## 2. Frontmatter is parsed as plain `.ts` (no JSX), but the type-checker's virtual file models it as uniform JSX — a real mismatch, not user error (2026-10-04)

Explored whether a `.stator` route's frontmatter could early-`return` a
different render (e.g. `if (!page) return <NotFound/>`) the way Astro
frontmatter can. `stator check` accepted `return <p>...</p>;` inside
frontmatter with zero complaint — TypeScript genuinely narrows across it,
since the type-checking virtual file (`virtual-code.ts`) represents the
whole frontmatter+template as one function body ending in a single JSX
return, so an early return mechanically type-checks fine.

Running it for real crashed `stator dev`: `Transform failed: Expected ")"
but found "return"` at that exact line. The REAL compiler (`compile.ts`'s
`emitRoute`) parses frontmatter as plain `ts.ScriptKind.TS` — no JSX
support at all — and splices it verbatim as statements ahead of the
template's own lowering (which compiles to an `html` tagged-template-literal
call, not JSX/`createElement`, confirmed by reading real `dist/routes/*.ts`
output — deliberate, to avoid a runtime JSX dependency). A bare `<p>` in
that plain-TS parse mode lexes as an old-style angle-bracket type-assertion
cast, not a JSX element, which is why the error reads like a cast gone
wrong, not a JSX error.

Net: the type-checker's model and the real compiler's model disagree on
this specific shape, silently — `stator check` says it's fine, running it
says otherwise. (Separately: returning a real `html\`...\`` tagged template
literal from frontmatter instead of JSX *does* work, mechanically, at
runtime — no parse ambiguity, since it's a plain function call, not bare
`<`. Not a recommended pattern — just confirms the mismatch is specifically
about JSX syntax in frontmatter's parse mode, not about `return` itself.)

Resolution for our case turned out to be architectural, not a workaround:
a route's own 404 already cascades to `routes/404.stator` (the reserved
catch-all filename, ranked last), so no route ever needed to render
different content from its own frontmatter in the first place — confirmed
directly with Tony, who'd designed the cascade for exactly this. The
mismatch above is still real and worth knowing about independent of that;
noting it here in case an early-return-flavored pattern looks tempting
again later, or in case dev/check tooling sharing more real plumbing (Tony's
own framing) is ever worth doing for its own sake.

---

## 3. `button`'s attribute typing doesn't model `formaction`/`formnovalidate` (2026-10-04)

`html-attributes.ts`'s per-element attribute map is explicit about being "a
useful subset, not the whole DOM... grow on demand" — this is exactly that:
building per-block add/remove/reorder actions in the rebox admin, each
needed to be a submit button *inside the main edit form* (not a separate
`<form>`, which would lose whatever else the user had just typed), pointed
at a different action via the button's own `formaction`. Real, standard
HTML, not exotic. `HTMLAttributes<'button'>` has no `formaction` or
`formnovalidate` at all, so the natural JSX attribute fails to typecheck.

Worked around locally with a small typed-spread helper
(`{...({formaction, formnovalidate} as Record<string, unknown>)}`), and
confirmed via the real rendered HTML (not just a clean typecheck) that both
attributes actually reach the output. Not blocking — just the kind of gap
worth growing the map for, since "a button that submits elsewhere" is a
pretty ordinary multi-action-form pattern, not a rebox-specific one.

---

## 4. `child="x"` slot markers are assigned statically — a conditional wrapper silently falls into the default slot (2026-10-04)

Building the rebox admin's read-only version view (and moving M7's preview
banner) onto the public `Layout` with the admin bar *above* the site header,
the natural first write was

    {previewing ? <div child="top"><PreviewBanner /></div> : null}

It compiled, typechecked, and rendered — into the default slot, inside
`<main>`, with no warning. `lower.ts`'s `childRegionOf` only reads the
marker off a direct `JsxElement`/`JsxSelfClosingElement` child of the
component tag; a `JsxExpression` child (any `{...}`) has no attributes to
inspect, so it's bucketed as default content. Cost: one failed ordering
assertion and a trip into the compiler to learn why — cheap, but only
because the test asserted *position*, which nothing else would have caught.

Working shape is the condition *inside* a static slotted element:

    <div child="top">{previewing ? <PreviewBanner /> : null}</div>

which means every public page now carries an empty `<div></div>` at the top
of `<body>` for ordinary visitors. Harmless, but it's markup that exists
only to satisfy the slot mechanism. Two things would help, in order of
cheapness: (a) a compile-time note/warning when a `child="x"` marker
appears anywhere *other* than a direct child (it's never meaningful there,
so it's always a mistake); (b) letting a `child="x"` marker ride on a
component tag (`<PreviewBanner child="top" />`) so the condition can live
in the component and the wrapper disappears — `lowerComponent` already
collects the attr, it just becomes an ignored prop today.

---

## 5. A self-closing non-void element (`<div />`) is emitted verbatim — browsers parse it as an opening tag (2026-10-06)

Porting the product image carousel, the pagination dots were written the
JSX-natural way, `each(images, (_, i) => <div aria-current={...} />)`.
Typecheck and compile were happy; the rendered HTML was literally
`<div data-stator-id="s2:i0:e0" aria-current="true" /><div … />…`. HTML
has no self-closing syntax for non-void elements, so every browser reads
`<div … />` as `<div …>` and nests each following dot inside the previous
one. Symptoms were two steps removed from the cause: only the first dot
visible, and `refs.dots.children` having one child, which made the
"current slide" lookup return -1 and the Next button wrap to slide 0.
Tony caught it in the browser; nothing server-side could have.

Fix on our side was `<div …></div>`. The compiler fix is cheap and
unambiguous: when lowering a `JsxSelfClosingElement` whose tag isn't in
the HTML void set (`area base br col embed hr img input link meta source
track wbr`), emit `<tag …></tag>`. JSX authors universally write `<div />`
for an empty element, and every other JSX-to-HTML renderer closes it for
them, so this will bite anyone coming from React/Astro/Solid.

(Related: `static props` typing for island shells — `Stator.props()` is
refused in an island's fence with a clear message, but the open `props`
the shell receives is `{ [prop: string]: unknown }`, so a rich prop like
`images: Img[]` needs a cast in the fence. A way to declare the shell's
prop type would close that gap; noted here, not a bug.)

---

## 6. `<JsonLd>` HTML-entity-escapes string values — the structured data comes out corrupted (2026-10-06)

Swapping rebox's hand-rolled product JSON-LD for the shipped `<JsonLd>`
component (Tony's call — "more full featured out of the box"), the real
`/products/mobile-office-20` page renders:

    "description":"A 20&apos; mobile office with plug &amp; play utility hookups …"

`safeJsonLdReplacer` in `components/json-ld.ts` maps `& < > " '` to HTML
entities inside every string value. But `<script>` content is raw text to
the HTML parser — entities are never decoded there — so what a consumer
(Google, a validator) parses is the literal text `A 20&apos; mobile office
with plug &amp; play`. Every product description with an apostrophe or an
ampersand ships wrong structured data; the quote-escaping is pure damage
since JSON.stringify already escapes `"`.

What the JSON-LD 1.1 spec actually asks for ("Restrictions for contents of
JSON-LD script elements"): the only thing that matters is that the text
can't close the element, so `<`, `>` and `&` are written as the JSON
escapes `\u003c`, `\u003e`, `\u0026` — which a JSON parser turns back into
the real characters. Quotes need nothing. Fix: drop the replacer, keep
null-stripping if wanted, and post-process the serialized string:

    JSON.stringify(ld, stripNulls, space)
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

Rebox is using the component anyway (the data bug is the framework's to
fix, and the migration isn't live yet), but this one should land before
cutover: the live site's product descriptions contain both characters.

---

## 7. Author attributes on an island's root element are silently dropped (2026-10-07)

The markdown editor island was written as `<markdown-editor data-mode={mode}>`
to drive a compact/full variant through CSS (`[data-mode='full'] .host`)
and tests. It compiled and typechecked; the shell rendered as
`<markdown-editor data-s-2600ae51>` — the authored attribute gone, no
diagnostic. The earlier islands (carousel, picker, gallery) never put an
attribute on their root, so this hadn't surfaced. Worked around with an
inner `<div class="editor" data-mode={mode}>`.

Either outcome would be fine, but not silence: if root attributes are
reserved (for `static attrs` wiring / the scoped-style marker), reject
them at compile time with a message; if they're meant to work, emit them —
a `data-*`/`class` on the custom element is the natural place for a
variant flag, and it's where `static attrs` reads from on the client.
