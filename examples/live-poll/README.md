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
- The machine's selectors shape what each page needs: the ballot reads `choices`, which has no counts, so other people's votes send a voting page nothing.
- `tests/polls.test.ts` tests the one-vote rule on the machine alone; `tests/results.test.ts` drives the real app through the form and the JSON route.

Everything is in memory by default. Copy `.env.example` to `.env.local` and set `REDIS_URL`, and both the polls (`persist: true` on the app machine) and each visitor's session survive a restart.

## Learn more

- Docs: https://docs.statorjs.dev
- Reference app: https://demo.statorjs.dev ([source](https://github.com/statorjs/stator/tree/main/apps/store))
