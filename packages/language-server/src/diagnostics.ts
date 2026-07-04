/**
 * Stator semantic diagnostics: run the REAL compiler over the `.stator`
 * source and surface its `CompileError`s as editor squiggles — so the editor
 * and the Vite build can never disagree about what's valid. (The TS and CSS
 * services cover their regions; this covers Stator's own rules: directive
 * misuse, client-component name matching, frontmatter capabilities, spread,
 * malformed templates.)
 *
 * The service runs against the ROOT virtual code (languageId `stator`, full
 * source text, identity-mapped back to the file — see language-plugin.ts),
 * so positions pass through 1:1.
 */

import { CompileError, compile } from '@statorjs/stator/compiler'
import type { Diagnostic, LanguageServicePlugin } from '@volar/language-server'
import { URI } from 'vscode-uri'

const ROUTE_PATH_RE = /[\\/]routes[\\/].*\.stator$/

/** Pure core, unit-tested directly: compile and translate the failure. */
export function statorDiagnostics(text: string, filePath: string): Diagnostic[] {
  const kind = ROUTE_PATH_RE.test(filePath) ? 'route' : 'component'
  try {
    compile(text, { id: filePath, kind })
    return []
  } catch (err) {
    if (err instanceof CompileError) {
      // CompileError carries a 1-based line/column into the original source;
      // LSP positions are 0-based. Errors without a location anchor at 0:0.
      const line = (err.loc?.line ?? 1) - 1
      const character = (err.loc?.column ?? 1) - 1
      return [
        {
          range: { start: { line, character }, end: { line, character: character + 1 } },
          message: err.message,
          severity: 1, // Error
          source: 'stator',
        },
      ]
    }
    // Non-CompileError throws are compiler bugs — still show them rather
    // than swallowing, anchored at the top of the file.
    return [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: `stator: internal compiler error — ${String(err)}`,
        severity: 1,
        source: 'stator',
      },
    ]
  }
}

export function createStatorDiagnosticsService(): LanguageServicePlugin {
  return {
    name: 'stator-diagnostics',
    capabilities: {
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
    create(context) {
      return {
        provideDiagnostics(document) {
          if (document.languageId !== 'stator') return
          const uri = URI.parse(document.uri)
          const decoded = context.decodeEmbeddedDocumentUri(uri)
          const path = decoded ? decoded[0].fsPath : uri.fsPath
          return statorDiagnostics(document.getText(), path)
        },
      }
    },
  }
}
