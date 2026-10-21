---
title: 'Rebox paper cuts: JSON-LD escaping, self-closing elements, and silent-drop diagnostics'
status: ready
created: 2026-10-10
updated: 2026-10-11
area: compiler
---

## What and Why

Evidence from the rebox migration (`.chisel/docs/rebox-paper-cuts.md`, items
2–7) — a real external app on the published package, not an in-tree example.
One data-corruption bug, one wrong-emit bug, two silent drops, one typing
gap, and one tooling mismatch. None is large; the point of bundling them is
that they share a shape, and one structural change (`stator check` running
the compiler) makes every other item here a `check` failure instead of a
runtime surprise.

Verified against the current tree, with corrections to the log where it
overstates:

- **JSON-LD** (`components/json-ld.ts:30-60`): `safeJsonLdReplacer` maps
  `& < > " '` to HTML entities inside every string value. `<script>` content
  is raw text to the HTML parser, so a consumer reads `20&apos;` literally.
  Every description with an apostrophe or ampersand ships wrong structured
  data. Must land before rebox cutover.
- **Self-closing non-void** (`compiler/lower.ts:479`): every
  `JsxSelfClosingElement` is emitted as `<tag … />`. Browsers treat
  `<div />` as an open tag, so siblings nest. The void set already exists
  twice (`virtual-code.ts:190`, `template/each.ts:300`).
- **`child="x"` placement** (`compiler/lower.ts:680`): `childRegionOf` only
  inspects direct `JsxElement`/`JsxSelfClosingElement` children of a
  component tag. A marker inside `{cond ? <div child="top"/> : null}` is
  bucketed as default content with no diagnostic. On a component tag it
  is collected as a prop and ignored.
- **Island root attrs** (`compiler/compile.ts:274`): `staticRootAttrs` keeps
  string-literal and valueless-boolean attrs — the log's "silently dropped"
  is specifically *expression-valued* (`data-mode={mode}`) and namespaced
  (`on:`, `class:list`) attrs, which the doc comment says are skipped. The
  skip is deliberate; the silence is not.
- **`button` typing** (`template/html-attributes.ts:67`): no `formaction`,
  `formmethod`, `formenctype`, `formnovalidate`, `formtarget`. Ordinary
  multi-action-form HTML.
