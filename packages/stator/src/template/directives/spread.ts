import { registerBinding, requireCurrentRenderState } from '../../server/render-context.ts'
import { isUrlAttribute, safeAttrUrl } from '../../wire/safe-url.ts'
import { isItemReadResult } from '../each.ts'
import { isReadResult } from '../read.ts'
import { type DirectiveInvocation, defineDirective, invoke, isDirectiveInvocation } from './core.ts'

/**
 * `{...spread}` on an element — forward a bag of attributes onto it. This is what
 * makes the `HTMLAttributes<Tag>` component pattern practical: a `<Button>` can
 * `<button {...rest} />` instead of hand-forwarding every native attribute.
 *
 * A spread value may be a literal OR a live machine `read(...)` — each read
 * registers the same attribute binding the normal `attr={read(...)}` path does,
 * so it patches on machine events (there is no separate reactive-spread wire).
 * Two value kinds are rejected LOUDLY rather than silently mishandled:
 *   - `read(item, …)` (an item binding) — it's owned by its each() row and can't
 *     ride through a spread; bind it directly on the element. Mirrors the
 *     class:list / style:list item-read rule (deferred util, see spread.test).
 *   - a directive invocation (a `classList()` / `on()` result) — a directive owns
 *     a whole attribute and isn't a plain value.
 *
 * Boolean/url semantics match the literal attr path (see html.ts handleRead):
 * false / null / undefined ⇒ the attribute is ABSENT, true ⇒ present-and-empty,
 * anything else stringifies; url-bearing names (href/src/…) get the scheme guard.
 */
export type SpreadAttrs = Record<string, unknown>

const spreadDirective = defineDirective<SpreadAttrs>({
  name: 'spread',
  apply({ elementId, arg, addAttribute }) {
    if (arg == null) return
    const state = requireCurrentRenderState()
    for (const [name, value] of Object.entries(arg)) {
      if (isItemReadResult(value)) {
        throw new Error(
          `stator: read(item, …) can't be forwarded through {...spread} (attribute "${name}") — ` +
            `an item read is owned by its each() row. Bind it directly on the element ` +
            `(<el ${name}={read(item, …)} />). Only machine reads and static values can be spread.`,
        )
      }
      if (isDirectiveInvocation(value)) {
        throw new Error(
          `stator: a directive (class:list / style:list / on:) can't be a {...spread} value ` +
            `(attribute "${name}") — a directive owns a whole attribute. Apply it on the element directly.`,
        )
      }
      if (isReadResult(value)) {
        // A live machine read: register the same attr binding the normal
        // `attr={read(...)}` path registers, keyed to this element + name, so a
        // machine event patches it. No new wire — same shape recompute expects.
        registerBinding(state, {
          slotId: value.slotId,
          machineName: value.machineName,
          selector: value.selector,
          lastValue: value.value,
          kind: 'attr',
          attrName: name,
          parentId: elementId,
        })
        emitAttribute(name, value.value, addAttribute)
        continue
      }
      emitAttribute(name, value, addAttribute)
    }
  },
})

/** Emit one attribute with the shared boolean/url semantics. false/null/undefined
 *  ⇒ absent (no `addAttribute` call at all); true ⇒ present-and-empty; otherwise
 *  stringified, url-guarded on url-bearing names. `addAttribute` HTML-escapes. */
function emitAttribute(
  name: string,
  value: unknown,
  addAttribute: (name: string, value: string) => void,
): void {
  if (value === false || value === null || value === undefined) return
  if (value === true) {
    addAttribute(name, '')
    return
  }
  const str = typeof value === 'string' ? value : String(value)
  addAttribute(name, isUrlAttribute(name) ? safeAttrUrl(str) : str)
}

/** Wrap an attribute bag as the directive the compiler emits for `{...spread}`. */
export function spreadAttrs(attrs: SpreadAttrs): DirectiveInvocation<SpreadAttrs> {
  return invoke(spreadDirective, '', attrs)
}
