---
"create-stator": minor
---

The weather example joins the template menu (`--template weather`): live forecasts over SSE, entry-effect data loading, and a canvas island. Scaffolded apps now pin `@statorjs/stator@^1.4.0`. Also fixes the desksmith and live-poll templates, which scaffolded broken — a fresh app's `pnpm dev` crashed on the undeclared `vite` peer, and typecheck failed on a tsconfig `extends` that only resolves inside the monorepo. All menu templates now carry self-contained tsconfigs and declare `vite`/`pino-pretty` like minimal and todomvc.
