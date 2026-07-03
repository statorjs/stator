import {
  classList,
  each,
  type HtmlFragment,
  html,
  type InstanceOf,
  match,
  on,
  read,
  styleList,
  when,
} from '@statorjs/stator/template'
import type PollsMachine from '../machines/polls.ts'
import type VoterMachine from '../machines/voter.ts'

type PollOption = { id: string; text: string; count: number }
type Poll = {
  id: string
  question: string
  options: PollOption[]
  createdAt: number
}

/**
 * Reads on machine state inside slot selectors MUST go through the proxy
 * arg the selector receives, not a closure-captured selector function.
 * Selectors like `polls.byId` return a closure over the CURRENT snapshot
 * at the time of access, so accessing them inside the selector each time
 * returns fresh data; closing over them at render time returns stale data
 * forever.
 *
 * Good:  read(polls, (p) => p.byId(pollId)?.options)
 * Bad:   read(polls, () => byId(pollId)?.options)  // stale after first render
 */
export default function pollPage(
  polls: InstanceOf<typeof PollsMachine>,
  voter: InstanceOf<typeof VoterMachine>,
  pollId: string,
): HtmlFragment {
  return html`<section class="page page--poll">
    ${when(
      read(polls, (p) => !(p.byId as (id: string) => Poll | undefined)(pollId)),
      () => html`<header class="page-header">
        <h1>Poll not found</h1>
        <p class="page-lede">No poll with that id exists.</p>
        <p><a href="/" class="link">Back to all polls</a></p>
      </header>`,
    )}

    ${when(
      read(polls, (p) => !!(p.byId as (id: string) => Poll | undefined)(pollId)),
      () => html`<header class="page-header">
        <h1>${read(polls, (p) => (p.byId as (id: string) => Poll | undefined)(pollId)?.question ?? '')}</h1>
        <p class="page-lede">
          ${read(polls, (p) => {
            const poll = (p.byId as (id: string) => Poll | undefined)(pollId)
            if (!poll) return ''
            const total = poll.options.reduce((s, o) => s + o.count, 0)
            return `${total} vote${total === 1 ? '' : 's'}`
          })}
        </p>
      </header>

      ${match(
        read(voter, (v) =>
          (v.votedFor as (id: string) => string | null)(pollId) ? 'voted' : 'voting',
        ),
        {
          voting: () => html`<ul class="vote-options">
            ${each(
              read(
                polls,
                (p) => (p.byId as (id: string) => Poll | undefined)(pollId)?.options ?? [],
              ),
              (option) => html`<li class="vote-option">
                <button
                  ${on('click', () =>
                    voter.send({
                      type: 'VOTE',
                      pollId: pollId,
                      optionId: option.id,
                    }),
                  )}
                  ${classList({ 'vote-btn': true })}
                >
                  <span class="vote-btn-text">${option.text}</span>
                </button>
              </li>`,
            )}
          </ul>`,

          voted: () => html`<div class="results">
            <p class="results-banner">
              You voted for
              <strong>${read(voter, (v) => {
                const optId = (v.votedFor as (id: string) => string | null)(pollId)
                const poll = (polls.byId as (id: string) => Poll | undefined)(pollId)
                return poll?.options.find((o) => o.id === optId)?.text ?? ''
              })}</strong>.
              Live results below.
            </p>

            <ul class="results-list">
              ${each(
                read(
                  polls,
                  (p) => (p.byId as (id: string) => Poll | undefined)(pollId)?.options ?? [],
                ),
                (option) => html`<li class="results-row">
                  <div class="results-row-head">
                    <span class="results-row-text">${option.text}</span>
                    <span class="results-row-count">${read(polls, (p) => {
                      const poll = (p.byId as (id: string) => Poll | undefined)(pollId)
                      const o = poll?.options.find((oo) => oo.id === option.id)
                      return o?.count ?? 0
                    })}</span>
                  </div>
                  <div class="results-bar">
                    <div
                      class="results-bar-fill"
                      ${styleList({
                        width: read(polls, (p) => {
                          const poll = (p.byId as (id: string) => Poll | undefined)(pollId)
                          if (!poll) return '0%'
                          const total = poll.options.reduce((s, o) => s + o.count, 0)
                          if (total === 0) return '0%'
                          const o = poll.options.find((oo) => oo.id === option.id)
                          const pct = ((o?.count ?? 0) / total) * 100
                          return `${pct.toFixed(1)}%`
                        }),
                      })}
                    ></div>
                  </div>
                </li>`,
              )}
            </ul>
          </div>`,
        },
      )}

      <div class="share-row">
        <p class="share-label">Share this poll:</p>
        <code class="share-url">${pollId}</code>
      </div>
    `,
    )}
  </section>`
}
