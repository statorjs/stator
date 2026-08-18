---
"@statorjs/stator": minor
---

`.env` file loading. Stator now loads `.env` files into `process.env` at startup, so server config and secrets (a store URL, an auth provider secret, `LOG_LEVEL`, `PORT`) have a uniform home across dev and prod — no more relying on the shell to export them, and no `import.meta.env` (which is Vite-transform-time and absent in production).

Precedence, highest first: **real shell env → `.env.local` → `.env`**. Commit `.env` for defaults; keep machine-local secrets in `.env.local` (gitignored). A real environment variable always wins, so production secrets injected by the host are never shadowed by a stray file.

Loaded by `createApp`/`createDevApp` (covering a hand-written `server.ts`) and by the `stator` CLI *before* it imports `stator.config.ts` (so your config file can read `process.env.*`). Uses Node's native `process.loadEnvFile` — no new dependency. Absent files are skipped.

Scaffold templates now gitignore `.env.local` / `.env*.local`.
