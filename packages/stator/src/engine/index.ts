/**
 * Stator's custom isomorphic state-machine engine. Public surface.
 *
 * Replaces the XState-backed POC `defineMachine`. Lean feature set, fresh API
 * (inline transitions, typed events), runs identically server- and client-side.
 * See spec: custom-isomorphic-state-machine-engine.
 */

export type { Actor, AnyActor, CreateActorOptions } from './actor.ts'
export { createActor } from './actor.ts'
export type { DefineMachineConfig } from './define-machine.ts'
export { defineMachine } from './define-machine.ts'
export type {
  Action,
  ActionHelpers,
  AnyMachineDef,
  Capabilities,
  Effect,
  EffectInvocation,
  EffectMeta,
  EmitDeclaration,
  EmitsConfig,
  EventObject,
  EventOf,
  Guard,
  InstanceOf,
  Lifecycle,
  MachineDef,
  ReadsMap,
  SelectorMap,
  Snapshot,
  StateNode,
  SubscribeEntry,
  Transition,
  TransitionConfig,
} from './types.ts'
export { isStatorMachine } from './types.ts'
