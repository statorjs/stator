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
  dispatchToApp(machine: MachineDef, event: EventOf<typeof machine>): Promise<{ committed: boolean }>
  listen(port: number): Promise<void>
  close(): Promise<void>
}
```

The dev server. Your app runs natively from its **source tree**, exactly as `stator start` runs a build: `.stator` files compile on import (in Node's module loader), machines, routes, and middleware are discovered from their real paths, and islands are bundled behind the same seam the production build uses — served from memory on the production URLs with the production `<head>` shape. There is no bundler in the server path, so dev and prod share one module graph and one compile path, and `import.meta.url`-relative paths in app code (a SQLite file, a data dir) mean the same thing in both.

On a source change the server recompiles what changed and re-evaluates exactly the changed modules and their transitive importers — everything else keeps its module instance, so a `lib/db.ts` that opens a connection at top level runs once per session, not once per edit — then reloads connected browsers. A failed rebuild keeps the last good graph serving and shows the compile error, with its code frame, in a full-screen overlay. Those signals ride a page's existing live channel when it has one, and a small dedicated SSE channel when it doesn't — so a `live: true` page in dev holds one event-stream, not two, which matters because the browser's per-origin connection budget is shared across every open tab.

Sourcemaps work on both planes: the CLI opts the process into Node's sourcemap application, so server stack traces resolve to your TS source. A `.stator` file carries its own map from the compiler: frontmatter maps line for line and every template expression and component call maps to where it is written, so a stack frame or an editor breakpoint lands on the `.stator` line in dev and, through the map `stator build` writes into each compiled sibling, in production too. An island maps both halves: its server fence and shell template through the same compiled module, and its `<script>` line for line, with each wiring line (an `on:click` handler, a `read()` slot) mapped to the directive it wires, through the dev island bundle. Dev island bundles carry inline maps so browser devtools show island source. Production island bundles ship unmapped.

Session state is governed by the same rule as production: a machine whose code changed starts fresh on its next request (its snapshot carries the hash of the code that wrote it — see [What survives a deploy](/guides/persistence/#what-survives-a-deploy)); everything else keeps its state, cart contents and all. Nothing clears your store on a save.

Scoped CSS reaches the page the way it does in production: each route links its own stylesheet at the URL `stator build` writes it to, holding only the components that route's imports reach, so a rule that leaks onto another route's markup in production leaks the same way in dev, and one that doesn't, doesn't.

The **inspector toolbar** is injected by default (`dev: { inspector: false }` disables it), with two tabs. **Wire** shows the wire itself — one row per outgoing event (↑) and incoming patch envelope (↓), including patches arriving over a live route's SSE channel with their apply time; it's the fastest way to see exactly which slots a dispatch touched. **Machines** shows the state behind the wire: every machine's current state and context (your own session's, plus app-lifecycle machines — those are process-global and labeled), the events its current state accepts (server-only and guarded ones marked), and each route's `reads`. A machine your session has never touched shows the def's initial context, dimmed; a `stale` chip means the persisted snapshot was written by different machine code, so that session starts fresh on its next request (see [What survives a deploy](/guides/persistence/#what-survives-a-deploy)).

The tab is laid out master-detail — machines listed with their live state (your session's first, then app machines), detail beside — and it cross-links: a route's `reads` chips jump to that machine, a machine's detail lists the routes that read it, and static GET routes are real links to the page. The drawer's top edge drags to resize; height, tab, and selection persist across dev reloads.

The Machines tab is fed by `GET /@stator/inspect`, a dev-server-only endpoint scoped to the caller's own session cookie — handy with `curl` too. Production never serves it: machine context is working state and may hold anything. Production apps can still opt into the toolbar with `dev: { inspector: true }` on [`createApp`](/reference/server/#createapp) — demo sites want the wire visible — and there the Machines tab degrades to a notice.

If the requested port is taken, the dev server shifts to the next free one instead of failing — two Stator apps run side by side without ceremony. Production `listen` fails with a one-line message instead; an operator wants the collision, not a silent shift.

`dispatchToApp` is the dev counterpart of [`StatorApp.dispatchToApp`](/reference/server/#dispatchtoapp): it follows the current store across rebuilds, so SSE fan-out reaches live connections. Prefer it (or `boot.ts`'s `ctx.dispatchToApp`) over importing the standalone `dispatchToApp` — the dev server rebuilds its store on machine edits, and the standalone form doesn't follow it.

## buildApp

```ts
function buildApp(config: BuildConfig): Promise<BuildResult>

interface BuildConfig {
  root: string     // app directory containing machines/ routes/ templates/ static/
  outDir: string   // wiped and recreated
  dirs?: string[]  // defaults to the four conventional dirs
  previousManifest?: string  // a stator-manifest.json to diff machine hashes against
                             // (the last deployed build's) instead of the one in outDir
}

interface BuildResult {
  outDir: string
  compiled: number  // .stator files compiled
  hasCss: boolean   // any route stylesheet written
  islands: number   // client components bundled
  machines: number  // machines hashed for the snapshot hydration policy
  machineHashMs: number
  resetMachines?: string[]  // machine files whose hash changed since the previous
                            // build's manifest — their sessions reset on deploy
  previousManifest?: string // the manifest that diff was computed against; both absent
                            // when there was none to compare with
}
```

The production build: compiles the app to a `dist/` of plain `.ts` that `stator start` serves, and bundles client islands with esbuild. It copies the app dirs, compiles each `*.stator` to a sibling `*.stator.ts`, rewrites relative `.stator` import specifiers, and writes each route's scoped CSS to its own stylesheet under `dist/static/css/`, from the components that route reaches. When the app has client components, or a route reaches one a library ships, every island entry is bundled in one esbuild pass (hashed assets, server-machine imports stubbed to `{ name }`) and `dist/stator-manifest.json` maps each route file to the island script URLs it reaches. The same walk refuses a reached library component compiled for another contract, two islands defining one tag, and a library island dispatching to a machine the app doesn't register (see [Component libraries](/guides/component-libraries/#shipping-islands)):

```ts
interface StatorManifest {
  islands: Record<string, string>   // island .stator path (a library's: @pkg/path/x.stator) → script URL
  routes: Record<string, string[]>  // route file → script URLs it reaches
  machines: Record<string, string>  // machine file (relative to machines/) → code hash
}
```

Every machine is hashed in one esbuild pass — the machine file and every module it reaches, bundled in memory and never written — and the build **fails** if a machine's closure can't be bundled, so an import problem surfaces here rather than at a production boot. `stator build` prints the hashing time and which machines' sessions this build resets, compared against the previous `dist/stator-manifest.json` when one is there. A fresh CI checkout has none, and the build says so (`no previous manifest — cannot say which sessions this deploy resets`) rather than staying silent; to compare against what is actually running, have the pipeline fetch the last deployed manifest and pass it with `stator build --previous <path>` (a path given and not found fails the build). After a deploy, the runtime's own `hydrate` warning is the ground truth: one rate-limited line per machine that starts fresh, naming both hashes.

esbuild is a dependency of the framework, so there is nothing to install for the build; a server-only app with no islands skips the island bundle entirely.

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

Reads a built `dist/`'s manifest and returns two things for `createApp`: `headExtras` (links the route's stylesheet when it has one and injects each route's island `<script type="module">` tags) and `buildId` (the per-build id for the deploy-aware [reload handshake](/guides/realtime-sse/)):

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
