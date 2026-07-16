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
