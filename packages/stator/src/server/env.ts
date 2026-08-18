import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load `.env` files into `process.env` — the home for server config/secrets
 * that's uniform across dev and prod (unlike Vite's transform-time
 * `import.meta.env`, absent in prod). Precedence, highest first:
 *
 *   real shell env  >  .env.local  >  .env
 *
 * `process.loadEnvFile` (native, Node ≥20.12 — no dependency) never overrides
 * an already-set key, so real env always wins, and `.env.local` is loaded
 * *before* `.env`: the earlier load claims a key the later one can't reclaim.
 * Absent files are skipped. Idempotent-safe — a second call adds nothing new,
 * so the CLI (which loads before importing `stator.config.ts`) and
 * `createApp`/`createDevApp` (which load for the direct `server.ts` path) can
 * both call it without conflict.
 *
 * `.env.local` is for machine-local secrets and belongs in `.gitignore`; `.env`
 * holds committed defaults.
 */
export function loadDotenv(root: string = process.cwd()): void {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(root, name)
    if (existsSync(path)) process.loadEnvFile(path)
  }
}
