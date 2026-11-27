---
title: 'A static attribute renders as the text the author wrote'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: compiler
---

## What and Why

The `.stator` compiler lowers a static attribute (`title="…"`, a JSX string literal) into the generated `` html`…` `` template literal with `JSON.stringify` (`packages/stator/src/compiler/lower.ts:916` on `main`). JSON escaping is for a JS string. The value lands in markup inside a template literal, which needs HTML attribute escaping and template-literal escaping, so several ordinary values come out wrong (findings 05-F2 and 02-F9 of the 2026-11 review, re-confirmed on `main` in `recheck-c.md` and `recheck-a.md`):

- `<p title='say "hi"'>` emits `` html`<p title="say \"hi\"">` ``, which cooks to `<p title="say "hi"">`: the attribute is cut at the second quote and `hi""` becomes stray attributes. `data-config='{"a":1}'` breaks the same way.
- `title="Price: ${price}"` becomes a live interpolation of `price`. It throws a ReferenceError at render, or silently substitutes a frontmatter binding of that name. `data-x="${1+1}"` renders `data-x="2"`.
- A backtick ends the template literal, so the emitted module is a syntax error reported by esbuild against generated code.
- `&`, `'`, `<` and `>` are emitted raw, so `title="&amp;"` shows `&` and not the text the author typed. A component prop (`<Card title="&amp;"/>`) and an island root attribute already render the literal text, because both are escaped at runtime; a plain element attribute was the odd one out.

## Success Criteria

- A static attribute value containing `"`, `'`, `&`, `<`, `>`, `\`, a backtick or `${…}` renders as exactly that text: the markup is `escapeAttribute(text)` inside double quotes, and the module compiles.
- A dynamic attribute (`title={x}`) still lowers to `title="${x}"` and interpolates.
- A value with none of those characters is emitted byte for byte as before, so the checked-in compiled components (`src/components/*.stator.ts`) do not change.
- The same holds inside an island's template, which goes through the same lowering.

## Constraints

- Patch release. No API change.
- The one intended behaviour change: text that looked like a template interpolation or an HTML entity inside a static attribute is now literal text. A template that wants the value of `price` writes `title={`Price: ${price}`}`; one that wants a `&` writes `&` and not `&amp;`.
- Compiler only. No change to `src/template/`; the fix uses its existing `escapeAttribute`.

## Approach

`lowerAttribute` in `packages/stator/src/compiler/lower.ts`:

```ts
if (ts.isStringLiteral(attr.initializer)) {
  return `${name}="${escapeText(escapeAttribute(attr.initializer.text))}"`
}
```

`escapeAttribute` (`template/parser.ts`) gives the HTML form (`& " ' < >`); the file's local `escapeText` then escapes `\`, a backtick and `$` for the template literal, as it already does for JSX text and `is:inline` scripts. A JSX attribute string carries no escape sequences, so `attr.initializer.text` is the author's text as typed.

Two other places write author text into the generated template the same way and are fixed alongside:

- A leading `<!doctype …>` is spliced into the literal unescaped; it now goes through `escapeText`.
- `<children name="x"/>` emits `props.children?.x`. A name that is not a JS identifier (`name="side-bar"`) was emitted as code (`props.children?.side-bar`); it is now a quoted key (`props.children?.["side-bar"]`). Identifier names are emitted as before.

Emit sites checked and already correct:

- JSX text: `escapeText` for the literal, and HTML is the author's markup by design (`<` cannot appear in JSX text).
- Attribute names, tag names, `ref:` names: JSX identifiers, which cannot contain a backtick, `\` or `${`.
- `on:` event names, `child="x"` region keys, component string props (`<Card title="…"/>`): `JSON.stringify` inside a `${…}` expression, which is JS context, where a JSON string is a correct string literal; the prop is escaped when the component renders it.
- Island root static attributes (`compile.ts` `staticRootAttrs`): a JSON object in JS context, escaped by `clientShellAttrs` at render.
- `compiler/client-emit.ts`: slot markers, selectors, the element tag, event names and attribute names are all `JSON.stringify` in JS context, and none of them reach an HTML template.

## Alternatives Considered

- **Keep the value raw and only template-escape it** (treat a static attribute as author HTML, as JSX text is). Keeps `&amp;` meaning `&`, but leaves `title='say "hi"'` broken unless `"` alone is escaped, and keeps an element attribute disagreeing with a component prop of the same text. Rejected.
- **Escape at runtime** (`title="${"say \"hi\""}"`). Correct, but changes every static attribute in every compiled file and costs a runtime escape per attribute. Rejected.

## Implementation Notes

One PR, S.

- `packages/stator/src/compiler/lower.ts`: the three changes above.
- `packages/stator/tests/compiler-static-attrs.test.ts`: each character class renders as its literal text through the real runtime; the emitted markup; a dynamic attribute still interpolates; a compiled component module and an island module parse with esbuild; the doctype and the region name.
- Changeset (patch). No docs state the old behaviour.
