import { defineRoute } from '../../../../src/server/index.ts'
import { html } from '../../../../src/template/index.ts'
import stepper from '../templates/stepper.stator'

export const GET = defineRoute({
  reads: [],
  render: () => html`<html><head><title>stepper</title></head><body>${stepper()}</body></html>`,
})
