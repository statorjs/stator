import { defineRoute } from '@statorjs/stator/server'
import PollsMachine from '../machines/polls.ts'
import layout from '../templates/layout.ts'
import homePage from '../templates/home-page.ts'

export const GET = defineRoute({
  reads: [PollsMachine],
  live: true,
  render: ({ PollsMachine: polls }: any) => layout(homePage(polls)),
})
