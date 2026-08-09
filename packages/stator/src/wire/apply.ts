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
import { setAttr } from './attr-value.ts'
import type { Directive, Patch } from './index.ts'
import {
  elementAt,
  findRegion,
  insertAt,
  moveWithin,
  removeAt,
  replaceRegion,
} from './region-apply.ts'
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

function warnMissing(target: { kind: string; id: string }): void {
  // A missing target means this DOM diverged from server truth (stale non-live
  // page, or client code removed server-owned nodes). Skipping is safe — arm/
  // key-scoped ids guarantee a patch can't land on the wrong content — but the
  // divergence is worth surfacing.
  console.warn(`stator: patch target ${target.kind} "${target.id}" not in DOM — skipped`)
}

export function applyPatches(patches: Patch[]): void {
  // Resolve each region's marker pair once per batch. The markers are stable
  // anchors — ops mutate only the nodes between them — so a pair found for one
  // op stays valid for the rest of the batch (keyed lists emit a run of ops on
  // the same slot). null caches a genuine miss.
  const regions = new Map<string, { start: Comment; end: Comment } | null>()
  const regionFor = (id: string): { start: Comment; end: Comment } | null => {
    let r = regions.get(id)
    if (r === undefined) {
      r = findRegion(document, id)
      regions.set(id, r)
    }
    return r
  }

  for (const patch of patches) {
    const element = applyPatch(patch, regionFor)
    emit('stator:patch-applied', { patch, element, timestamp: Date.now() })
  }
}

/** Apply one patch. Returns the element the inspector should flash (or null when
 *  the target is missing or the change left no single node to highlight). */
function applyPatch(
  patch: Patch,
  regionFor: (id: string) => { start: Comment; end: Comment } | null,
): Element | null {
  // `text`/`attr` address a single node: a text-binding `data-slot` span or a
  // `data-stator-id` element.
  if (patch.op === 'text' || patch.op === 'attr') {
    const element = resolveTarget(patch.target)
    if (!element) {
      warnMissing(patch.target)
      return null
    }
    if (patch.op === 'text') element.textContent = patch.value
    else setAttr(element, patch.name, patch.value)
    return element
  }

  // `html`/`insert`/`remove`/`move` address a REGION delimited by comment
  // markers (`<!--s:id-->…<!--/s:id-->`). Keyed-list ops address element
  // children by index, sequentially: each op sees the DOM as left by the
  // previous one (see wire/index.ts).
  const region = regionFor(patch.target.id)
  if (!region) {
    warnMissing(patch.target)
    return null
  }
  const { start, end } = region
  if (patch.op === 'html') {
    replaceRegion(start, end, patch.value)
    return start.parentElement
  }
  if (patch.op === 'insert') {
    insertAt(start, end, patch.index, patch.value)
    return elementAt(start, end, patch.index)
  }
  if (patch.op === 'remove') {
    removeAt(start, end, patch.index)
    return start.parentElement
  }
  moveWithin(start, end, patch.from, patch.to)
  return elementAt(start, end, patch.to)
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
