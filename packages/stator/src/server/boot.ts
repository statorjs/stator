import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import type { StatorConfigData } from './context.ts'
import type { ModuleLoader } from './discovery.ts'

// A global-registry symbol so the brand survives the dev dual-instance: the app's
// `boot.ts` is loaded through Vite while the framework checks it from the native
// module instance — `Symbol.for` resolves to the same symbol in both.
const BOOT_BRAND = Symbol.for('stator.boot.definition')

/**
 * What a boot hook receives. Deliberately narrow: boot is a *source*, not a
 * controller. It supplies events to the app-machine graph and reads config —
 * policy (when/whether/how to act) belongs in the machine chart (a guard can
 * debounce a `TICK`), not in this closure.
 *
 * Not exposed on purpose: `listen`/`fetch` (self-request foot-guns), the raw
 * Hono app (that's `StatorApp.hono`'s break-glass), and the store (reaching
 * around machines). Env is ambient — read `process.env` directly (`.env` is
 * loaded before boot runs).
 */
export interface BootContext {
  /** Feed an event into an APP-lifecycle machine — the bound `dispatchToApp`.
   *  Boot has no session, so it operates on the app plane only. */
  dispatchToApp<D extends AnyMachineDef>(
    machine: D,
    event: EventOf<D>,
  ): Promise<{ committed: boolean }>
  /** Curated framework config (the same view middleware sees via `stator(c)`):
   *  `origin`, `trustedOrigins`, `sameSite`, `cors`. No adapters or secret. */
  readonly config: StatorConfigData
}

/** Cleanup run on graceful shutdown — clear a poll interval, unsubscribe a
 *  source. Return it from the boot function; the framework composes it into the
 *  SIGTERM/SIGINT handler. */
export type BootTeardown = () => void | Promise<void>

/** A boot function: runs once when the server starts serving. May be async, and
 *  may return a teardown. The `void` union is the React-`useEffect` shape — a
 *  hook that MAY return a cleanup — and is required so `defineBoot(() => {…})`
 *  with no return typechecks (`() => void` isn't assignable to `undefined`). */
// biome-ignore lint/suspicious/noConfusingVoidType: intentional useEffect-style optional-teardown return
export type BootFn = (ctx: BootContext) => void | BootTeardown | Promise<void | BootTeardown>

/** The value an app's `boot.ts` exports (default). Opaque — build it with
 *  `defineBoot`. */
export interface BootDefinition {
  readonly [BOOT_BRAND]: true
  readonly run: BootFn
}

/** Type guard for a discovered `boot.ts` default export. */
export function isBootDefinition(value: unknown): value is BootDefinition {
  return typeof value === 'object' && value !== null && BOOT_BRAND in value
}

/**
 * Define code that runs once when the server starts serving — the home for a
 * long-lived inbound source: query config at boot, start a poll or subscription
 * that dispatches events into the app-machine graph. Export the result as the
 * default from `boot.ts` at the app root.
 *
 * Runs once per process (a dev restart re-runs it; an in-process rebuild does
 * not). Return a teardown to clean up on shutdown.
 *
 * ```ts
 * // boot.ts
 * export default defineBoot(async ({ dispatchToApp }) => {
 *   const timer = setInterval(
 *     () => dispatchToApp(FleetMachine, { type: 'TICK', data: await poll() }),
 *     30_000,
 *   )
 *   return () => clearInterval(timer)
 * })
 * ```
 */
export function defineBoot(run: BootFn): BootDefinition {
  return { [BOOT_BRAND]: true, run }
}

const nativeLoader: ModuleLoader = (file) => import(/* @vite-ignore */ pathToFileURL(file).href)

/**
 * Load an app's `boot.ts` (if present) and validate its default export. Returns
 * `undefined` when there's no file. `loader` is injected so dev goes through
 * Vite; prod/native uses `import` — the same single toolchain touch-point as
 * `discoverMiddleware`.
 */
export async function discoverBoot(
  file: string,
  loader: ModuleLoader = nativeLoader,
): Promise<BootDefinition | undefined> {
  if (!existsSync(file)) return undefined
  const mod = await loader(file)
  const def = (mod as { default?: unknown }).default
  if (!isBootDefinition(def)) {
    throw new Error(`${file} must \`export default defineBoot((ctx) => { ... })\``)
  }
  return def
}

/**
 * Run a discovered boot definition and return its teardown (if any). Called from
 * `listen()` — once the server is up — so boot never fires during tests that use
 * `app.fetch` without listening.
 */
export async function runBoot(
  def: BootDefinition | undefined,
  ctx: BootContext,
): Promise<BootTeardown | undefined> {
  if (!def) return undefined
  const result = await def.run(ctx)
  return typeof result === 'function' ? result : undefined
}
