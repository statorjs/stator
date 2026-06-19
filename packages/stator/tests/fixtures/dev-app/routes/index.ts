import { defineRoute } from '@statorjs/stator/server'
import CounterMachine from '../machines/counter.ts'
import page from '../templates/page.stator'

export const GET = defineRoute({
  reads: [CounterMachine],
  render: ({ CounterMachine: counter }: any) => page({ counter }),
})
