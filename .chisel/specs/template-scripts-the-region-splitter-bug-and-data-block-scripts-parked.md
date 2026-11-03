---
title: 'Template scripts: the region splitter bug, and data-block scripts (parked)'
status: draft
created: 2026-11-02
updated: 2026-11-02
area: compiler
---

## What and Why

Two related findings from adding a `<Speculation>` component to tonysull.co (2026-11-02). One is a bug worth fixing; the other is a parked DX idea.

### 1. Bug: the region splitter matches `<script>` / `<style>` anywhere

`splitStator` (`src/compiler/split.ts`) extracts client `<script>` and `<style>` regions with regular expressions over all text after the frontmatter:

```ts
const STYLE_RE = /<style>([\s\S]*?)<\/style>/g
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g
```

They don't distinguish a top-level element from the same text inside a `{…}` expression, a string or template literal, or a comment. Repro (from the site):

```stator
---
const json = '{"prerender":[]}'
---
{json ? raw(`<script type="speculationrules">${json}</script>`) : null}
```

`stator check` fails with "this <script> exports no StatorElement subclass" and then "Unterminated template literal": the script text inside the template literal was lifted out as a client component, cutting the literal in half.

Same failure, by reading the code (not reproduced): `<style>…</style>` text inside an expression becomes component CSS, and a code sample such as `{'Use <script>…</script>'}` breaks. The language server and `stator check` share the splitter, so the editor shows the same wrong regions.

**Fix:** a scanner instead of the regexes. Walk the post-frontmatter source tracking `{…}` depth, string and template literals, and comments (the TypeScript scanner can do the literal tracking), and take only top-level `<script>` / `<style>` elements. Keep the `src` / `is:inline` classification as is. Regression tests: a script in a template literal, a style in a string, a code-sample expression, a comment containing `</script>`; each must leave the template intact and extract nothing.

### 2. Parked: data-block scripts in templates

A `<script>` with a non-JavaScript `type` is a data block the browser never executes (`application/ld+json`, `speculationrules`, `importmap`). Today a template can't hold one with computed content:
- a bare `<script>` is taken as a client component;
- `<script is:inline>` is copied verbatim, so `{json}` stays literal text (verified: it compiles to `` html`<script type="speculationrules">{json}</script>` ``).

The working pattern is the built-in `<JsonLd>` (`src/components/json-ld.ts`): a TS function component that emits the tag through `raw()`, with JSON `\uXXXX` escaping for script content. tonysull.co's `Speculation` (`lib/speculation.ts`) follows it. It works, but the DX is confusing inside a `.stator` file: the natural markup

```stator
{hasRules && <script type="speculationrules">{rulesJson}</script>}
```

fails, and the reason (the client-component rule) isn't obvious. The target markup is

```stator
<script type="speculationrules" set:json={rules} />
```

**Not expression children.** An early version of this idea let `{…}` inside a data script be an expression. That breaks the commonest case: literal JSON starts with `{`, so `<script type="application/ld+json">{ "@type": "Person" }</script>` would parse as a template expression. HTML treats script content as raw text, and so should Stator.

**The idea, if picked up (modelled on Astro):** Astro processes a `<script>` only when it has no attribute besides `src`; any other attribute makes it `is:inline`, and computed content goes in through a directive (`<script type="application/ld+json" set:html={JSON.stringify(x)} />`). Astro's `set:html` doesn't escape, so a `</script>` in the data breaks out unless the author escapes it. For Stator:

1. A `<script>` whose `type` is not JavaScript is never a client component. Its body is emitted verbatim, so literal JSON works.
2. A `set:json={value}` directive supplies computed content. Stator serializes and escapes it (the `escapeForScript` set `<JsonLd>` uses), so there is no breakout hole.
3. **Typed per `type`.** A registry maps each supported `type` to its payload, and apps extend it by declaration merging:

   ```ts
   type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined }

   interface DataScriptTypes {
     'application/ld+json': Thing | Thing[] // schema-dts, as <JsonLd> uses
     speculationrules: SpeculationRules
     importmap: { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>>; integrity?: Record<string, string> }
     'application/json': JsonValue
   }
   ```

   The check emit (the virtual TSX behind `stator check` and the language server) lowers the element to `__dataScript('speculationrules', value)`, declared as `<T extends keyof DataScriptTypes>(type: T, value: DataScriptTypes[T]) => void`. An unknown `type` errors with the known list; a wrong payload errors against its shape. `| undefined` in `JsonValue` admits optional properties under `exactOptionalPropertyTypes` (`JSON.stringify` drops them).

   Caveat to resolve: a value typed by an `interface` isn't assignable to an index-signature type (interfaces get no implicit index signature). Either document "use `type` aliases" or check with a mapped `JsonCompatible<T>` constraint, which accepts interfaces.

   Risk: the per-type shapes must track the platform (speculation rules are still evolving), which is why the registry is extensible and `application/json` stays as the untyped fallback.

With this, `<JsonLd>` and a `<Speculation>` built-in become thin conveniences over `set:json` rather than the only way to emit a data script.

**Parked (2026-11-02)** because the function-component pattern covers the need. Revisit if more data-block built-ins appear (speculation rules is the second after JSON-LD), or if users keep reaching for the markup form.

## Related

- A `<Speculation>` built-in (speculation rules, shaped like `<JsonLd>`) is being dogfooded on tonysull.co before it's proposed for `@statorjs/stator/components`.
