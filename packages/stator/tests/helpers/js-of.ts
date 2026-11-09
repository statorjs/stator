import ts from 'typescript'

/** A compiled client module as plain JS, for evaluating with `new Function`:
 *  the emitted module is TypeScript (its wiring carries type assertions). */
export function jsOf(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText
}
