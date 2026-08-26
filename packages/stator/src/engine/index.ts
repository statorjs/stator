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
  MachineDescription,
  StateDescription,
  TransitionDescription,
} from './describe.ts'
export { describeMachine } from './describe.ts'
export type {
  Action,
  ActionHelpers,
  AfterEntry,
  AnyMachineDef,
  Capabilities,
  Effect,
  EffectInvocation,
  EffectMeta,
  EffectSession,
  EmitDeclaration,
  EmitsConfig,
  EntryEffect,
  EventObject,
  EventOf,
  Guard,
  InstanceOf,
  Lifecycle,
  MachineDef,
  ReadsMap,
  SelectorMap,
  Snapshot,
  StateNameOf,
  StateNode,
  SubscribeEntry,
  Transition,
  TransitionConfig,
} from './types.ts'
export { isStatorMachine } from './types.ts'
