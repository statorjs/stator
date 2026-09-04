import { defineRoute } from '../../../../src/server/index.ts'
import { html } from '../../../../src/template/index.ts'
import { rootData } from '../lib/rootdata.ts'
import Counter from '../machines/counter.ts'
import Panel from '../templates/panel.stator'

export const GET = defineRoute({
  reads: [Counter],
  render: () => html`<div>${Panel({})}${rootData()}</div>`,
})
