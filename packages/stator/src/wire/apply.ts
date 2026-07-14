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
import { isSafeNavigationUrl } from './safe-url.ts'

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
    if (!element) {
      // A missing target means this DOM diverged from server truth (stale
      // non-live page, or client code removed server-owned nodes). Skipping
      // is safe — arm/key-scoped slot ids guarantee a patch can't land on
      // the wrong content — but the divergence is worth surfacing.
      console.warn(
        `stator: patch target ${patch.target.kind} "${patch.target.id}" not in DOM — skipped`,
      )
      continue
    }
    if (element) {
      if (patch.op === 'text') element.textContent = patch.value
      else if (patch.op === 'html') element.innerHTML = patch.value
      else if (patch.op === 'attr') {
        if (patch.value === null) element.removeAttribute(patch.name)
        else element.setAttribute(patch.name, patch.value)
      }
      // Keyed-list ops address element children by index, sequentially: each
      // op sees the DOM as left by the previous one (see wire/index.ts).
      else if (patch.op === 'insert') {
        const tpl = document.createElement('template')
        tpl.innerHTML = patch.value
        element.insertBefore(tpl.content, element.children[patch.index] ?? null)
      } else if (patch.op === 'remove') {
        element.children[patch.index]?.remove()
      } else if (patch.op === 'move') {
        const node = element.children[patch.from]
        if (node) {
          node.remove()
          element.insertBefore(node, element.children[patch.to] ?? null)
        }
      }
    }
    emit('stator:patch-applied', { patch, element, timestamp: Date.now() })
  }
}

export function applyDirectives(directives: Directive[]): void {
  for (const directive of directives) {
    emit('stator:directive-applied', { directive, timestamp: Date.now() })
    switch (directive.type) {
      case 'navigate':
        // Reject javascript:/vbscript:/data: targets — a navigation directive
        // must not be an in-page script sink or off-document jump.
        if (!isSafeNavigationUrl(directive.to)) {
          console.error('stator: refusing unsafe navigate target', directive.to)
          return
        }
        location.href = directive.to
        return // stop processing further directives; we're leaving
      case 'reload':
        location.reload()
        return
      case 'push-url':
        if (!isSafeNavigationUrl(directive.to)) {
          console.error('stator: refusing unsafe push-url target', directive.to)
          break
        }
        history.pushState({}, '', directive.to)
        break
      case 'replace-url':
        if (!isSafeNavigationUrl(directive.to)) {
          console.error('stator: refusing unsafe replace-url target', directive.to)
          break
        }
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
