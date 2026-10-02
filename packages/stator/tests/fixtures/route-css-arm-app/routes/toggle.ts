import { defineRoute } from '../../../../src/server/index.ts'
import { html } from '../../../../src/template/index.ts'
import Toggle from '../machines/toggle.ts'
import host from '../templates/host.stator'

export const GET = defineRoute({
  reads: [Toggle],
  render: ({ ToggleMachine: toggle }: any) =>
    html`<html><head><title>toggle</title></head><body>${host({ toggle })}</body></html>`,
})
