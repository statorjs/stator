# indie-blog — your site is the node

A personal blog where the IndieWeb protocols run in-process. Posts carry microformats, three feeds serve the archive, and webmentions arrive at YOUR endpoint — verified by a state machine you can read, moderated at your desk, and displayed live while someone is reading the post.

```bash
pnpm install
pnpm dev
# open http://localhost:3007 — sign in at /admin (dev password: owls-at-dusk)
```

## What it teaches

**Receiving is the point.** Static-site IndieWeb setups outsource the receiving apparatus (webmention.io and friends) because pre-built output can't accept a POST. This site is a server: `/webmention` is a route, the request validation is a session gateway's GUARD, verification is a transition effect that fetches the source and confirms the link, and moderation is a typed event only the authenticated owner can commit. The wire cannot forge an approval — it would have to get past a guard.

**Collections of workflows, twice.** Each incoming mention is its own verification workflow and each outgoing mention its own delivery workflow — per-record maps moved only by declared events, completions in machine-level `on:` so nothing strands them (the collections recipe, live).

**Syndication is just more targets.** Publishing queues a webmention to every URL the post links, plus every endpoint in `INDIE_BLOG_SYNDICATE` — point that at Bridgy publish endpoints and POSSE costs zero extra machinery.

**Storage split, by doctrine.** The post archive is reference data → SQLite (`node:sqlite`, Node 24+). The conversation around posts is bounded reactive state → a persisted app machine, which is what makes a mention appear on the page live over SSE.

## Configuration

| env | default | |
|---|---|---|
| `INDIE_BLOG_ORIGIN` | `http://localhost:3007` | absolute origin; webmention targets must live under it |
| `INDIE_BLOG_NAME` | An Indie Blog | site title |
| `INDIE_BLOG_AUTHOR` | The Author | h-card name |
| `INDIE_BLOG_PASSWORD` | owls-at-dusk | owner password (dev default — set your own) |
| `INDIE_BLOG_SYNDICATE` | *(empty)* | comma-separated extra webmention targets (Bridgy publish endpoints) |
| `INDIE_BLOG_DB` | `indie-blog.db` | SQLite path |

## Layout

```
machines/receiver.ts   the anonymous gateway — spec validation as a guard
machines/mentions.ts   verification workflows + moderation (app, persisted)
machines/outbox.ts     outgoing mentions + syndication, per-target workflows
machines/owner.ts      the owner's session — auth guard, privileged emits
lib/webmention.ts      the spec plumbing: validate, verify, classify, discover, send
lib/feed.ts            RSS / Atom / JSON Feed builders
lib/content.ts         post-type discovery, slugs, safe rendering
lib/db.ts              posts in SQLite (node:sqlite)
routes/webmention.ts   the endpoint (202-and-verify, per spec)
routes/admin.stator    the desk: compose, moderate, outbox
tests/                 spec parsing seams, machine workflows, and a wire test
                       where the blog webmentions ITSELF over a real port
```

Not in this cut, deliberately: Micropub + media endpoint and the IndieAuth provider are the second PR of this starter. Mention updates/deletes, automatic outbox retries with backoff, and a full mf2 parser are documented limits — each one is logged as evidence in the paper-cut log.
