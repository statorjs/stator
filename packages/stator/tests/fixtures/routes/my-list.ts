import { defineRoute } from '../../../src/server/routing.ts'
import { each } from '../../../src/template/each.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import List from '../machines/list.ts'

export const GET = defineRoute({
  reads: [List],
  live: true,
  render: ({ ListMachine: list }: any) => html`
    <html>
      <body>
        <ul>
          ${each(
            read(list, (l) => l.items as string[]),
            (id: string) => html`<li>${id}</li>`,
            { key: (id: string) => id },
          )}
        </ul>
      </body>
    </html>
  `,
})
