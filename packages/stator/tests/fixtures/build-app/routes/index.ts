import { defineRoute } from '../../../../src/server/index.ts'
import widget from '../templates/widget.stator'

export const GET = defineRoute({
  reads: [],
  render: () => widget(),
})
