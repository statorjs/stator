import { defineRoute } from '../../../src/server/routing.ts'
import { on } from '../../../src/template/directives/on.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import CounterMachine from '../machines/counter.ts'

export const GET = defineRoute({
  reads: [CounterMachine],
  render: ({ CounterMachine: counter }: any) => html`
    <!doctype html>
    <html>
      <body>
        <h1>Counter</h1>
        <p>${read(counter, (c) => c.label)}</p>
        <button ${on('click', () => counter.send({ type: 'INCREMENT' }))}>+</button>
        <button ${on('click', () => counter.send({ type: 'DECREMENT' }))}>-</button>
        <script src="/static/client.js"></script>
      </body>
    </html>
  `,
})
