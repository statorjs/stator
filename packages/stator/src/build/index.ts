/**
 * Production build for `.stator` apps. Compiles a `.stator` app to a `dist/` of
 * plain `.ts` the runtime serves with no Vite. See `buildApp`.
 */
export { buildApp } from './build.ts'
export type { BuildConfig, BuildResult } from './build.ts'
