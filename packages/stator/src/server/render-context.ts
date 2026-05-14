export type SlotId = string
export type MachineName = string
export type SessionId = string
export type ElementId = string

export type BindingKind = 'text' | 'attr' | 'list' | 'branch'

export interface Binding {
  slotId: SlotId
  machineName: MachineName
  selector: (instance: any) => unknown
  lastValue: unknown
  kind: BindingKind
  attrName?: string
  parentId?: ElementId
  /** Only set for kind='list'. Re-invoked per item when the list re-renders. */
  itemRenderer?: (item: any, index: number) => import('../template/types.ts').HtmlFragment
  /** Only set for kind='branch'. The selector value reduced to a stable
   *  key — re-render only fires when the key changes (so `when` doesn't
   *  re-render on every truthy-to-truthy value transition). */
  branchKeyFn?: (value: unknown) => unknown
  /** Only set for kind='branch'. Returns the renderer for a given selector
   *  value, or null when nothing should be rendered. */
  branchRenderFn?: (value: unknown) => (() => import('../template/types.ts').HtmlFragment) | null
  /** Only set for kind='branch'. The last computed key — distinct from
   *  lastValue, which holds the raw selector result. */
  lastBranchKey?: unknown
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
}

export function createRenderState(sessionId: SessionId, routeKey: string): RenderState {
  return {
    sessionId,
    routeKey,
    bindings: new Map(),
    byMachine: new Map(),
    scopeStack: [{ prefix: '', counter: 0 }],
    elementIdCounter: 0,
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
  const id = `${scope.prefix ? scope.prefix + ':' : ''}s${scope.counter++}`
  return id
}

export function allocElementId(state: RenderState): ElementId {
  return `e${state.elementIdCounter++}`
}

export function pushListScope(state: RenderState, listSlotId: SlotId, iterIndex: number): void {
  state.scopeStack.push({ prefix: `${listSlotId}:i${iterIndex}`, counter: 0 })
}

export function popListScope(state: RenderState): void {
  if (state.scopeStack.length <= 1) {
    throw new Error('stator: cannot pop root render scope')
  }
  state.scopeStack.pop()
}

export function registerBinding(state: RenderState, binding: Binding): void {
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
    if (slotId.startsWith(scopePrefix + ':')) {
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
