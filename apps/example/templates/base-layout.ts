import { html, type HtmlFragment } from '@statorjs/stator/template'

/**
 * Pure HTML shell. No machine dependencies — takes pre-rendered header and
 * body fragments and wraps them in the document chrome shared between the
 * customer and admin UIs (doctype, head, stylesheet, client runtime script).
 */
export default function baseLayout(
  header: HtmlFragment,
  body: HtmlFragment,
): HtmlFragment {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>stator demo</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    ${header}
    <main>${body}</main>
    <script src="/static/client.js"></script>
    <script src="/static/inspector.js" defer></script>
  </body>
</html>`
}
