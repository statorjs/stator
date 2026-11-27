import card from '#components/card.stator'
import ticker from '#components/ticker.stator'
import badge from '#ui/badge.stator'
import { defineRoute } from '../../../../src/server/index.ts'
import { html } from '../../../../src/template/index.ts'

export const GET = defineRoute({
  reads: [],
  render: () =>
    html`<html><head><title>subpath</title></head><body>${card()}${badge()}${ticker()}</body></html>`,
})
