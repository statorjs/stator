/**
 * The Volar language plugin for `.stator` files. It adapts the compiler's
 * framework-neutral virtual-code emit (`toVirtualCode`) into Volar's virtual
 * codes + `CodeMapping`s, so Volar can federate the TypeScript and CSS language
 * services over the right regions with correct source mapping.
 *
 * All `.stator` syntax knowledge lives in the compiler; this file is purely the
 * Volar adapter (mapping-shape translation + which embedded code is the TS
 * script). Keeping the split means the language server and the runtime compiler
 * never disagree about the file.
 *
 * What the editor shows about Stator's API follows the PROJECT's installed
 * release, not this bundle: the `Stator` macros are typed from the project's
 * `@statorjs/stator/editor` whenever it exports one (see `ambientFor`), the
 * way machine and template types already resolve from the project. The
 * bundled compiler supplies only the file's structure (regions, lowering to
 * virtual TSX), which must stay tolerant of every supported release.
 */

import { type AmbientSource, toVirtualCode, type VirtualMapping } from '@statorjs/stator/compiler'
import type { CodeMapping, LanguagePlugin, VirtualCode } from '@volar/language-core'
import { forEachEmbeddedCode } from '@volar/language-core'
// Activates the `typescript` field on LanguagePlugin (module augmentation).
import type {} from '@volar/typescript'
import type { IScriptSnapshot } from 'typescript'
import type { URI } from 'vscode-uri'
import { findProjectStator } from './project-stator.ts'

const TSX_SCRIPT_KIND = 4 // ts.ScriptKind.TSX
const DEFERRED_SCRIPT_KIND = 7 // ts.ScriptKind.Deferred

/** Feature flags for a fully-serviced region. */
const FULL: CodeMapping['data'] = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
  format: false,
}

export const statorLanguagePlugin: LanguagePlugin<URI, StatorVirtualCode> = {
  getLanguageId(uri) {
    if (uri.path.endsWith('.stator')) return 'stator'
    return undefined
  },
  createVirtualCode(uri, languageId, snapshot) {
    if (languageId !== 'stator') return undefined
    return new StatorVirtualCode(snapshot, ambientFor(uri))
  },
  updateVirtualCode(uri, code, snapshot) {
    code.update(snapshot, ambientFor(uri))
    return code
  },
  typescript: {
    extraFileExtensions: [
      {
        extension: 'stator',
        isMixedContent: true,
        scriptKind: DEFERRED_SCRIPT_KIND,
      },
    ],
    getServiceScript(root) {
      for (const code of forEachEmbeddedCode(root)) {
        if (code.id === 'tsx') {
          return { code, extension: '.tsx', scriptKind: TSX_SCRIPT_KIND }
        }
      }
      return undefined
    },
  },
}

/** Type the `Stator` macros from the project's install when it speaks the
 *  editor contract, else from the bundled shape of the releases before it. */
export function ambientFor(uri: URI): AmbientSource {
  if (uri.scheme !== 'file') return 'bundled'
  return findProjectStator(uri.fsPath)?.editorContract ? 'project' : 'bundled'
}

export class StatorVirtualCode implements VirtualCode {
  id = 'root'
  languageId = 'stator'
  snapshot: IScriptSnapshot
  // TS/CSS features are served by the embedded codes' mappings. The root
  // itself carries one identity mapping with `verification` only, which makes
  // it visible to the stator diagnostics service (full source, positions
  // passing through 1:1) without inviting TS/CSS features onto it.
  mappings: CodeMapping[] = []
  embeddedCodes: VirtualCode[] = []

  constructor(snapshot: IScriptSnapshot, ambient: AmbientSource = 'bundled') {
    this.snapshot = snapshot
    this.update(snapshot, ambient)
  }

  update(snapshot: IScriptSnapshot, ambient: AmbientSource = 'bundled'): void {
    this.snapshot = snapshot
    const text = snapshot.getText(0, snapshot.getLength())
    this.mappings = [
      {
        sourceOffsets: [0],
        generatedOffsets: [0],
        lengths: [text.length],
        data: {
          verification: true,
          completion: false,
          semantic: false,
          navigation: false,
          structure: false,
          format: false,
        },
      },
    ]
    const vc = toVirtualCode(text, { ambient })
    this.embeddedCodes = [
      embed('tsx', 'typescriptreact', vc.tsx.code, vc.tsx.mappings),
      ...vc.styles.map((s, i) => embed(`css_${i}`, 'css', s.code, s.mappings)),
    ]
  }
}

function embed(
  id: string,
  languageId: string,
  code: string,
  mappings: VirtualMapping[],
): VirtualCode {
  return {
    id,
    languageId,
    snapshot: stringSnapshot(code),
    mappings: [
      {
        sourceOffsets: mappings.map((m) => m.sourceOffset),
        generatedOffsets: mappings.map((m) => m.generatedOffset),
        lengths: mappings.map((m) => m.length),
        data: FULL,
      },
    ],
    embeddedCodes: [],
  }
}

function stringSnapshot(text: string): IScriptSnapshot {
  return {
    getText: (start, end) => text.slice(start, end),
    getLength: () => text.length,
    getChangeRange: () => undefined,
  }
}
