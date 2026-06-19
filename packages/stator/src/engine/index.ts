/**
 * Stator's custom isomorphic state-machine engine. Public surface.
 *
 * Replaces the XState-backed POC `defineMachine`. Lean feature set, fresh API
 * (inline transitions, typed events), runs identically server- and client-side.
 * See spec: custom-isomorphic-state-machine-engine.
 */
export { defineMachine } from './define-machine.ts'
export type { DefineMachineConfig } from './define-machine.ts'
export { createActor } from './actor.ts'
export type { Actor, CreateActorOptions } from './actor.ts'
export { isStatorMachine } from './types.ts'
export type {
  ActionHelpers,
  Action,
  AnyMachineDef,
  Guard,
  Capabilities,
  EmitDeclaration,
  EmitsConfig,
  EventObject,
  EventOf,
  InstanceOf,
  Lifecycle,
  MachineDef,
  ReadsMap,
  Snapshot,
  StateNode,
  SubscribeEntry,
  Transition,
  TransitionConfig,
  SelectorMap,
} from './types.ts'
