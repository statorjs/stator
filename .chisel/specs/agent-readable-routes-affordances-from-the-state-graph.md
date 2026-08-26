---
title: 'Agent-readable routes: affordances from the state graph'
status: draft
created: 2026-08-25
updated: 2026-08-25
area: server
---

## What and Why

The idea (2026-08-25): an LLM/agent-facing representation of any page — the page's data, type schemas, and the currently-valid actions — served alongside the HTML. Structurally this is hypermedia affordances (HATEOAS), which historically failed because no framework could *know* the affordances: actions in other stacks are opaque imperative fetch calls, so affordance documents were hand-authored and drifted. Stator inverts that, and the claim worth recording is:

**Affordances that are never stale, because they are derived from the compiled state graph and evaluated against live guards.**

- **Content** — routes declare which machines they read (`reads` in the compiled route module); the page's data *is* the selector outputs. Serialize reads, not rendered HTML and not raw context.
- **Actions** — the machine's current state's `on:` table, filtered by `serverOnly`, with `when` guards evaluated against live context, yields "currently valid actions" true by construction. The template's dispatch sites are a secondary refinement (which affordances the page surfaces to a *human*), not the source.
- **Schemas** — event payload and selector return types are TS types; a build-time pass can emit JSON Schema for them into the manifest. This is the one genuinely new cost (the event union is erased at runtime — see the introspection substrate).
- **Acting** — an agent POSTs events through the existing wire: same session cookie, same guards, same `serverOnly` admission, same idempotency. The endpoint adds **zero new capability**; it only describes what the page already permits. That is the entire security story.

## Design decisions (recorded from the 2026-08-25 assessment)

- **No user-agent sniffing.** UA detection is fragile, adversarial, and cloaking-adjacent. Discovery via content negotiation (`Accept:`) and/or the existing extension convention (`defineApiRoute`'s `rss.xml.ts` → `/rss.xml` pattern), advertised with `<link rel="alternate">` in the HTML head plus `llms.txt`.
- **Serialize reads, not context.** Raw machine context can hold fields no template shows. The HTML page's exposure boundary is selector outputs; the agent view must have the same boundary or it is a data leak.
- **The envelope format is the least important decision.** LLMs parse XML well, but the value is affordances + schemas. Embed JSON Schema rather than generating XSD. Offering both XML and JSON envelopes is cheap once the payload exists.
- **Graceful degradation on the dynamic tail.** Computed events, island-originated dispatches, and form-derived payloads won't all fall out of static template extraction. The machine-level event union (from build-time types) is complete; template extraction is a "featured actions" hint on top.
- **MCP adjacency.** The same derived data could back an auto-generated per-app MCP server — likely the version with a real consumer ecosystem. The in-band HTTP representation and the MCP surface are two skins over one payload; do not build the payload twice.

## Evidence gate (not scheduled until this passes)

Per the evidence-before-primitives discipline: this is a primitive with no paper-cut log behind it, and the historical failure mode of hypermedia was adoption, not format. The forcing function is cheap and defined:

**The Desksmith agent experiment**: point a coding agent at Desksmith through a prototype endpoint and have it complete "add to cart → checkout" — measured against the same agent DOM-driving the same flow. Ship only if the endpoint shows a clear win in steps, tokens, or reliability. If the experiment doesn't show the win, the idea doesn't earn the surface.

## Prerequisites

- The runtime introspection substrate — `describeMachine` + the dev inspect route (see `machine-state-inspection-describe-dev-inspect-route-toolbar-state-view`, in progress). Ships independently for devtools; this spec consumes it.
- Build-time schema extraction (event payloads, selector returns → JSON Schema) — the genuinely new work, shared with the introspection manifest when that promotes.
- Guard evaluation against live context on a read-only path (guards are pure `(ctx, ev) => boolean`; needs an event-shaped probe or a guard-arity convention — open question below).

## Open questions

- Guard probing: `when(ctx, ev)` needs an event to evaluate; for affordance-listing, is guard presence enough (report "conditional"), or do we evaluate guards that ignore their event argument? Start with presence + a `conditional` flag; never fake an event.
- Parity question: should the agent see all client-dispatchable events for the route's machines (wire parity — the wire accepts any non-`serverOnly` event today), or only events the template renders a control for (human parity)? Wire parity is honest about what's possible; human parity is what "act as a user" means. Probably both, labeled.
- Prompt-injection caveat: page data includes user-authored content; the envelope should carry a standard warning marker so consuming agents can treat data fields as untrusted.
- Session bootstrap for agents: cookie flow works but is clunky for CLI agents; consider honoring the existing claims/identity primitives rather than inventing an agent-auth path.

## Alternatives Considered

- **UA-sniffed dual serving** — rejected (fragile, cloaking-adjacent; see design decisions).
- **Rendered-HTML-to-XML transformation** — rejected: loses the typed data/action structure that is the entire point; agents can already read HTML.
- **Standalone MCP server generator first** — deferred, not rejected: it is the same payload with a different transport, and the experiment should tell us which skin the consumer actually wants.
