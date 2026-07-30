import { defineRoute } from '@statorjs/stator/server'
import { html } from '@statorjs/stator/template'

// The page half of the /pp/:id pair — exists to prove the bare param does
// NOT swallow /pp/abc.json (the suffixed data route must outrank it).
export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => html`
    <html>
      <body>
        <p>page ${request.params.id}</p>
      </body>
    </html>
  `,
})
