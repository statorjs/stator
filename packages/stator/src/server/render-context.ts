import type { Resource } from '../template/resource.ts'
import type { HtmlFragment } from '../template/types.ts'

export type SlotId = string
export type MachineName = string
export type SessionId = string
export type ElementId = string

export type BindingKind = Binding['kind']

/** A binding-stored selector with its instance type erased. `any` (not
 *  `unknown`) is deliberate: parameters are contravariant, so a concrete
 *  `(instance: CartProxy) => T` is only assignable into an `any`-typed slot. */
// biome-ignore lint/suspicious/noExplicitAny: contravariant parameter — see doc comment
export type ErasedSelector = (instance: any) => unknown

/** A list binding's per-item renderer, item type erased (same variance argument). */
// biome-ignore lint/suspicious/noExplicitAny: contravariant parameter — see doc comment
export type ErasedItemRenderer = (item: any, index: number) => HtmlFragment

interface BindingBase {
  slotId: SlotId
  machineName: MachineName
  selector: ErasedSelector
  lastValue: unknown
}

export interface TextBinding extends BindingBase {
  kind: 'text'
}

export interface AttrBinding extends BindingBase {
  kind: 'attr'
  attrName: string
  parentId: ElementId
}

export interface ListBinding extends BindingBase {
  kind: 'list'
  /** Re-invoked per item when the list re-renders. */
  itemRenderer: ErasedItemRenderer
}

/** A keyed list's key selector, item type erased (same variance argument as
 *  ErasedSelector). */
// biome-ignore lint/suspicious/noExplicitAny: contravariant parameter — see ErasedSelector
export type ErasedKeyFn = (item: any) => unknown

export interface KeyedListBinding extends BindingBase {
  kind: 'list-keyed'
  /** Re-invoked per item for inserts and initial render. */
  itemRenderer: ErasedItemRenderer
  /** Derives each item's identity key (validated to string | number). */
  keyFn: ErasedKeyFn
  /** The previous render's keys, in order — the diff baseline. */
  lastKeys: string[]
}

export interface BranchBinding extends BindingBase {
  kind: 'branch'
  /** The selector value reduced to a stable key — re-render only fires when
   *  the key changes (so `when` doesn't re-render on every truthy-to-truthy
   *  value transition). */
  branchKeyFn: (value: unknown) => unknown
  /** Returns the renderer for a given selector value, or null when nothing
   *  should be rendered. */
  branchRenderFn: (value: unknown) => (() => HtmlFragment) | null
  /** The last computed key — distinct from lastValue, which holds the raw
   *  selector result. */
  lastBranchKey: unknown
}

/** Discriminated on `kind`, so per-kind fields are required where they apply —
 *  recompute narrows on the discriminant instead of asserting optionals. */
export type Binding = TextBinding | AttrBinding | ListBinding | KeyedListBinding | BranchBinding

/**
 * A `defer` slot recorded during the sync render pass, resolved and filled in
 * the async resolve phase (see server/render.ts). Deliberately NOT a `Binding`
 * — it never enters `byMachine`, so `recompute` provably never revisits it: the
 * slot is static/one-shot, which is what keeps `defer` I/O off the session lock.
 */
export interface DeferRecord {
  slotId: SlotId
  resource: Resource
  /** Rendered with the resolved value when the resource fulfills. */
  ready: (value: unknown) => HtmlFragment
  /** Rendered with the reason when the resource rejects; absent ⇒ the rejection
   *  bubbles to route-level error handling. */
  error?: (reason: unknown) => HtmlFragment
}

interface Scope {
  prefix: string
  counter: number
}

export interface RenderState {
  sessionId: SessionId
  routeKey: string
  bindings: Map<SlotId, Binding>
  byMachine: Map<MachineName, Set<SlotId>>
  scopeStack: Scope[]
  elementIdCounter: number
  /** `defer` slots recorded during the sync pass, drained by the resolve phase. */
  deferred: DeferRecord[]
  /** >0 while rendering inside a `defer` arm — machine bindings are illegal there
   *  (a defer slot is never re-diffed), so `registerBinding` throws. */
  deferDepth: number
  /** Whether this render should resolve `defer` slots. True on the read paths
   *  (GET, SSE-connect — off-lock); false for the `/__events` re-diff baseline,
   *  which runs UNDER the session lock and must never kick a defer thunk. */
  resolveDeferred: boolean
}

export function createRenderState(sessionId: SessionId, routeKey: string): RenderState {
  return {
    sessionId,
    routeKey,
    bindings: new Map(),
    byMachine: new Map(),
    scopeStack: [{ prefix: '', counter: 0 }],
    elementIdCounter: 0,
    deferred: [],
    deferDepth: 0,
    resolveDeferred: true,
  }
}

let currentRenderState: RenderState | null = null

export function getCurrentRenderState(): RenderState | null {
  return currentRenderState
}

export function requireCurrentRenderState(): RenderState {
  if (!currentRenderState) {
    throw new Error('stator: must be called during a template render (inside runInRender)')
  }
  return currentRenderState
}

