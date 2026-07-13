# Plimsoll — the Stator reference app

The live demo at [demo.statorjs.dev](https://demo.statorjs.dev): a
storefront exercising the full 1.0 surface — keyed lists with `bind:`,
session effects (fake payments with declines + idempotency), persisted
shared inventory with app-plane restock effects, live stock over SSE, a
gateway-guarded admin, and the production build/deploy path (`DEPLOY.md`).

This is a **reference app, not a starter** — it's ~2k lines of deliberate
opinions. Read it to see how the pieces compose at scale; start projects
from `create-stator`'s templates instead. That said, if you want to gut it:

```sh
pnpm create stator my-store --template github:statorjs/stator/apps/store
```

(Any repo path works as a template — this one just happens to be deployed.)
