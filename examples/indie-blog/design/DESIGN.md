# indie-blog — design direction

A personal site from the era worth keeping: warm paper, serif body text, one
violet accent. It should read as a place someone writes, not a product.

- **Palette**: warm off-white, dark warm ink, violet accent for interactive
  bits, a dried red reserved for likes and errors. Tokens only in
  `static/app.css`, every component scoped.
- **Type**: serif body (Georgia stack) at a comfortable reading size. The
  monospace small-caps voice (uppercase, letterspaced) marks apparatus:
  section headers, the admin desk, mention counts.
- **Front page**: an h-feed of posts divided by hairline rules. Notes render
  title-less, articles carry a heading — the visual difference IS the
  post-type difference.
- **Post page**: the entry, then the conversation. Mentions are a quiet
  ruled list with a kind glyph (★ like, ↻ repost, ↩ reply), the author's
  name, and an excerpt for replies. The live arrival of a new mention is the
  page's one moment of drama.
- **Admin**: the same visual language, no dashboard chrome. Compose is a
  title field and a textarea. Moderation is a list with two buttons.

The bar is guide-conformance: scoped styles, element and attribute
selectors, near-zero classes (microformats classes are semantic, not
styling hooks — they stay).