export function runInRender<T>(state: RenderState, fn: () => T): T {
  const prev = currentRenderState
  currentRenderState = state
  try {
    return fn()
  } finally {
    currentRenderState = prev
  }
}

function topScope(state: RenderState): Scope {
  const s = state.scopeStack[state.scopeStack.length - 1]
  if (!s) throw new Error('stator: render scope stack is empty')
  return s
}

export function allocSlotId(state: RenderState): SlotId {
  const scope = topScope(state)
  const id = `${scope.prefix ? `${scope.prefix}:` : ''}s${scope.counter++}`
  return id
}

export function allocElementId(state: RenderState): ElementId {
  return `e${state.elementIdCounter++}`
}

export function pushListScope(state: RenderState, listSlotId: SlotId, iterIndex: number): void {
  state.scopeStack.push({ prefix: `${listSlotId}:i${iterIndex}`, counter: 0 })
}

/**
 * Keyed-list scope: descendant slot ids are derived from the item's *key*, not
 * its position — so a row's inner slot ids survive reordering, and a patch can
 * address "the row for p1, wherever it is now". This is the item-identity
 * primitive keyed `each` is built on.
 */
export function pushKeyedScope(state: RenderState, listSlotId: SlotId, token: string): void {
  state.scopeStack.push({ prefix: `${listSlotId}:k${token}`, counter: 0 })
}

/** Keyed scope prefix for a key token (shared by render and recompute). */
export function keyedScopePrefix(listSlotId: SlotId, token: string): string {
  return `${listSlotId}:k${token}`
}

/**
 * Encode an item key into a slot-id-safe token. Injective: only `[A-Za-z0-9-]`
 * pass through (NOT `_`, which is the escape character); everything else
 * becomes `_<codepoint hex>`. Keys land in `data-slot` attributes and CSS
 * attribute selectors, so the charset must be quote- and bracket-free.
 */
export function keyToken(key: string): string {
  return key.replace(/[^A-Za-z0-9-]/gu, (c) => `_${c.codePointAt(0)!.toString(16)}`)
}

export function popListScope(state: RenderState): void {
  if (state.scopeStack.length <= 1) {
    throw new Error('stator: cannot pop root render scope')
  }
  state.scopeStack.pop()
}

/**
 * Enter a `defer` arm's render scope (used by the resolve phase when it renders
 * the resolved arm). Scopes descendant slot ids under `${slotId}:d` — like a
 * branch arm — and raises `deferDepth` so machine reads inside the arm throw.
 */
export function pushDeferScope(state: RenderState, slotId: SlotId): void {
  state.scopeStack.push({ prefix: `${slotId}:d`, counter: 0 })
  state.deferDepth += 1
}

export function popDeferScope(state: RenderState): void {
  if (state.scopeStack.length <= 1) {
    throw new Error('stator: cannot pop root render scope')
  }
  state.scopeStack.pop()
  state.deferDepth -= 1
}

export function registerBinding(state: RenderState, binding: Binding): void {
  // Runtime backstop for the defer/machine boundary (the static compile check is
  // the primary, build-time gate). A machine read — read(), or a machine-bound
  // each/when/match — inside a defer arm would need live re-diffing, but a defer
  // slot is one-shot and never revisited. Catch it (direct or reached through a
  // helper) rather than silently freeze the value.
  if (state.deferDepth > 0) {
    throw new Error(
      `stator: a machine read (read() / a machine-bound each/when/match) cannot appear inside a ` +
        `defer() arm — defer is one-shot and static, so the value would never update. For a live ` +
        `value, use a machine and place the read in a sibling slot outside the defer.`,
    )
  }
  state.bindings.set(binding.slotId, binding)
  let slotIds = state.byMachine.get(binding.machineName)
  if (!slotIds) {
    slotIds = new Set()
    state.byMachine.set(binding.machineName, slotIds)
  }
  slotIds.add(binding.slotId)
}

/**
 * Remove every binding whose slot id is a *descendant* of the given scope prefix
 * (i.e. starts with `prefix:`). The prefix itself is not removed — useful when
 * re-rendering a list whose own list-binding must persist.
 */
export function unregisterBindingsForScope(state: RenderState, scopePrefix: string): void {
  const toRemove: SlotId[] = []
  for (const slotId of state.bindings.keys()) {
    if (slotId.startsWith(`${scopePrefix}:`)) {
      toRemove.push(slotId)
    }
  }
  for (const slotId of toRemove) {
    const b = state.bindings.get(slotId)!
    state.bindings.delete(slotId)
    const slotIds = state.byMachine.get(b.machineName)
    if (slotIds) {
      slotIds.delete(slotId)
      if (slotIds.size === 0) state.byMachine.delete(b.machineName)
    }
  }
}

export type EventDescriptor = {
  readonly __isEventDescriptor: true
  machine: string
  event: { type: string; [k: string]: unknown }
}

export function createEventDescriptor(
  machine: string,
  event: { type: string; [k: string]: unknown },
): EventDescriptor {
  return { __isEventDescriptor: true, machine, event }
}

export function isEventDescriptor(v: unknown): v is EventDescriptor {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isEventDescriptor === true
  )
}
