# Findings — building the weather example

Framework rough edges surfaced while building this app (per CONTRIBUTING's
"findings over patches"). Each is worked around in the example; the note is for
the framework.

## 1. Static `class` + `class:list` on the same element emits two `class` attributes

`<button class="place-tab" class:list={{ active }}>` compiles to a tag with
**two** `class` attributes:

```html
<button class="active" ... class="place-tab">
```

Per the HTML parser the browser keeps the *first* and drops the rest, so the
static `place-tab` class silently vanishes.

- **Workaround:** put every class in `class:list` — it accepts an array mixing a
  static string with a conditional object: `class:list={['place-tab', { active }]}`.
- **Suggested fix:** merge a static `class` attribute into the `class:list`
  output (or emit a compile-time error/warning on the collision), since the
  duplicate is silent and surprising.

## 2. Element ids are a flat global counter, so an element-id'd node inside a `match`/`when` arm gets an unstable id

Slot ids are arm-scoped and stable (`s3:bready:s1`). Element ids (`data-stator-id`,
used for **attr patches**, `on:` handlers, and client islands) are a **flat
sequential counter**, so the id assigned to a node depends on how many
element-id'd nodes rendered before it — which differs between an incremental
branch-swap render and a full page render.

Concretely: a client island with a live `read()` attribute placed *inside* a
`match` arm got id `e0` in a full render but `e3` after a `loading → ready` branch
swap (the always-rendered nav buttons took `e0..e2` first). On a subsequent live
update, the attr patch targeted `e0` — which in the live DOM was a **button**, not
the island — so `setAttribute` landed on the wrong element and the island never
updated. Text/slot patches were unaffected (slot ids are arm-scoped).

- **Symptom:** an attribute bound with `read()` on an element inside a conditional
  silently stops live-updating (patch lands on the wrong node, or logs
  `patch target element "eN" not in DOM — skipped`).
- **Workaround:** keep element-id'd nodes (islands, `on:` handlers, `read()`-bound
  attributes) **outside** conditional arms. Here the live-sky was moved out of the
  `match` so only its overlay text is conditional.
- **Suggested fix:** scope element ids to the branch arm the same way slot ids are
  (`eN` → `s3:bready:eN`), so an element's id is stable regardless of surrounding
  conditional state.
