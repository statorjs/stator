import { defineMachine, type MachineDef, type EventObject } from '../engine/index.ts'

/**
 * Terse machine form for component-local client state. Desugars to a single-state
 * `defineMachine` — context is every top-level key except the reserved `on` /
 * `select` / `name`, transitions go under one implicit `active` state, and
 * `select` becomes selectors.
 *
 *   machine({ count: 1, on: { INC: s => s.count++ }, select: { atMax: s => s.count >= 99 } })
 *
 * Client machines run only via `createActor` (never the Store), so the name is
 * just a label and need not be unique.
 */
export interface MachineConfig {
  /** Optional label (defaults to "ClientMachine"). */
  name?: string
  /** Transition map for the single implicit state. A bare function is an action;
   *  an object is a full `{ to?, when?, do?, emit? }` transition. */
  on?: Record<string, any>
  /** Derived values, exposed as selectors on the instance. */
  select?: Record<string, (ctx: any) => unknown>
  /** Everything else is initial context. */
  [key: string]: unknown
}

export function machine(config: MachineConfig): MachineDef {
  const { name, on = {}, select = {}, ...context } = config
  return defineMachine({
    name: name ?? 'ClientMachine',
    lifecycle: 'session',
    events: {} as EventObject,
    context: context as object,
    initial: 'active',
    states: { active: { on } },
    selectors: select,
  }) as MachineDef
}