- **JSX in frontmatter**: `compile.ts:373` and `virtual-code.ts:333` both
  parse frontmatter as `ScriptKind.TS`, but the virtual file then splices
  the statement *text* into a `.tsx` function body, where TS re-lexes
  `return <p/>` as JSX and type-checks it. The real compiler splices the
  same text into the server module and esbuild fails on it. The
  frontmatter-as-plain-TS rule is a design constraint (README, "Templates
  must parse as TSX"; Astro made the same call); the bug is that nothing
  states it at the point of use, and `stator check` never asks the
  compiler.

The last point generalizes. `cli/commands/check.ts` runs `syncTypes` + a
`tsc` pass over the virtual TSX. It never calls `compile()`. The language
server does (`language-server/src/diagnostics.ts` surfaces `CompileError`s
as squiggles). So today the editor is stricter than `check`, and `dev` is
stricter than both. Every diagnostic this spec adds is a `CompileError`,
which means: editor coverage is free, and `check` coverage is one change.

## Approach

Six items, independently shippable, sequenced by urgency. Each lands with a
test in `packages/stator/tests/` and a changeset.

### 1. `<JsonLd>`: JSON escapes, not HTML entities

Drop the entity table. Keep null-stripping as a plain replacer. Post-process
the serialized string:

```ts
JSON.stringify(ld, stripNulls, space)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/ /g, '\\u2028')
  .replace(/ /g, '\\u2029')
```

`<` is exactly what JSON-LD 1.1 §"Restrictions for contents of JSON-LD
script elements" asks for: the text can no longer contain `</script` or
`<!--`, and a JSON parser turns the escape back into the real character.
`"` needs nothing (`JSON.stringify` already escapes it); `'` never needed
anything. The two line separators are the standard extra for inline JSON
in HTML (legal JSON, illegal unescaped in older JS; harmless to include).

`ldToString` keeps its signature. `tests/components-json-ld.test.ts` gains:
an apostrophe and ampersand round-trip through `JSON.parse` of the script
body to the original string; `</script>` in a value does not appear
verbatim in the output; output contains no `&amp;`/`&apos;`.

Semver: patch. This is a bug fix to a component whose output was wrong.

### 2. Self-closing non-void elements close

In `lower.ts`'s `JsxSelfClosingElement` branch: if the tag is in the HTML
void set, emit `<tag …>` (the trailing slash is permitted-but-meaningless
on void elements; dropping it matches what the parser does and keeps output
identical to the `<br>` an author would write). Otherwise emit
`<tag …></tag>`. Custom elements (`tag.includes('-')`) are non-void and
take the closing tag too — this is also the correct answer for
`<my-widget />` used as a leaf.

Hoist the void set to one exported constant (`template/html-void.ts` or
alongside `each.ts`'s copy) and point `virtual-code.ts` and `each.ts` at
it. Three copies of the same list is how one drifts.

Scope suffix placement: `<div data-s-x></div>`, same as today's open tag.

Test: `each(items, (_, i) => <div aria-current={…} />)` renders N sibling
divs (`isSingleRootElement`-style scan or a parse via the test suite's
existing HTML helper); `<br />` renders `<br>`; `<img … />` renders
`<img …>`.

Semver: patch. Output that was never valid HTML becomes valid; nobody can
have depended on the nesting.

### 3. `child="x"` is a located error anywhere it can't be read

Add a pass in `lower.ts` (next to `checkNoBindingInRcdata`, same shape:
a recursive walk with a frame) that throws a located `CompileError` when a
`child` attribute appears on:

- an element that is not a **direct** JSX child of a component tag —
  including inside a `JsxExpression` (`{cond ? <div child="top"/> : …}`),
  nested deeper, or at the template root;
- a **component** tag (`<PreviewBanner child="top"/>`). Supporting this is
  a real feature (the marker would have to ride through `lowerComponent`
  into the child bag with the component's rendered fragment); until it
  exists the attr must not be a silently ignored prop.

Message shape, with the code frame pointing at the attribute:

```
stator: child="top" has no effect here — a child="x" marker is only read on
a direct element child of a component tag. Move the condition inside the
slotted element: <div child="top">{cond ? … : null}</div>
```

The component-tag variant says so explicitly and names the same workaround.

Test in `tests/compiler-children-validation.test.ts`: the three positions
above each throw with a `loc` on the attribute; the valid shape still
compiles.

Semver: minor (new compile errors on code that compiled before — but that
code never did what it said, so this is the "compile error instead of
silent misbehavior" category we already treat as additive).

### 4. Island root: non-static attrs are a located error

In `staticRootAttrs` (`compile.ts:274`), instead of `continue` on a
namespaced or expression-valued attribute, throw a located `CompileError`:

```
stator: <markdown-editor data-mode={mode}> — attributes on an island's root
must be static (a string literal or a bare boolean). The root is rendered by
the shell from the use site's props; a dynamic value belongs on an inner
element, or declare it with `static attrs` and pass it from the use site.
```

`{...spread}` on the root gets the same treatment. Static string/boolean
attrs keep working exactly as `tests/component-root-attrs.test.ts` asserts.

`extractClientRoot` currently has no offset into the original source (its
`loc` is `line: 1`). Thread the template's `contentOffset` through so the
frame points at the attribute; `locAt` already exists for this.

Semver: minor, same reasoning as §3.

### 5. `button` grows the `form*` attributes

Add to `ElementSpecificAttributes.button`:

```ts
formaction?: string
formenctype?: 'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain'
formmethod?: 'get' | 'post' | 'dialog'
formnovalidate?: boolean
formtarget?: string
```

`input` gets the same five (they're valid on `<input type="submit">` and
`type="image">`). Test in `tests/html-attributes.test.ts` is a type-level
assertion that `<button formaction="/x" formnovalidate>` typechecks and
`<button formmethod="put">` does not.

Semver: patch (types only, purely additive).

### 6. Frontmatter: JSX is a located error, and `stator check` runs the compiler

Two halves.

**(a) The diagnostic.** In `processFrontmatter`, after
`ts.createSourceFile`, read `sf.parseDiagnostics`. It is an internal
field on TypeScript's `SourceFile`, but it is what every tool reads and it
has been stable for a decade; the public alternative (`transpileModule`)
re-parses the text for the same answer. Access it through one typed
helper with a comment so there is a single place to change if TS ever
drops it. A syntax error in frontmatter becomes a located `CompileError`
with TS's own message, which alone is a better experience than esbuild's
`Expected ")" but found "return"` on the emitted module.

Then one targeted hint: if any `TypeAssertionExpression` appears whose
type is a `TypeReference` named like an HTML tag or a capitalized
component (i.e. the thing `<p>` or `<NotFound>` lexes as in TS mode),
replace the generic message with:

```
stator: JSX isn't allowed in frontmatter — it's plain TypeScript. Markup
belongs in the template (use when()/match() for conditional content); a
different page for a not-found case cascades to routes/404.stator.
```

Verified: `return <p>hi</p>` in TS mode yields one parse diagnostic
("Unterminated regular expression literal") and one `TypeAssertion` node;
a generic arrow `<T>(a: T) => a` yields neither, so it stays legal.

`virtual-code.ts` is a mapping builder and can't throw usefully, and it
doesn't need to: the language server already runs `compile()` and will show
this error as a squiggle. The virtual TSX only has to *not* make the code
look fine. Cheapest route: when the frontmatter parse has syntactic
diagnostics, emit the offending statement as a string literal
(`'<verbatim text>'`) rather than code, so TS sees an unused expression,
not valid JSX. The compiler's located error is the one the editor shows.

**(b) `check` shares plumbing with `dev`.** `checkStack` gets a step
between `syncTypes` and the tsc pass: for every `.stator` file `syncTypes`
already enumerated, call `compile(text, { id, kind })` and collect any
`CompileError`. Report them in the same `file:line:col` format the tsc
diagnostics use and count them in the final tally. This is the same call
the language server makes, so the three surfaces (editor, `check`, `dev`)
reject the same inputs. `build` already runs `check` first, so this also
means a `build` fails on any compile error before touching `dist/`.

Cost: one extra compile per `.stator` file in `check`. These are already
compiled on `dev` import; the output is discarded here.

Docs: add to README "Known limitations" and
`apps/docs/.../concepts/the-stator-file.md`: *frontmatter is plain
TypeScript, not TSX — no JSX; conditional markup lives in the template.*

Semver: minor (new diagnostics in `check`; no runtime behavior change).

## Constraints

- Every new diagnostic is a `CompileError` with a `loc` into the original
  `.stator` source. That contract is what makes the dev overlay, the
  language server and (after §6b) `check` agree.
- No new authoring surface. Everything here either fixes output, tightens
  types, or turns an existing silent path into an error. Marker-on-component
  (`<X child="top"/>`) and island `static props` are explicitly out of
  scope: both are features that deserve their own spec, and
  [[island-frontmatter-server-fences]] already frames the second.
- Static root attrs on islands remain supported; `component-root-attrs`
  tests are the regression guard.

## Alternatives Considered

- **Keep `<div />` as-is and document it.** Rejected: every other
  JSX-to-HTML renderer closes it; this is the single most likely thing a
  React/Astro/Solid author writes on day one, and the failure is two steps
  removed from the cause.
- **Teach the compiler JSX in frontmatter.** Rejected: frontmatter would
  then need a JSX runtime or a second lowering path, and the whole
  "templates lower to `html` tagged templates, no runtime JSX" design is
  what keeps the compiler small. Astro chose the same restriction. The 404
  cascade already covers the motivating case.
- **Warnings instead of errors for §3/§4.** Rejected: there is no warning
  channel in the compiler today, and a marker in an unreadable position is
  never intentional. An error with a clear "write it this way instead" is
  more useful than a warning the dev server would have to invent a UI for.
- **Emit expression attrs on the island root.** Deferred, not rejected:
  it means threading the use site's render scope into the shell, which is
  the same machinery `static props` needs. Do them together.
- **Make `check` run the full `buildApp`.** Rejected: compile-only is the
  minimal shared step and keeps `check` output-free.

## Open Questions

Resolved 2026-10-11:

- **Parse diagnostics source** — the internal `sf.parseDiagnostics`, behind
  one helper. No need to pay for a second parse.
- **Void-element snapshots** — if `<img … />` → `<img …>` churns snapshot
  tests in `apps/docs` or `examples/`, fix the snapshots in the same PR.
  The feature is not shaped around existing fixtures.
- **Component-tag marker wording** — use the "isn't supported yet — only …"
  form. It is already the house voice for exactly this category
  (`lower.ts`: `forwarding "on:x" to a component isn't supported yet — only
  …`), so the question of whether to imply the feature was settled by
  precedent. Final text:

  ```
  stator: child="top" on <PreviewBanner/> isn't supported yet — a child="x"
  marker is only read on a plain element that is a direct child of a
  component tag. Wrap it: <div child="top"><PreviewBanner/></div>
  ```

  Same shape as the §3 element-position message: rule, dash, the exact
  rewrite. No "Hint:" line (Astro's convention); Stator's code frame
  follows the message and does that job.

## Success Criteria

- `/products/mobile-office-20` on rebox: script body `JSON.parse`s to the
  original description with `'` and `&` intact; Google's Rich Results test
  passes.
- `each(images, () => <div … />)` renders N sibling elements.
- The three bad `child="x"` positions and a `data-mode={mode}` island root
  each fail in `stator dev` (overlay), in the editor (squiggle at the
  attribute) and in `stator check` (located line) with the same message.
- `return <p/>` in frontmatter fails in all three surfaces with the
  JSX-specific message; `stator check` and `stator dev` never disagree on
  whether a `.stator` file compiles.
- `<button formaction="/x" formnovalidate>` typechecks with no cast.

## Implementation Notes (sequencing)

1. §1 JsonLd — one file, one test; ship as a patch on its own so rebox can
   cut over.
2. §2 self-closing + void-set hoist, §5 button attrs — small, independent.
3. §6b `check` runs `compile()` — do this *before* §3/§4/§6a so their tests
   can assert `check` coverage, not just `compile()` throwing.
4. §3, §4, §6a — the diagnostics batch. One PR; they share the "silent →
   located error" test pattern.
5. Docs line for frontmatter-is-plain-TS; README limitation.