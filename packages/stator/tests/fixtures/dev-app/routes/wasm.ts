import { defineRoute } from '@statorjs/stator/server'
import { html } from '@statorjs/stator/template'
import WasmProbe from '../templates/wasm-probe.stator'

export const GET = defineRoute({
  reads: [],
  render: () => html`<html><head><title>wasm</title></head><body>${WasmProbe({})}</body></html>`,
})
