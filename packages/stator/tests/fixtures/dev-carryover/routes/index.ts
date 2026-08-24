import { defineRoute } from '@statorjs/stator/server'
import CarryCounterMachine from '../machines/counter.ts'
import page from '../templates/page.stator'

export const GET = defineRoute({
  reads: [CarryCounterMachine],
  render: ({ CarryCounterMachine: counter }: any) => page({ counter }),
})
