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
 */

import type { CodeMapping, LanguagePlugin, VirtualCode } from '@volar/language-core'
import { forEachEmbeddedCode } from '@volar/language-core'
import type { IScriptSnapshot } from 'typescript'
import type { URI } from 'vscode-uri'
import { toVirtualCode, type VirtualMapping } from '@statorjs/stator/compiler'
// Activates the `typescript` field on LanguagePlugin (module augmentation).
import type {} from '@volar/typescript'

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
  createVirtualCode(_uri, languageId, snapshot) {
    if (languageId !== 'stator') return undefined
    return new StatorVirtualCode(snapshot)
  },
  updateVirtualCode(_uri, code, snapshot) {
    code.update(snapshot)
    return code
  },
  typescript: {
    extraFileExtensions: [
      { extension: 'stator', isMixedContent: true, scriptKind: DEFERRED_SCRIPT_KIND },
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

export class StatorVirtualCode implements VirtualCode {
  id = 'root'
  languageId = 'stator'
  snapshot: IScriptSnapshot
  // The source doc is addressed through the embedded codes' mappings (which map
  // embedded offsets ↔ real .stator offsets), so the root itself needs none.
  mappings: CodeMapping[] = []
  embeddedCodes: VirtualCode[] = []

  constructor(snapshot: IScriptSnapshot) {
    this.snapshot = snapshot
    this.update(snapshot)
  }

  update(snapshot: IScriptSnapshot): void {
    this.snapshot = snapshot
    const text = snapshot.getText(0, snapshot.getLength())
    const vc = toVirtualCode(text)
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
