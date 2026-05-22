import { html, type HtmlFragment } from '@statorjs/stator/template'

/**
 * Pure HTML shell. The poll demo has no shared header reads (no cart-count
 * equivalent), so the layout doesn't need to receive a machine.
 */
export default function layout(body: HtmlFragment, headerExtras?: HtmlFragment): HtmlFragment {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>polls · stator</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    <header class="site-header">
      <a href="/" class="brand">polls</a>
      <nav>
        ${headerExtras ?? html``}
      </nav>
    </header>
    <main>${body}</main>
    <script src="/static/client.js"></script>
  </body>
</html>`
}
