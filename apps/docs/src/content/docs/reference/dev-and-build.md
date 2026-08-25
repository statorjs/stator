---
title: "dev & build"
description: "createDevApp for development, buildApp + loadProductionHead + syncTypes for shipping."
sidebar:
  order: 6
---

Two subpaths, one lifecycle: `@statorjs/stator/dev` runs your app during development; `@statorjs/stator/build` compiles it for production. Most apps reach these through the [`stator` CLI](/introduction/installation/#the-cli) (`stator dev`/`build`/`start`) rather than calling them directly — the functions below underlie the CLI and are exported for custom tooling and test isolation.

## createDevApp

```ts
function createDevApp(config: DevAppConfig): Promise<DevApp>

interface DevAppConfig {
  root: string             // the app directory (must reach node_modules)
  machinesDir: string
  routesDir: string
  staticDir?: string
  persistence?: {
    session?: Store
    app?: AppStore         // persistence for `persist: true` app machines
  }
  sessions?: { ttlSeconds?: number }
  dev?: { inspector?: boolean }  // dev inspector toolbar; default true
  logging?: { level?: LogLevel } // default info in dev; LOG_LEVEL wins
}

interface DevApp {
  fetch(request: Request): Response | Promise<Response>
  vite: ViteDevServer | undefined  // deprecated — see below
  dispatchToApp(machine: MachineDef, event: EventOf<typeof machine>): Promise<{ committed: boolean }>
  listen(port: number): Promise<void>
  close(): Promise<void>
}
```

The dev server. Your app runs natively from its **source tree**, exactly as `stator start` runs a build: `.stator` files compile on import (in Node's module loader), machines, routes, and middleware are discovered from their real paths, and islands are bundled behind the same seam the production build uses — served from memory on the production URLs with the production `<head>` shape. There is no bundler in the server path, so dev and prod share one module graph and one compile path, and `import.meta.url`-relative paths in app code (a SQLite file, a data dir) mean the same thing in both.

On a source change the server recompiles what changed and re-evaluates exactly the changed modules and their transitive importers — everything else keeps its module instance, so a `lib/db.ts` that opens a connection at top level runs once per session, not once per edit — then reloads connected browsers over a small SSE channel. A failed rebuild keeps the last good graph serving and shows the compile error, with its code frame, in a full-screen overlay.

Sourcemaps work on both planes: the CLI opts the process into Node's sourcemap application, so server stack traces resolve to your TS source (a `.stator` frame resolves to its compiled server module), and dev island bundles carry inline maps so browser devtools show island source. Production island bundles ship unmapped.

Session state is governed by the same rule as production: a machine whose code changed starts fresh on its next request (its snapshot carries the hash of the code that wrote it — see [What survives a deploy](/guides/persistence/#what-survives-a-deploy)); everything else keeps its state, cart contents and all. Nothing clears your store on a save.

**Transitional:** `STATOR_VITE_DEV=1` boots the previous Vite-embedded dev server instead, kept for one minor as an escape hatch — if something forces you onto it, please open an issue. `DevApp.vite` is deprecated: it is `undefined` on the native dev server (with a one-time warning) and will be removed in the next major; under the escape hatch it is still the real `ViteDevServer`.

The **inspector toolbar** is injected by default (`dev: { inspector: false }` disables it): a drawer that shows the wire itself — one row per outgoing event (↑) and incoming patch envelope (↓), including patches arriving over a live route's SSE channel with their apply time. It's the fastest way to see exactly which slots a dispatch touched. Production apps can opt in with `dev: { inspector: true }` on [`createApp`](/reference/server/#createapp) — demo sites want the wire visible.

If the requested port is taken, the dev server shifts to the next free one (and probes a free HMR websocket port) instead of failing — two Stator apps run side by side without ceremony. Production `listen` fails with a one-line message instead; an operator wants the collision, not a silent shift.

`dispatchToApp` is the dev counterpart of [`StatorApp.dispatchToApp`](/reference/server/#dispatchtoapp): it follows the current store across rebuilds, so SSE fan-out reaches live connections. Prefer it (or `boot.ts`'s `ctx.dispatchToApp`) over importing the standalone `dispatchToApp` — the dev server rebuilds its store on machine edits, and the standalone form doesn't follow it.

## buildApp

```ts
function buildApp(config: BuildConfig): Promise<BuildResult>

interface BuildConfig {
  root: string     // app directory containing machines/ routes/ templates/ static/
  outDir: string   // wiped and recreated
  dirs?: string[]  // defaults to the four conventional dirs
}

interface BuildResult {
  outDir: string
  compiled: number  // .stator files compiled
  hasCss: boolean   // components.css written
  islands: number   // client components bundled
  machines: number  // machines hashed for the snapshot hydration policy
  machineHashMs: number
  resetMachines?: string[]  // machine files whose hash changed since the previous
                            // build's manifest — their sessions reset on deploy
}
```

The production build: compiles the app to a `dist/` of plain `.ts` that `createApp` + tsx serve with **no Vite at runtime**. It copies the app dirs, compiles each `*.stator` to a sibling `*.stator.ts`, rewrites `.stator` import specifiers, and concatenates scoped CSS into `dist/static/components.css`. When the app has client components, every island entry is bundled in one Vite build (hashed assets, server-machine imports stubbed to `{ name }`) and `dist/stator-manifest.json` maps each route file to the island script URLs it reaches:

```ts
interface StatorManifest {
  islands: Record<string, string>   // island .stator path → script URL
  routes: Record<string, string[]>  // route file → script URLs it reaches
  machines: Record<string, string>  // machine file (relative to machines/) → code hash
}
```

Every machine is hashed in one esbuild pass — the machine file and every module it reaches, bundled in memory and never written — and the build **fails** if a machine's closure can't be bundled, so an import problem surfaces here rather than at a production boot. `stator build` prints the hashing time and, when a previous manifest exists, which machines' sessions this build resets.

Vite is imported lazily — a server-only app never needs it at build time.

## loadProductionHead

```ts
function loadProductionHead(
  distDir: string,
): Promise<{
  headExtras: (filePath: string) => string
  buildId?: string
  machines?: Record<string, string>
}>
```

Reads a built `dist/`'s manifest and returns two things for `createApp`: `headExtras` (links `components.css` when the build produced one and injects each route's island `<script type="module">` tags) and `buildId` (the per-build id for the deploy-aware [reload handshake](/guides/realtime-sse/)):

```ts
const { headExtras, buildId, machines } = await loadProductionHead('dist')
const app = await createApp({ ...dirs, headExtras, buildId, machineHashes: machines })
```

`machines` is the manifest's code hashes; passed as `machineHashes`, `createApp` hydrates against what was built, and a machine with no entry is a boot error rather than a silent reset. Omit it (a dist built before hashes existed, a hand-rolled entry) and machines are hashed live at boot.

Both artifacts are optional — a server-only app without styles gets an empty hook.

## syncTypes

```ts
function syncTypes(root: string): Promise<SyncResult>  // { written, outDir }
```

Type sync for editors and `tsc`: generates a `.d.ts` per component so `import X from './x.stator'` is typed against the component's real props. Generated files live in a framework-managed `.stator/types/` directory that mirrors the source tree (gitignored — the `.astro/`/`.svelte-kit/` convention); your tsconfig's `rootDirs: ['.', '.stator/types']` merges the two trees. Route pages are skipped — they export a route, not a render function.
