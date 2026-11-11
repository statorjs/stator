import { defineRoute } from '../../../../src/server/index.ts'
import { html } from '../../../../src/template/index.ts'

export const GET = defineRoute({ reads: [], render: () => html`<p>plain</p>` })
