/**
 * Production build for `.stator` apps. Compiles a `.stator` app to a `dist/` of
 * plain `.ts` the runtime serves with no Vite. See `buildApp`.
 */

export type { BuildConfig, BuildResult, StatorManifest } from './build.ts'
export { buildApp } from './build.ts'
export type { CopySet, CopySetOptions, UntracedImport } from './copy-set.ts'
export { resolveCopySet } from './copy-set.ts'
export { loadProductionHead } from './head.ts'
export type {
  BundleIslandsOptions,
  IslandAsset,
  IslandBundle,
  IslandBundler,
  IslandEntry,
} from './islands.ts'
export { bundleIslands, routeIslandMap } from './islands.ts'
export { sourceId } from './source-id.ts'
export type { SyncResult } from './sync.ts'
export { syncTypes } from './sync.ts'
