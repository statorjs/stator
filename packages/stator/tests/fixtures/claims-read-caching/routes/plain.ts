import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

export const GET = defineRoute({ reads: [], render: () => html`<p>plain</p>` })
