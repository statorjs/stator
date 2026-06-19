/**
 * The `.stator` compiler. A pure, bundler-agnostic source-to-source transform:
 * a `.stator` file in, the `.ts` modules the existing runtime already consumes
 * out. No Vite imports here — the Vite plugin (`@statorjs/stator/vite`) is a thin
 * adapter over this surface.
 *
 * See spec: stator-compiler-and-vite-plugin-implementation-plan.
 */
export { splitStator } from './split.ts'
export type { ParsedStator } from './split.ts'
export { lowerTemplate, CompileError } from './lower.ts'
