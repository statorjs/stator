# registration — design direction

A front-desk ledger: warm paper ground, a single card for the form, a ruled list for the roster. The look should read as "clipboard at the door", not as a dashboard.

- **Palette**: warm off-white paper, near-black ink, one deep teal accent (also the "ok" color), a dried-red for errors and sold-out. Tokens only in `static/app.css`; every component styles itself scoped.
- **Type**: system sans for content; the monospace small-caps label voice (uppercase, letterspaced) for field labels, section headers, and the seat counter — the "ledger stamp" register.
- **Form**: one column, label-over-input, an always-reserved error line under each field (no layout shift when a message appears), tickets as a plain select, consent as a plain checkbox. The refusal line sits with the submit button — it's the desk speaking, not a field.
- **Roster**: ruled rows, no card chrome. Name strong, email faint, ticket as a stamped pill (vip picks up the accent), the seats editor inline, removal a quiet × that only turns red on hover.
- **Live signals**: the seats-left counter and SOLD OUT flag in the header do the drama; rows appearing/disappearing across windows is the demo.

No prototype page — the form itself is the visual spec, and the bar is guide-conformance: scoped styles, element/attribute selectors, near-zero classes.
