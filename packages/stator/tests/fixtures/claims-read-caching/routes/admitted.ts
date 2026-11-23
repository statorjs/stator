import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

// Reads nothing itself; the fixture's middleware reads claims on this path.
export const GET = defineRoute({ reads: [], render: () => html`<p>admitted</p>` })
