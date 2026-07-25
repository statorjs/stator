# Guestbook

The oldest idea on the web, on the newest architecture. One page, shared by
everyone who visits: sign it, and your entry appears on every open copy of
the page. This app ships **no custom JavaScript** — signing is a plain form
post, and live updates arrive as server-sent DOM patches.

```bash
pnpm install
pnpm dev        # http://localhost:3002 — open it in two windows
```

## How it works

Three small files carry the whole app:

- **`machines/book.ts`** — the shared book. One instance for every visitor
  (`lifecycle: 'app'`, `persist: true`). Signatures arrive through a
  cross-machine subscription, and the book applies the rules before
  recording anything.
- **`machines/visitor.ts`** — per-visitor state (`lifecycle: 'session'`).
  The form's SIGN event lands here; the machine emits SIGNED, which the book
  subscribes to. It also remembers that *you* signed, for the thank-you note.
- **`routes/index.stator`** — the page. `read(book, (b) => b.entries)` in a
  keyed `each` renders the signatures; a new one arrives on every open page
  as a single insert patch. The route is `// @stator live`, which is the
  whole realtime setup.

The rules — a name, a message up to 280 characters, latest 100 entries kept —
live in `lib/rules.ts` and run in the machines, not the browser. There is no
client-side validation to bypass.

`routes/index.ts` is the form's POST handler at the same URL: parse, bounce
obviously-bad input back with a friendly `?error=`, dispatch. The machines
re-check everything — the handler is the doorman, not the law.

## Production

```bash
pnpm build && pnpm start
```

Entries live in the app machine. In-memory by default — restarting loses the
book unless you wire an `AppStore` (e.g. `RedisAppStore`) into `createApp`.
Timestamps render in the server's timezone.

## Tests

```bash
pnpm test
```

Every rule of the book, exercised as events in / state out — no browser, no
mocks.
