/**
 * The `.stator` compiler. A pure, bundler-agnostic source-to-source transform:
 * a `.stator` file in, the `.ts` modules the existing runtime already consumes
 * out. No Vite imports here — the Vite plugin (`@statorjs/stator/vite`) is a thin
 * adapter over this surface.
 *
 * See spec: stator-compiler-and-vite-plugin-implementation-plan.
 */

export type { EmitClientInput } from './client-emit.ts'
export { emitClientModule, rewriteMembers } from './client-emit.ts'
export type {
  ClientAnalysis,
  ClientDirective,
  ClientElement,
  ScriptClass,
} from './client-script.ts'
export {
  analyzeClient,
  analyzeScriptClasses,
  inferDeps,
  isCustomElementTag,
  kebabToPascal,
  pascalToKebab,
} from './client-script.ts'
export type { CompileOptions, CompileResult } from './compile.ts'
export { compile } from './compile.ts'
export type { DiagnosticLocation } from './diagnostics.ts'
export {
  CompileError,
  codeFrame,
  locAt,
  offsetToLineCol,
} from './diagnostics.ts'
export { generateDts } from './dts.ts'
export { scopeHash } from './hash.ts'
export type { LowerMeta, LowerOptions } from './lower.ts'
export { lowerTemplate } from './lower.ts'
export { componentImportSpecifier, declaredRegions } from './regions.ts'
export type { ParsedStator, ScannedRegions, SourceRegion } from './split.ts'
export { scanRegions, splitStator } from './split.ts'
export { scopeCss } from './styles.ts'
export type {
  VirtualCodeResult,
  VirtualFile,
  VirtualMapping,
} from './virtual-code.ts'
export { toVirtualCode } from './virtual-code.ts'
