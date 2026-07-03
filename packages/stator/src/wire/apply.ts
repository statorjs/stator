/**
 * Client-side appliers for the wire protocol — the one implementation of
 * "given patches/directives, mutate the DOM". Used by both the page runtime
 * (client/runtime.ts) and island dispatch (client/dispatch.ts), so the two
 * paths can't drift.
 *
 * Observability: every applied patch/directive dispatches a `stator:*`
 * CustomEvent on `window` (the inspector's contract), regardless of which
 * path applied it.
 */
import type { Directive, Patch } from './index.ts'

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function resolveTarget(target: { kind: 'slot' | 'element'; id: string }): Element | null {
  if (target.kind === 'slot') {
    return document.querySelector(`[data-slot="${target.id}"]`)
  }
  return document.querySelector(`[data-stator-id="${target.id}"]`)
}

export function applyPatches(patches: Patch[]): void {
  for (const patch of patches) {
    const element = resolveTarget(patch.target)
    if (element) {
      if (patch.op === 'text') element.textContent = patch.value
      else if (patch.op === 'html') element.innerHTML = patch.value
      else if (patch.op === 'attr') element.setAttribute(patch.name, patch.value)
    }
    emit('stator:patch-applied', { patch, element, timestamp: Date.now() })
  }
}

export function applyDirectives(directives: Directive[]): void {
  for (const directive of directives) {
    emit('stator:directive-applied', { directive, timestamp: Date.now() })
    switch (directive.type) {
      case 'navigate':
        location.href = directive.to
        return // stop processing further directives; we're leaving
      case 'reload':
        location.reload()
        return
      case 'push-url':
        history.pushState({}, '', directive.to)
        break
      case 'replace-url':
        history.replaceState({}, '', directive.to)
        break
      case 'focus': {
        const el = resolveTarget(directive.target)
        if (el && 'focus' in el && typeof (el as HTMLElement).focus === 'function') {
          ;(el as HTMLElement).focus()
        }
        break
      }
      case 'scroll': {
        const el = resolveTarget(directive.target)
        if (el && 'scrollIntoView' in el) {
          ;(el as HTMLElement).scrollIntoView({
            behavior: directive.behavior ?? 'auto',
          })
        }
        break
      }
      case 'event':
        emit(directive.name, directive.detail)
        break
      default:
        console.error('stator: unknown directive type', directive)
    }
  }
}
