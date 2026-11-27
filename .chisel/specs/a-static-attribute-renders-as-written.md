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
- `'`, `<` and `>` are emitted raw. Browsers mostly tolerate that, but the value was never escaped for the markup.

## Success Criteria

- A static attribute value containing `"`, `'`, `&`, `<`, `>`, `\`, a backtick or `${…}` renders as exactly that text: the markup is `escapeAttribute(value)` inside double quotes, and the module compiles.
- Entities in the value decode first, as JSX and HTML both read them: `title="Tom &amp; Jerry"` and `title="Tom & Jerry"` both render the value `Tom & Jerry`, as on `main`. Named references, `&#38;` and `&#x26;` decode; an unknown or unterminated one (`&foo;`, `&amp` without `;`, a bare `&`) stays as typed. Body text and attributes agree: `a &amp; b` shows `a & b` in both.
- A dynamic attribute (`title={x}`) still lowers to `title="${x}"` and interpolates.
- A value with none of those characters is emitted byte for byte as before, so the checked-in compiled components (`src/components/*.stator.ts`) do not change.
- The same holds inside an island's template, which goes through the same lowering.
- A static string prop on a component (`<Card title="Tom &amp; Jerry"/>`) passes the value `Tom & Jerry`, as JSX would, and an island's root static attributes decode the same way. A plain element, a component prop and an island root attribute given the same static text show the same text.

## Constraints

- Patch release. No API change.
- The one intended behaviour change: `${…}` inside a static attribute is now literal text. A template that wants the value of `price` writes `title={`Price: ${price}`}`.
- Compiler only. No change to `src/template/`; the fix uses its existing `escapeAttribute`.

## Approach

`lowerAttribute` in `packages/stator/src/compiler/lower.ts`:

```ts
if (ts.isStringLiteral(attr.initializer)) {
  const value = decodeJsxEntities(attr.initializer.text)
  return `${name}="${escapeText(escapeAttribute(value))}"`
}
```

A JSX attribute string carries no backslash escapes, so `attr.initializer.text` is the author's text as typed, entities included. `decodeJsxEntities` decodes them exactly as the TypeScript JSX transform does for a string attribute. TypeScript's `decodeEntities` and its `entities` table (the 253 HTML 4 named references, plus decimal and hex numeric references) are internal and not exported, so when the value holds something reference-shaped (`&name;`, `&#n;`, `&#xh;`) it is run through `ts.transpileModule` with `jsx: React` as `<x a="…"/>` and the emitted string literal is read back. A value with no reference skips this entirely. `escapeAttribute` (`template/parser.ts`) then gives the HTML form (`& " ' < >`), and the file's local `escapeText` escapes `\`, a backtick and `$` for the template literal, as it already does for JSX text and `is:inline` scripts. A `${` produced by decoding (`&#36;{x}`) is escaped like a typed one.

The same decoding applies where a static attribute string becomes a value instead of markup, so the value matches what a plain element shows:

- Component string props (`lowerComponent` in `lower.ts`): `${name}: ${JSON.stringify(decodeJsxEntities(text))}`. The prop is a JS string literal in JS code, and the component escapes it wherever it renders it.
- An island's root static attributes (`staticRootAttrs` in `compile.ts`): decoded into the JSON object passed to `clientShellAttrs`, which escapes them at render. The island's client code reads these attributes from the server-rendered DOM, and no separate client emit path carries them, so server and client agree.

`decodeJsxEntities` is exported from `lower.ts` for this; there is one decoder.

Two other places write author text into the generated template the same way and are fixed alongside:

- A leading `<!doctype …>` is spliced into the literal unescaped; it now goes through `escapeText`.
- `<children name="x"/>` emits `props.children?.x`. A name that is not a JS identifier (`name="side-bar"`) was emitted as code (`props.children?.side-bar`); it is now a quoted key (`props.children?.["side-bar"]`). Identifier names are emitted as before.

Emit sites checked and already correct:

- JSX text: `escapeText` for the literal, and HTML is the author's markup by design (`<` cannot appear in JSX text), so its entities are decoded by the browser. Static attributes now agree with it.
- Attribute names, tag names, `ref:` names: JSX identifiers, which cannot contain a backtick, `\` or `${`.
- `on:` event names and `child="x"` region keys: `JSON.stringify` inside a `${…}` expression, which is JS context, where a JSON string is a correct string literal.
- `compiler/client-emit.ts`: slot markers, selectors, the element tag, event names and attribute names are all `JSON.stringify` in JS context, and none of them reach an HTML template.

## Alternatives Considered

- **Keep the value raw and only template-escape it** (treat a static attribute as author HTML, as JSX text is). Keeps `&amp;` meaning `&`, but leaves `title='say "hi"'` broken unless `"` alone is escaped, and lets a raw `&` combine with following text into a reference the author did not write. Rejected.
- **Escape without decoding** (the first cut of this fix). `title="Tom &amp; Jerry"` would show `Tom &amp; Jerry`, which neither JSX nor HTML does, and attributes would disagree with body text. Rejected by the owner on 2026-11-27.
- **A hand-written entity table.** Partial, and it would drift from the JSX reading the editor shows. Rejected in favour of TypeScript's own transform.
- **Escape at runtime** (`title="${"say \"hi\""}"`). Correct, but changes every static attribute in every compiled file and costs a runtime escape per attribute. Rejected.

## Not in this change

- Static strings that are names or keys, not display text, are not decoded: `child="x"` region keys, `<children name="x">`, `on:` event names and `ref:` names (the last two are JSX identifiers and cannot hold `&`). A region key and its `<children name>` stay undecoded on both sides, so they still match.

## Implementation Notes

One PR, S.

- `packages/stator/src/compiler/lower.ts`: the three changes above, `decodeJsxEntities`, and decoding component string props.
- `packages/stator/src/compiler/compile.ts`: decoding island root static attributes in `staticRootAttrs`.
- `packages/stator/tests/compiler-static-attrs.test.ts`: each character class renders as its literal text through the real runtime; entities (`&amp;`, `&quot;`, `&#39;`, `&#x27;`, `&copy;`, `&nbsp;`, numeric, astral, unknown `&foo;`, unterminated `&amp`, a bare `&`) decode or stay as specified; body text and an attribute agree; a component string prop rendered as text and as an attribute, and an island root attribute, decode the same way; a plain element, a component prop and an island root attribute given the same static value show the same text; the emitted markup; a dynamic attribute still interpolates; a compiled component module and an island module parse with esbuild; the doctype and the region name.
- Changeset (patch). No docs state the old behaviour.
