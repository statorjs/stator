---
title: "dev & build"
description: "createDevApp for development, buildApp + loadProductionHead + syncTypes for shipping."
sidebar:
  order: 6
---

Two subpaths, one lifecycle: `@statorjs/stator/dev` runs your app during development; `@statorjs/stator/build` compiles it for production.

## createDevApp

```ts
function createDevApp(config: DevAppConfig): Promise<DevApp>

interface DevAppConfig {
  root: string             // Vite root — the app directory
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
  vite: ViteDevServer
  dispatchToApp(machine: MachineDef, event: EventOf<typeof machine>): Promise<{ committed: boolean }>
  listen(port: number): Promise<void>
  close(): Promise<void>
}
```

The dev server. Embeds Vite in middleware mode so `.stator` and TS modules compile on the way in, loads machines, routes, and the framework runtime itself through `vite.ssrLoadModule` (one shared module instance — the same pattern Astro and SvelteKit use), and injects each route's scoped component CSS and island scripts into `<head>` at render time.

On a relevant source change it re-discovers, rebuilds, and tells the browser to reload. A template or route edit keeps the store — and your session state, cart contents and all — intact; only a machine edit resets it, since route `reads` bind to machine defs by identity.

The **inspector toolbar** is injected by default (`dev: { inspector: false }` disables it): a drawer that shows the wire itself — one row per outgoing event (↑) and incoming patch envelope (↓), including patches arriving over a live route's SSE channel with their apply time. It's the fastest way to see exactly which slots a dispatch touched. Production apps can opt in with `dev: { inspector: true }` on [`createApp`](/reference/server/#createapp) — demo sites want the wire visible.

If the requested port is taken, the dev server shifts to the next free one (and probes a free HMR websocket port) instead of failing — two Stator apps run side by side without ceremony. Production `listen` fails with a one-line message instead; an operator wants the collision, not a silent shift.

`dispatchToApp` is the dev counterpart of [`StatorApp.dispatchToApp`](/reference/server/#dispatchtoapp): it follows the current store across rebuilds and runs through the Vite-loaded runtime, so SSE fan-out reaches live connections. Don't import the standalone `dispatchToApp` in dev server code — that's a second module instance whose connection registry is empty, so the dispatch commits but the fan-out reaches nobody.

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
}
```

The production build: compiles the app to a `dist/` of plain `.ts` that `createApp` + tsx serve with **no Vite at runtime**. It copies the app dirs, compiles each `*.stator` to a sibling `*.stator.ts`, rewrites `.stator` import specifiers, and concatenates scoped CSS into `dist/static/components.css`. When the app has client components, every island entry is bundled in one Vite build (hashed assets, server-machine imports stubbed to `{ name }`) and `dist/stator-manifest.json` maps each route file to the island script URLs it reaches:

```ts
interface StatorManifest {
  islands: Record<string, string>   // island .stator path → script URL
  routes: Record<string, string[]>  // route file → script URLs it reaches
}
```

Vite is imported lazily — a server-only app never needs it at build time.

## loadProductionHead

```ts
function loadProductionHead(distDir: string): Promise<(filePath: string) => string>
```

The production `headExtras` for a built `dist/`: links `components.css` when the build produced one and injects each route's island `<script type="module">` tags from the manifest. Pass the result to `createApp`:

```ts
const app = await createApp({ ...dirs, headExtras: await loadProductionHead('dist') })
```

Both artifacts are optional — a server-only app without styles gets an empty hook.

## syncTypes

```ts
function syncTypes(root: string): Promise<SyncResult>  // { written, outDir }
```

Type sync for editors and `tsc`: generates a `.d.ts` per component so `import X from './x.stator'` is typed against the component's real props. Generated files live in a framework-managed `.stator/types/` directory that mirrors the source tree (gitignored — the `.astro/`/`.svelte-kit/` convention); your tsconfig's `rootDirs: ['.', '.stator/types']` merges the two trees. Route pages are skipped — they export a route, not a render function.
