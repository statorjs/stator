import { defineRoute } from '@statorjs/stator/server'
import PollsMachine from '../machines/polls.ts'
import homePage from '../templates/home-page.ts'
import layout from '../templates/layout.ts'

export const GET = defineRoute({
  reads: [PollsMachine],
  live: true,
  // biome-ignore lint/suspicious/noExplicitAny: the old-style route API's render ctx is untyped; this app is slated for the .stator rewrite (0.9 work list)
  render: ({ PollsMachine: polls }: any) => layout(homePage(polls)),
})
