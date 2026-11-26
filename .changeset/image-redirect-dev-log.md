---
'@statorjs/stator': minor
---

`stator dev` logs a warning the first time an image is asked for at a width that is not in `images.widths`, naming the width, the list, what answered, and the page that asked. The endpoint already redirects such a request to the next listed width; the line is there so the template asking for the unlisted size gets found. Production logs nothing extra.
