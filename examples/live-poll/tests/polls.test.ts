import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import PollsMachine from '../machines/polls.ts'

// The machine alone, no server: events in, context and selectors out. In the
// app `sourceSessionId` is added by the framework; here the test supplies it.
const start = () => {
  const polls = createActor(PollsMachine).start()
  polls.send({ type: 'CREATE_POLL', question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'], sourceSessionId: 'a' })
  const ctx = () => polls.getSnapshot().context
  const poll = () => PollsMachine.selectors.summaries(ctx())[0]!
  const results = () => PollsMachine.selectors.results(ctx())(poll().id)
  const vote = (optionId: string, sourceSessionId: string) =>
    polls.send({ type: 'RECORD_VOTE', pollId: poll().id, optionId, sourceSessionId })
  return { polls, poll, results, vote }
}

describe('polls', () => {
  it('counts one vote per session', () => {
    const { poll, results, vote } = start()
    const [tabs, spaces] = results()
    vote(tabs!.id, 'a')
    vote(spaces!.id, 'a') // the same session again, for the other option
    vote(spaces!.id, 'b')
    assert.equal(poll().votes, 2)
    assert.deepEqual(results().map((o) => [o.text, o.count, o.pct]), [
      ['Tabs', 1, '50.0'],
      ['Spaces', 1, '50.0'],
    ])
  })

  it('refuses a vote for an option the poll does not have', () => {
    const { poll, vote } = start()
    vote('nope', 'a')
    assert.equal(poll().votes, 0)
  })

  it('refuses a poll with fewer than two real options', () => {
    const { polls } = start()
    polls.send({ type: 'CREATE_POLL', question: 'Alone?', options: ['Yes', '  '], sourceSessionId: 'a' })
    assert.equal(PollsMachine.selectors.totalCount(polls.getSnapshot().context), 1)
  })
})
