/** The names the compiler auto-injects into emitted modules — single source
 *  of truth for the emitters (compile.ts, client-emit.ts) AND the language
 *  server (virtual-code.ts), which must inject the same globals in-editor: a
 *  name injected in one place but not the other hides a missing-import bug,
 *  and a name injected that authors also legitimately import collides with
 *  their import (`raw` is NOT a global — authors import it — which is why it
 *  appears in no list here).
 *
 *  Author globals are names template/script authors may write directly;
 *  lowering targets are names only the compiler's output references. */

/** Template names authors write: control flow + display + directive values. */
export const TEMPLATE_AUTHOR_GLOBALS = [
  'read',
  'each',
  'when',
  'match',
  'defer',
  'on',
  'classList',
  'styleList',
] as const

/** Template names only lowered code references. `itemBind` needs server
 *  render state, so it is a SERVER-module target only — client-island shells
 *  never emit it (see lower.ts, keyed-row lowering). */
export const TEMPLATE_LOWERING_TARGETS = ['html', 'itemBind', 'spreadAttrs'] as const

/** Extra lowering targets for a client island's server SHELL module. */
export const ISLAND_SHELL_EXTRAS = ['createHtmlFragment', 'clientShellAttrs'] as const

/** Client-module names island authors write in a `<script>`. */
export const CLIENT_AUTHOR_GLOBALS = [
  'StatorElement',
  'use',
  'machine',
  'defineElement',
  'bind',
  'effect',
  'dispatch',
] as const

/** Client-module names only lowered code references. */
export const CLIENT_LOWERING_TARGETS = ['bindSlot', 'attrValue', 'setAttr'] as const

export function importLine(names: readonly string[], from: string): string {
  return `import { ${names.join(', ')} } from '${from}'`
}
