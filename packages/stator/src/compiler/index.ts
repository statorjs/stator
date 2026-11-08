/**
 * The `.stator` compiler. A pure, bundler-agnostic source-to-source transform:
 * a `.stator` file in, the `.ts` modules the existing runtime already consumes
 * out. The dev server, the build and `build:lib` all compile through this surface.
 *
 * Origin: spec stator-compiler-and-vite-plugin-implementation-plan.
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
  formatCompileError,
  locAt,
  offsetToLineCol,
} from './diagnostics.ts'
export { generateDts } from './dts.ts'
export { scopeHash } from './hash.ts'
export type { LowerMeta, LowerOptions } from './lower.ts'
export { lowerTemplate } from './lower.ts'
export { componentImportSpecifier, declaredRegions, regionResolverFor } from './regions.ts'
export type { ParsedStator, ScannedRegions, SourceRegion } from './split.ts'
export { scanRegions, splitStator } from './split.ts'
export { scopeCss } from './styles.ts'
export type {
  VirtualCodeResult,
  VirtualFile,
  VirtualMapping,
} from './virtual-code.ts'
export { type AmbientSource, toVirtualCode, type VirtualCodeOptions } from './virtual-code.ts'
export type { CompileWarning } from './warnings.ts'
export { compileWarnings } from './warnings.ts'
