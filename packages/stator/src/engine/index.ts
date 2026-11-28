/**
 * Stator's custom isomorphic state-machine engine. Public surface.
 *
 * Lean feature set (inline transitions, typed events), runs identically
 * server- and client-side.
 */

export type {
  Actor,
  AnyActor,
  CreateActorOptions,
  ResolvedHelpers,
  SendResult,
} from './actor.ts'
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
  BrowserEventOf,
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
  GuardHelpers,
  InstanceOf,
  Lifecycle,
  MachineDef,
  PeersMap,
  ReadsMap,
  Refusal,
  RefusalIssue,
  SelectorMap,
  Snapshot,
  StateNameOf,
  StateNode,
  SubscribeEntry,
  Transition,
  TransitionConfig,
} from './types.ts'
export { isStatorMachine } from './types.ts'
