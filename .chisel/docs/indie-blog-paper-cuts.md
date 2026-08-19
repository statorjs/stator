# indie-blog starter — paper-cut log

Evidence artifact, registration-playbook style: friction found while building IndieWeb protocols on the minimal surface, feeding four open threads — collections-of-workflows recurrence, origin-trust, the npm-distribution seam (phase 2), and per-record timers.

Format: what happened → what it cost → what would help. Dated; append as found.

---

## 1. Per-record retry backoff wants per-record timers (2026-08-10, build)

The outbox's failed sends retry only by owner button. Automatic backoff per entry needs a timer per record — `after` is per-STATE, and the machine has one state for all entries. This is collections-of-workflows recurrence #2 (mention verification is occurrence #1 in the same app): the per-record statechart design now has the second real app the revisit trigger asked for.

## 2. Anonymous ingress rides a session gateway (2026-08-10, build) — WORKS, with a wrinkle

The webmention endpoint serves strangers, so RECEIVE lands in a throwaway session machine whose guard is the spec validation, and the app machine subscribes to its emit. It works and reads well — but every anonymous POST mints a session that exists only to carry one guarded emit. Origin-trust evidence: a server-only event ("this route, not the wire") would express this directly, without the ceremony session.

## 3. `<time datetime>` was untyped (2026-08-10, build) — FIXED IN-PR

`ElementSpecificAttributes` had no `time` entry, so the h-entry's `dt-published` timestamp was a compile error. First microformats-shaped app found it within minutes. Added upstream with this starter.

## 4. `raw` must be imported and the error doesn't say so (2026-08-10, build)

`raw()` is deliberately not a template global (authors import it — good rule), but the failure is a bare `Cannot find name 'raw'` from the check file. A located "import raw from @statorjs/stator/template" hint would turn a head-scratch into a fix. Docs/diagnostic polish, not surface.

## 5. The self-webmention wire test needed a real port (2026-08-10, build) — GOOD

Verification effects fetch over real HTTP, so the wire test listens on a port and the blog webmentions itself: post B links to post A, the endpoint 202s, the effect fetches B's live page, the mention flows through moderation to A's page. `DevApp.listen` + effects made a no-mock full-protocol test in ~30 lines — this is the pattern collections apps should copy.

## 6. Deferred by decision, logged for the next cut (2026-08-10)

Mention updates/deletes (the spec allows re-sent mentions to modify earlier ones — the starter dedupes), a real mf2 parser (classification is regex-lite), and re-verification timers. None blocked the loop; all are good second-PR material alongside Micropub and the IndieAuth provider.
