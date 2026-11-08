/**
 * Stator semantic diagnostics: run the REAL compiler over the `.stator`
 * source and surface its `CompileError`s as editor squiggles. This is the
 * compiler BUNDLED with the extension, which may be newer or older than the
 * project's: its rules must stay tolerant of every supported release (a macro
 * renamed in one release is accepted in either spelling here), and the
 * project's own `stator check`/`dev`/`build` is where a removed API fails.
 * Which names are current is the project's types' job (`@statorjs/stator/editor`). (The TS and CSS
 * services cover their regions; this covers Stator's own rules: directive
 * misuse, client-component name matching, frontmatter capabilities, spread,
 * malformed templates.)
 *
 * The service runs against the ROOT virtual code (languageId `stator`, full
 * source text, identity-mapped back to the file — see language-plugin.ts),
 * so positions pass through 1:1.
 */

import { CompileError, compile, compileWarnings } from '@statorjs/stator/compiler'
import type { Diagnostic, LanguageServicePlugin } from '@volar/language-server'
import { URI } from 'vscode-uri'

const ROUTE_PATH_RE = /[\\/]routes[\\/].*\.stator$/

/** Pure core, unit-tested directly: compile and translate the failure, plus
 *  the compiler's warnings. */
export function statorDiagnostics(text: string, filePath: string): Diagnostic[] {
  return [...compileDiagnostics(text, filePath), ...warningDiagnostics(text)]
}

function warningDiagnostics(text: string): Diagnostic[] {
  return compileWarnings(text).map((w) => {
    const line = w.loc.line - 1
    const character = w.loc.column - 1
    return {
      range: { start: { line, character }, end: { line, character: character + 1 } },
      message: w.message,
      severity: 2, // Warning
      source: 'stator',
    }
  })
}

function compileDiagnostics(text: string, filePath: string): Diagnostic[] {
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
