# Live poll

Create a poll, share its link, and watch the bars move as people vote. Every open page updates without a reload.

```sh
pnpm install
pnpm dev
# open http://localhost:3000 in two windows, create a poll, vote in one
```

## What to look at

- `machines/polls.ts` is an **app** machine: one shared set of polls for everyone. A vote changes it, and every **live** page that reads it gets a patch over SSE. It also records which sessions have voted, which is what refuses a second vote.
- `machines/voter.ts` is a **session** machine: the visitor's side of a vote. It forwards the vote to the polls machine and remembers the choice so the page can show it.
- `routes/p/[id].stator` is the poll page, marked `live`. `routes/p/[id].json.ts` is a **data route** for the same poll, as JSON.
- `routes/new.ts` handles the create form as a plain POST; the form works with scripting off.
- `lib/poll.ts` holds the tallying rules as plain functions, tested in `tests/results.test.ts`.

The polls themselves live in memory and are lost on restart. Each visitor's session state is in memory too, unless you copy `.env.example` to `.env.local` and set `REDIS_URL`.

## Learn more

- Docs: https://docs.statorjs.dev
- Reference app: https://demo.statorjs.dev ([source](https://github.com/statorjs/stator/tree/main/apps/store))
