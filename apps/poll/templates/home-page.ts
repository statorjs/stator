import {
  html,
  read,
  each,
  when,
  type InstanceOf,
  type HtmlFragment,
} from '@statorjs/stator/template'
import type PollsMachine from '../machines/polls.ts'

type Poll = {
  id: string
  question: string
  options: Array<{ id: string; text: string; count: number }>
  createdAt: number
}

export default function homePage(
  polls: InstanceOf<typeof PollsMachine>,
): HtmlFragment {
  return html`<section class="page page--home">
  <header class="page-header">
    <h1>What do you want to ask?</h1>
    <p class="page-lede">
      Create a quick poll, share the link, and watch votes appear in real
      time.
    </p>
    <div class="cta-row">
      <a href="/new" class="btn btn-primary">New poll →</a>
    </div>
  </header>

  <section class="recent">
    <h2>Recent polls</h2>

    ${when(
      read(polls, (p) => p.totalCount === 0),
      () => html`<p class="empty">
        No polls yet. <a href="/new" class="link">Create the first one</a>.
      </p>`,
    )}

    <ul class="poll-list">
      ${each(
        read(polls, (p) => p.all as Poll[]),
        (poll) => html`<li class="poll-list-item">
          <a href="/p/${poll.id}" class="poll-link">
            <span class="poll-link-question">${poll.question}</span>
            <span class="poll-link-meta">
              ${poll.options.length} options ·
              ${poll.options.reduce((s, o) => s + o.count, 0)} votes
            </span>
          </a>
        </li>`,
      )}
    </ul>
  </section>
</section>`
}
