---
"@statorjs/stator": minor
---

`/__events` accepts an event only when the page it names offers it. The wire used to accept any event the target machine handled unless the machine listed it `serverOnly`, so an effect's completion or a timer's event could be posted from a browser: in the desksmith example a forged `CHARGE_OK` turned a declined card into an order.

What a page offers is read from source: every event type sent by `machine.send({ type })` in a template or fence, or by `dispatch(Machine, { type })` in an island's script, across everything the route can render. The list is static, so an event inside an inactive `when` arm, a `defer` section or an unrendered row counts, and a late click is never refused. An event no UI sends is refused with a 403. The dev server and `createApp` read the list from source; `stator build` writes it into `stator-manifest.json` for `stator start`.

What changes for an app:

- A test that posts to `/__events` must name a route whose page sends that event. Posting `ADD` under the cart page when only the product page sends it is now a 403.
- An event sent with a computed type (`{ type: kind }`) cannot be listed. The page stays open, accepting every handled event as before, and `stator check` warns with the line.
- `events: { gate: 'warn' }` in `stator.config.ts` logs what would be refused and accepts it; `'off'` disables the check.

The list is by event type and the same for every visitor. It is not authorization: guards still decide whether a visitor may commit an event their page offers. `serverOnly` remains, as the explicit list on top.
