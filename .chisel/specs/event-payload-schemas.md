---
title: Event payload schemas
status: draft
created: 2026-11-22
updated: 2026-11-22
area: engine
---

## What and Why

A machine's events are a type and nothing else: `events: {} as DeskEvents` is a phantom the engine never reads (`engine/define-machine.ts:34-36`). `/__events` checks the envelope (`machine` is a string, `event.type` is a string; `eventSchema`, `server/http.ts:118`) and passes the rest through, so a field typed `number` reaches a guard as whatever JSON the browser sent. The docs say so in a section titled "What arrives is JSON, not your event type" (`guides/dispatching-events.md`), and the registration starter's rules all take `unknown` for that reason (`examples/registration/lib/rules.ts`: "on the server, its input is JSON from a browser").

The 3.0 audit closed the demonstrated holes with the per-route event gate and the 64 KiB cap, and deferred this (ROADMAP, Primitives). It is also the stated prerequisite of agent tools (ROADMAP, Developer tooling).

Decided by Tony (the record is at the bottom of this file):

- An event defines a schema, its TypeScript type is inferred from it, and the schema validates where the event enters from outside.
- The schema is any Standard Schema validator the app brings. Stator ships none and re-exports none. Valibot is the one the docs and scaffolds use.
- From 4.0 every event on a `defineMachine` machine has a schema or `null`. 3.2 introduces the map and reports what is missing; 4.0 requires it.

This spec depends on [[refused-dispatch-reasons]] (3.1). A payload that fails its schema is a refusal: a 422 with `committed: false` and `refusal: { code: 'invalid', issues }`. There is no second error channel.

## Success Criteria

- A machine declares its events as a map of schemas; guards, actions, effects, `send` and `dispatch` are typed from it with no separate union.
- `/__events` validates an event after every existing admission check and before the session lock. A failure answers **422** with `{ patches: [], directives: [], committed: false, refusal: { code: 'invalid', issues } }`, one issue per bad field. The machine is never sent the event.
- Guards and actions receive the schema's **output**. A key the schema does not declare does not reach the machine.
- A Valibot, Zod or ArkType schema works in the same map. Stator's own `package.json` gains no validator.
- An app whose events carry no payload (`events({ INC: null })`) installs nothing beyond `@statorjs/stator`.
- A machine that keeps `events: {} as E` validates nothing and answers exactly as in 3.1. It is listed in the 3.2 report.
- `stator build` and dev boot list every event that has no schema. `stator check` does not, and stays static.
- An island that only dispatches to a machine ships no schema and no validator. An island that runs a machine with `use()` ships neither, unless its own code references a schema as a value. Bundle-content tests prove both, with Valibot.
- At 4.0 an event with no schema fails the build and the boot, and `{} as E` is gone.

## Constraints

- 3.2 is a minor. `defineMachine`'s type parameters and their inference do not change (the `NoInfer` note at `define-machine.ts:58-64` is why).
- The engine does not validate. `createActor` and `send` never call a schema; validation is the host's job at an ingress. This keeps the engine I/O-free and keeps validators out of the client actor's path.
- No validator dependency, built-in or re-exported. The Standard Schema interface is types, copied into the tree. `zod` leaves Stator's code in 3.2 and its `package.json` at 4.0.
- The *requirement* covers every event of every `defineMachine` machine. *Validation* runs once, at the door an event comes in through. The two are separate rules and the spec keeps them apart.
- Validation never reveals more than the gates already allow: at `/__events` it runs only for an event the route offers, on a session machine, that is not `serverOnly`.
- One refusal channel, the 3.1 envelope and its 422.

## Approach

### Declaring events

```ts
import { defineMachine, events } from '@statorjs/stator/machine'
import * as v from 'valibot'

const DeskMachine = defineMachine({
  name: 'DeskMachine',
  lifecycle: 'session',
  events: events({
    REGISTER: v.object({
      name: v.pipe(v.string(), v.minLength(2), v.maxLength(60)),
      email: v.pipe(v.string(), v.email("That doesn't look like an email address.")),
      seats: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_SEATS_PER_PARTY)),
      ticket: v.picklist(TICKETS),
      updates: v.optional(v.boolean()),
    }),
    REMOVE: v.object({ id: v.string() }),
    CLOSE: null,                                   // no payload
    CHARGE_OK: v.object({ receipt: v.string() }),  // raised by an effect; typed from the schema, never run
  }),
  …
})
```

`valibot` is in the app's `package.json`, not Stator's. A machine whose events are all `null` imports no validator.

**A map, keyed by event type.** The key is the `type`; the schema describes the payload without it. A map is enumerable at runtime, which a union schema is not without vendor-specific introspection: a door looks a schema up by `event.type`, the report lists which events have one, and a tool list can read one schema per key. It also keeps the discriminant out of every schema.

Three kinds of value:

- a Standard Schema whose output is an object: validated wherever the event enters from outside, and the source of the event's type everywhere;
- `null`: the event has no payload. It counts as schema'd; extra keys are dropped;
- `serverOnly<T>()` or `serverOnly(schema)`: the browser may not send this event. It is the map's form of the `serverOnly` list, and it counts as declared.

```ts
import { defineMachine, events, serverOnly } from '@statorjs/stator/machine'

events: events({
  CHECKOUT: v.object({ token: v.string() }),             // sent by a page
  CHARGE_OK: serverOnly<{ receipt: string }>(),          // an effect's completion: typed, no validator
  CHARGE_FAILED: serverOnly<{ reason: string }>(),
  PAYMENT_WEBHOOK: serverOnly(v.object({ id: v.string(), status: v.picklist(['paid', 'failed']) })),
  CLOSE: null,
}),
```

One word for one idea, in both places it appears: a `serverOnly` event is refused at `/__events` with the 403 the list already produces (`http.ts:742`), and nothing else about who may raise it changes. Server code is the only sender, which covers the engine (an effect or entry-effect completion, an `after` send, an emit delivered through `subscribes`) and the app's own handlers (API-route `dispatch`, `dispatchToApp`).

- `serverOnly<T>()` is typed and carries no schema. The payload is whatever server code passes, checked by TypeScript at the call and by nothing at runtime, which is what a `serverOnly` event with a type-only union is today. It needs no validator, so an app whose only payload events are engine-raised installs none.
- `serverOnly(schema)` takes a schema for a server-only event whose payload comes from outside the process: a webhook body, a form a handler parsed. API-route `dispatch` and `dispatchToApp` validate it like any other schema'd event; the wire still refuses it.

A map entry marked `serverOnly` implies the type is in the machine's `serverOnly` set, so the list does not repeat it. The list keeps working through 3.x (a machine still on `{} as E` has nowhere else to say it), and naming a type in both is allowed. See Open Questions for the list's future.

This is what separates the marker from the rejected `unchecked`: the hole `unchecked` left was at the wire, where the payload is a stranger's JSON. `serverOnly<T>()` closes the wire and leaves typed-only exactly where it already is, in the app's own server code.

**There is no `unchecked<T>()`**, a typed entry that is neither validated nor refused anywhere. The decision record left open whether 3.2 needs it as a bridge. It does not, and it is never introduced:

- The 3.x bridge already exists and is per machine: a machine keeps `events: {} as E` until it moves, and then moves whole. The report counts machines and events either way.
- What `unchecked` would save is writing a schema for an event that 4.0 requires a schema for. It would be API that is deprecated the day it ships and removed one major later.
- An engine-raised event declares its type with `serverOnly<T>()`, which the wire enforces; `unchecked` would be the same entry with the enforcement taken out.
- The case `unchecked` looks necessary for, a payload that is not JSON, the vendor already covers, and the choice is visible in the machine's code: `v.date()` for a `Date`, `v.instance(Receipt)` for a class instance, `v.custom<Order>(() => true)` or `v.any()` for "typed, not checked". An effect completion can carry any of them; a wire event cannot (JSON has no `Date`), and a schema that says otherwise refuses every request, which is a visible bug.

The cost: converting a machine with twenty events is one edit, not twenty. Accepted.

**`events()` is a helper, not a new shape for the `events:` key.** It returns a value typed as the event union, so `defineMachine` infers `E` from `events?: E` exactly as it does from `{} as DeskEvents`. At runtime the value carries the map under a symbol; `defineMachine` reads it into `def.schemas`. In 3.x `{} as E` remains valid: `def.schemas` is `undefined` and nothing is validated.

```ts
// engine/events.ts
type Entry = StandardSchemaV1<unknown, Record<string, unknown>> | null

export function events<const M extends Record<string, Entry>>(map: M): EventsOf<M>

type EventsOf<M> = {
  [K in keyof M & string]: Simplify<
    { type: K } & OutputOf<M[K]> & { readonly [CHECKED]?: InputOf<M[K]> }
  >
}[keyof M & string]
```

`OutputOf` and `InputOf` read `~standard.types.output` and `.input`; for `null` both are `{}`.

```ts
// engine/types.ts
export interface MachineDef<…> {
  …
  /** Event type → payload schema (null = no payload). Undefined when the machine
   *  declares its events as a type only (`{} as E`, 3.x) or is a client `machine()`. */
  schemas?: Readonly<Record<string, StandardSchemaV1 | null>>
}
```

`describeMachine` (`engine/describe.ts`) gains `declared: string[] | null`: the map's keys, or `null` when there is no map.

**Client `machine()` machines are exempt, in 3.2 and at 4.0.** They are built on the engine's `defineMachine` with `events: {} as ClientEvent` (`client/machine.ts:121-129`), run only through `createActor` in an island, and no event reaches them from outside. They keep their three typing tiers (none, derived from `on` keys, declared `{} as E`). At 4.0 `machine()` reaches the engine through an internal entry that does not require a map.

### Input and output

The machine sees the parsed output. It has to: the output is the only value the schema vouches for. Passing the raw input on would hand the guard the undeclared keys and untransformed values that validation exists to remove.

So there are two types per event, and they differ whenever a schema transforms, coerces or defaults (`v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))` takes a string and gives a `Date`):

- handlers, effects' completions, emit payloads and `EventOf<D>` use the **output**. That is `E`, unchanged in meaning;
- everything that hands an event in from outside uses the **input**: `BrowserEventOf<D>` (island `dispatch`, template `send`; `engine/types.ts:339`, `template/types.ts:18`), API-route `dispatch` (`server/routing.ts:147`), `dispatchToApp` and its bound forms (`server/app-dispatch.ts:20`, `create-app.ts:183`, `boot.ts:28`, `dev.ts:93`, `dev-native.ts:76`). These read a new `EventInputOf<D>`.

The input type rides on each union member as an optional property under a unique symbol (`CHECKED` above). It is invisible in handlers (optional, symbol-keyed), survives `Extract<E, { type: K }>` in `OnMap`, and needs no new type parameter on `MachineDef`. `EventInputOf<D>` maps each member to `{ type } & input` when the brand is present and leaves the member alone otherwise (a `{} as E` machine, a client machine). The brand is also what tells a union made by `events()` from a hand-written one at the type level, which the 4.0 cutover uses.

With no built-in validator, every schema is a vendor schema and transforms are ordinary, so the brand is not optional polish. It is spiked first (Open Questions); the fallback is "input must equal output in 3.2".

**Parse once, at the door.** An event from outside is parsed; an event the engine raises is already an output and is not parsed again (a string-to-`Date` transform would fail on its own output).

| Origin | Validated | Typed against | A failure goes to |
|---|---|---|---|
| `/__events` (template `send`, island `dispatch`) | yes | input | a 422 with the envelope's `refusal` |
| API-route `dispatch(Machine, event)` | yes | input | the returned `{ committed: false, refusal }` |
| `dispatchToApp(Machine, event)` from app code (webhooks, `boot.ts`) | yes | input | the returned `{ committed: false, refusal }` |
| effect completion, entry-effect completion | no | output | — |
| `after` send | no | output | — |
| emit → `subscribes` delivery | no | output | — |
| `use()`d machine in an island, `machine()` client machines | no | output | — |

API-route `dispatch` and `dispatchToApp` are doors because a multipart form handler and a webhook receiver both dispatch a parsed request body (`recipes/receiving-webhooks.md` passes `event.data` straight through). In 3.x an event of a machine with no map passes through all three unvalidated, as today. At 4.0 every machine has a map, so all three doors always have a schema to validate against.

The rows that say "no" are not a hole in the requirement. Those events still need a schema at 4.0; it is where their type comes from, and it is never run.

Effect completions and timers for app machines reach the actor through `dispatchToApp` today (`server/effects.ts:103`, `server/timers.ts:83`). They move to an internal entry that skips validation; the exported `dispatchToApp` and the app's bound method validate.

### At the wire

One function, used by all three doors:

```ts
// server/validate-event.ts
export async function validateEvent(
  def: AnyMachineDef,
  event: { type: string; [k: string]: unknown },
): Promise<{ event: EventObject } | { refusal: Refusal }>
```

- `def.schemas` is `undefined` (3.x, `{} as E`): returns the event as given.
- The map has no entry for the type: throws, naming the machine and the event. The types make this unreachable (`on` keys are typed against the map's union), so reaching it is a cast or plain JavaScript, not a request to refuse.
- `null`: returns `{ type }`.
- A schema: `validate(rest)` on the event without `type`, awaited (Standard Schema allows a promise). Success returns `{ ...value, type }`, `type` last so a schema cannot rename the event. A success value that is not a plain object is a thrown error naming the machine and event (a schema bug, not a refusal).
- Failure returns `{ code: 'invalid', issues }`: each Standard Schema issue becomes `{ path, message }` with path segments flattened (`{ key }` → `key`, symbols → `String`), capped at 32 issues.

The function does not read `events.schemas`. The config key governs the report and the 4.0 boot check, never what a door does with a request.

In `/__events` it runs after the offered-event gate (`http.ts:762-772`) and before `withSessionLock` (`http.ts:774`). On a refusal the handler answers **422** with `{ patches: [], directives: [], committed: false, refusal }` and loads nothing. That is the "Schema validation failed" row of the status table in [[refused-dispatch-reasons]]; this spec adds no status and no body shape. What follows from that spec without further work here:

- the client reads it as `{ ok: true, committed: false, refusal }` (`DispatchResult`), fires `stator:dispatch-refused`, and does not fire `stator:dispatch-error`;
- the request logger writes a 422 from `/__events` at `debug`;
- nothing is recorded in the replay cache, because the check runs before the lock. A retry computes the same answer as long as the schema is a pure function of the payload, which is one more reason async refinements that read a database belong in a guard.

Order is the security property: a request learns field-level detail about an event only if its page offers that event to it, on a session machine, and the event is not `serverOnly`. Everything earlier answers as it does today.

Issue messages go to the client verbatim. They are the validator library's messages, or the author's own (`v.email('…')`), and they describe the client's own input. A custom check that puts server data in its message sends it to the browser; the docs say so beside the same warning for `refuse`.

At `/__events` validation runs outside the session lock. In an API route it does not: `dispatch` is called inside the handler, which holds the session lock (`server/api-route.ts:53`), so a slow async schema there holds the lock. Truth rules (duplicates, capacity) stay in guards either way, where they are atomic with the commit.

**The envelope check stops using Zod.** `eventSchema` (`http.ts:118-127`) is Stator's only import of `zod`. It becomes a hand-written check of the same four facts: the body is an object, `machine` is a string, `event` is an object with a string `type` (other keys kept), and `eventId`, when present, is a string of 1 to 128 characters. A failure is the same 400 with `{ error: 'invalid event payload', detail }`; `detail` becomes one sentence naming the bad field where it was a Zod error dump. The `zod` entry stays in `package.json` until 4.0.

WIRE.md: the "Extra fields on `event` are passed through" sentence gains "unless the machine declares its events with a schema map", the "Per-machine event schemas" bullet under "What's not in the wire protocol" is removed, and the 422 row for a schema failure is confirmed in the status table that [[refused-dispatch-reasons]] adds.

### The validator: bring your own

Decided. Stator consumes schemas only through `~standard`, ships no validator, and re-exports no vendor. There is no `@statorjs/stator/schema`. The options that were weighed:

| | Bring your own (decided) | Built-in, any Standard Schema accepted | Re-export a vendor |
|---|---|---|---|
| A payload-free app | nothing installed | nothing installed | nothing installed |
| An app with payloads | one validator in the app's `package.json`; the scaffold has Valibot there already | nothing installed | nothing installed |
| Who audits the code at the security boundary | a library with years of use and scrutiny | new code, Stator's | the vendor |
| Stator's API and semver | untouched by any vendor's releases | owns a validator and every request to grow it | coupled to the vendor's majors |
| Transforms, coercion, async | whatever the vendor has | built-in: none; vendor: all | the vendor's |
| JSON Schema for agent tools | when the vendor provides it | guaranteed for the built-in only | the vendor's |
| Existing app schemas (a Zod domain model) | reused | reused | reused only if it is that vendor and that major |

Why bring-your-own:

- **Accepting any Standard Schema validator costs a type import.** The cost was only ever in *requiring* one, and hello-world does not: `events({ INC: null })` needs no validator.
- **A validator at the wire is a security boundary.** A mature library has had more scrutiny than a validator written for this spec would have.
- **The JSON Schema argument was the built-in's deciding one, and it rested on a deferred feature.** Agent tools are evidence-gated and unbuilt. The mainstream validators now implement Standard JSON Schema or ship an adapter for it, so the guarantee a built-in bought is mostly available without one.
- **Re-exporting a vendor couples Stator's public API and semver to that vendor's majors.** Astro's Zod re-export is the example: Astro stayed on Zod 3 until Astro 6 moved every app to Zod 4 at once.

A built-in is reconsidered only on evidence before 4.0.

**Valibot is the default, at app level.** Docs and examples use it. `create-stator` copies its templates from `examples/` (`packages/create-stator/index.js`, `FIRST_PARTY`), so "the scaffold lists Valibot" means each example with a payload event has `valibot` in its own `dependencies`. It is never a dependency of `@statorjs/stator`. Stator's tests use a hand-written Standard Schema fake for the engine and door behavior, and `valibot` as a `devDependency` of `packages/stator` for the bundle-content tests, where a real library's tree-shaking is the thing under test.

Facts checked:

- `StandardSchemaV1` is `{ '~standard': { version: 1, vendor, validate, types? } }`; `validate` may return a promise; issues are `{ message, path? }`. Implemented by Zod 3.24+, Valibot 1.0+, ArkType 2.0+.
- The Valibot names used in this spec exist in `valibot@1.5.0`'s type declarations: `object`, `string`, `number`, `boolean`, `pipe`, `minLength`, `maxLength`, `email`, `integer`, `minValue`, `maxValue`, `picklist`, `optional`, `literal`, `array`, `date`, `instance`, `any`, `custom`, `transform`, `isoTimestamp`. `v.object` drops undeclared keys (`strictObject` and `looseObject` are the other two behaviors).
- `valibot@1.5.0` is marked `"sideEffects": false` and its build carries `@__NO_SIDE_EFFECTS__` annotations, which is what the island strip below relies on.
- `zod@^3.23.0` is a dependency of `@statorjs/stator` used in one place, `http.ts:118`. 3.23 predates Zod's Standard Schema support, and an app cannot rely on a transitive dependency anyway.

### The Standard Schema types

Copied into `packages/stator/src/engine/standard-schema.ts`: the `StandardSchemaV1` namespace, about 60 lines of types, with a comment naming the spec version it was copied from.

The alternative is depending on `@standard-schema/spec`. Rejected: Stator ships its TypeScript source (`package.json` `files: ["src"]`), so an app's `tsc` reads Stator's imports, and a types-only package would have to be a real `dependencies` entry to resolve there. That is a new dependency for 60 lines the Standard Schema authors invite copying.

The file is under `engine/` because `engine/events.ts` and `engine/types.ts` import it and the engine imports nothing outside itself. Everything under `engine/` except `describe.ts` is in the engine hash closure (`server/machine-hash.ts:163-164`), and a change to the engine hash resets every app's sessions on that release. A types-only file erases to nothing in the measured bundle, so this file does not move the hash by itself. `engine/events.ts` and the `define-machine.ts` change do, so 3.2 resets sessions once regardless, and the changeset says so.

### Islands

Does the client need the validator? No. It needs the types, and types are erased. Because every `defineMachine` machine carries schemas from 4.0, this has to hold for a machine that *runs* in the browser too, so the strip is built in 3.2.

What the island bundler does today (`build/islands-esbuild.ts:128-187`, `build/machines.ts` `machineImportUse`; the 3.0.0 changelog entry "What an island's script does with a machine import decides what its bundle gets"): for each import of a machine module it reads the importing script. If every use is `dispatch(X, …)` or `X.name`, the import resolves into the `stator-machine-stub` namespace and loads as `export default { name }`. If the script passes the import to `use()`, reads a named export as a value, or reads a property other than `name`, the import resolves to the real file and its code is bundled.

**An island that dispatches to a machine.** Nothing changes. The stub has no schema and no validator, whatever the vendor. `dispatch(DeskMachine, …)` is typed from the real module's types.

**A machine module that is bundled as code.** New in 3.2: the bundler's `onLoad` for a machine module in the `file` namespace (every machine module that is not stubbed) rewrites the module before esbuild sees it.

- *What is removed.* The argument of each call to `events` (the binding imported from `@statorjs/stator/machine`, under any alias or as a namespace member, found the way `bringsDefineMachine` finds `defineMachine`). `events({ REGISTER: v.object({…}), CLOSE: null })` becomes `events()`. Only the argument expression is deleted. No declaration and no import is touched by the rewrite.
- *What goes with it.* The bundler's own tree-shaking then drops what nothing references: the `import * as v from 'valibot'` when no other code in the bundle uses it, and a module-level `const Register = v.object({…})` that only the map referenced. The first needs the validator's package to be marked side-effect free; the second needs its constructors to be marked pure. Valibot does both. For another vendor the inline map always goes, because Stator deletes it, and a hoisted `const` may stay. The docs write schemas inline in the map or in a shared module for this reason.
- *What the browser def has.* `events()` with no argument returns an empty carrier, so `def.schemas` is `{}`. Nothing in the browser reads it: the engine never validates, and `use()` builds an actor from states and context.
- *How the client still gets the event types.* It never had them at runtime. `use(Cart).send(…)` is typed by `EventOf<typeof Cart>` from the unrewritten source, checked by `stator check` and the editor before any bundling. The rewrite runs on what esbuild loads, after types have done their work.
- *Where it applies.* App islands in `stator dev` and `stator build` alike (one bundler). A machine in a package is rewritten the same way when the app's bundler resolves it, since the rule keys on the resolved file. `build:lib` leaves a `use()`d machine import for the consuming app to bundle (`build/lib-client.ts:19-27`), so it needs no change; a test confirms it.

**An island that references a schema as a value**, to check a form before submit with the same rules the server applies. This keeps working and keeps the validator in the bundle, on purpose.

- The schema lives in a shared module (`lib/rules.ts`, where the registration starter keeps its rule functions today) and both the machine and the island import it. The island's import is its own; the rewrite never sees it.
- Or the machine module exports it (`export const Register = v.object({…})`, used in the map as `REGISTER: Register`) and the island imports `{ Register }` from the machine module. That is a named export read as a value, so the module is bundled as code; the rewrite removes the map's argument, and the `Register` declaration stays because the island references it.
- In both cases the island runs the schema itself (`v.safeParse(Register, fields)`), and the validator is in the bundle because the author put it there. This is where a brought Zod costs its full weight and Valibot costs the functions used.
- `Machine.schemas` is not a way to reach a schema from an island: in a bundle it is absent (a stub) or empty (stripped). `machineImportUse` reports a read of `.schemas` on a machine import in an island script as an error at its line, saying to import the schema by name. `stator check` already runs that analysis without bundling (`islandMachineErrors`), so the mistake is caught there, in the dev overlay and at build.

**What the strip does not do.** It does not remove a schema that other code in the machine module uses (a guard that calls `v.safeParse` on it), and it does not touch client `machine()` machines, which have no map.

### JSON Schema for agent tools

Brief, because the feature is deferred. A tool list reads one schema per key from `def.schemas`. Its JSON Schema comes from the vendor's Standard JSON Schema support, `schema['~standard'].jsonSchema`, when the vendor provides it. Stator guarantees nothing: a schema without it yields `{}` (the agent-tools spec's existing rule for an unschematizable member), and `null` is `{ type: 'object' }`. Zod 4.2+ and ArkType 2.1.28+ implement the interface on the schema; Valibot provides it through `toStandardJsonSchema()` in `@valibot/to-json-schema` (the export exists in 1.8.0). Whether a Valibot app wraps its schemas or the tools pass does is [[agent-tools-from-the-state-graph-the-webmcp-skin]]'s question. 3.2 builds nothing for this beyond `def.schemas`.

### The requirement: 3.2 to 4.0

From 4.0, every event on a `defineMachine` machine is declared in the `events()` map with a schema or `null`. No line is drawn at the wire: an effect completion needs an entry as much as a form submit does. So there is no calculation over which events a route offers. The question per machine is only "is every event in the map".

One config key, beside `events.gate`:

```ts
// config.ts
events?: {
  gate?: 'enforce' | 'warn' | 'off'
  maxBytes?: number
  /** Every defineMachine event declares a schema. Default 'warn' in 3.x, 'require' at 4.0. */
  schemas?: 'off' | 'warn' | 'require'
}
```

| | `off` | `warn` (3.2 default) | `require` (4.0 default) |
|---|---|---|---|
| `stator build` | silent | silent in 3.x (see below) | enforcement to be designed with 4.0 |
| `stator dev` boot | silent | the report, once at boot, and again after a machine edit only if the list changed | the report as errors; dev keeps serving, like its other diagnostics |
| `createApp` (`stator start`, tests) | silent | silent | throws, with the report |
| `stator check` | nothing | nothing | nothing |
| the three doors | validate what has a schema | the same | the same |

`stator check` stays static in every mode: it never imports a machine module, and the report needs loaded defs. `stator build` does not import machine modules today either (it hashes them with esbuild without running them), so in 3.x the report appears at dev boot only. How `build` and `check` enforce the requirement at 4.0, whether by importing machines or by a static read of the `events()` call, is decided with the 4.0 cutover.

**The report.** Computed from the machines `discoverMachines` loads, by one pure function:

```ts
// server/event-schema-report.ts
export function eventsWithoutSchema(defs: readonly AnyMachineDef[]): Array<{ machine: string; map: boolean; events: string[] }>
```

For each def:

1. `known` = the event types the def names as data: every key of every state's `on` and of the machine-level `on` (this is `describeMachine(def).events`, the same set `/__events` already uses for its "handles no event" 400, `http.ts:45-53`), plus each `after` entry's `send.type`, each `subscribes` entry's `dispatch` type, and each `serverOnly` name.
2. If `def.schemas` is `undefined`, the machine declares its events as a type only: every type in `known` is listed, under one line that names the machine and says to move it to `events()`.
3. Otherwise the list is `known` minus the keys of `def.schemas`.
4. A machine with nothing listed is left out. Output is one line per machine with its event types, sorted, and a count.

For a machine that uses `events()`, step 3 is nearly always empty: `on` keys, `after` sends and `serverOnly` are typed against the map's union, so a missing entry is already a compile error. The one untyped source is a `subscribes` entry's `dispatch`, which is a plain string (`engine/types.ts:265`); a delivery name with no entry and no handler shows up here and nowhere else. In practice the 3.x list is "machines still on `{} as E`, with the events each will need to declare", and at 4.0 the same function is the runtime backstop for what a cast, a JavaScript machine or a `subscribes` typo slips past the types.

**What the report cannot see.**

- *A member of a hand-written union that no chart handles.* The type is erased, and nothing in the def names it. Such an event can never commit, and it disappears when the machine moves to a map.
- *An effect's completion type, as such.* It is returned from inside a closure. It is seen only because the chart handles it, which it must for the completion to do anything.
- *A machine that is not discovered.* `discoverMachines` loads the default export of each file directly under `machines/` (`server/discovery.ts:50-55`). A `defineMachine` machine defined elsewhere and run only through `use()` in an island, a named export, and a machine a factory returns are not in the report. At 4.0 they are covered by the type and by `defineMachine` itself, not by the report.
- *Whether a schema checks anything.* `v.any()` and `v.custom(() => true)` are schemas. The report counts entries; it does not grade them. A schema whose output is not an object is found the first time it validates, not at boot.
- *Anything at `stator check`.* By decision.

**What the build has to do that it does not do today.** `stator build` hashes machine files with esbuild and never runs them; it imports a machine module only to stub one for an island (`machineName`) or when a package island dispatches (`build/build.ts:380-386`). The report makes the build import every machine module under `dist/machines`, which runs their top-level code. `createApp` and dev do that on every boot already. If a build environment cannot import a machine (a module that opens a database at import), the report says which file failed and the build goes on under `warn`, and fails under `require`.

**The 4.0 cutover, to record in ROADMAP's major-cutover ledger when 3.2 ships:**

- `events.schemas` defaults to `require`. `warn` and `off` remain as switches.
- `{} as E` is removed. The `events:` key of `defineMachine` accepts only what `events()` returns (a type error otherwise, keyed on the brand), and `defineMachine` throws for an `events` value that carries no map. A machine that handles no events may omit the key.
- `defineMachine` (not only the report) checks that every type in `known` has an entry, so an undiscovered machine is covered.
- Client `machine()` is exempt and reaches the engine through an internal entry.
- The three doors need no change: every machine has a map, so every event they see has a schema or `null`.
- The `zod` dependency is removed. Not before: an npm-hoisted app may be importing it by accident.
- There is no `unchecked` to remove.

### Where each piece lives

| Piece | File |
|---|---|
| Standard Schema types | `packages/stator/src/engine/standard-schema.ts` (new, types only) |
| `events`, `EventsOf`, the brand | `packages/stator/src/engine/events.ts` (new), `engine/index.ts` |
| `def.schemas`, `EventInputOf`, `BrowserEventOf` | `engine/types.ts`, `engine/define-machine.ts` |
| `declared` on the description | `engine/describe.ts` |
| `validateEvent` | `packages/stator/src/server/validate-event.ts` (new) |
| the three doors | `server/http.ts`, `server/api-route.ts`, `server/routing.ts`, `server/app-dispatch.ts`, `server/create-app.ts`, `server/boot.ts`, `server/dev.ts`, `server/dev-native.ts`, `server/effects.ts`, `server/timers.ts` |
| hand-written envelope check | `server/http.ts` |
| the report | `packages/stator/src/server/event-schema-report.ts` (new), `build/build.ts`, `server/dev-native.ts`, `server/create-app.ts` |
| config | `config.ts` (`start.ts` already passes the whole `events` object through, `cli/commands/start.ts:113`) |
| island strip | `build/islands-esbuild.ts`, `build/machines.ts` |
| wire doc | `WIRE.md` |
| the default validator | each example's `package.json`; nothing in `packages/stator/package.json` `dependencies` |

There is no `src/schema/`, no `exports["./schema"]`, no change to `BROWSER_SAFE` in `build/lib-client.ts`, and no `build/event-coverage.ts`.

## Alternatives Considered

- **A built-in validator at `@statorjs/stator/schema`** (this spec's first recommendation). Rejected in the decision record, for the reasons under "The validator: bring your own". Reconsidered only on evidence before 4.0.
- **Re-exporting a vendor** (Zod or Valibot as `@statorjs/stator/schema`). Rejected: it couples Stator's public API and semver to that vendor's majors, as Astro's Zod re-export did, and pins every app to Stator's choice of major.
- **A wire-only requirement line** (4.0 requires a schema only for events a page offers; this spec's first draft, with a coverage calculation over `build/offered-events.ts`). Superseded by the decision record. The line needed an analysis that over-counted (the offered list is by event type, not by machine), left effect completions on a second, untyped-at-runtime tier with `unchecked<T>()`, and kept `{} as E` alive forever. "Every event has a schema" needs no analysis and has one tier.
- **`unchecked<T>()` as a 3.x bridge.** Rejected under "Declaring events".
- **Pass the map straight to `events:`** (`events: { REGISTER: v.object(…) }`). Rejected: `defineMachine` would need `E` computed from a second shape of the same key, in the generic signature whose inference already needs `NoInfer` on every interior position. The helper leaves the signature alone.
- **A `schemas:` key beside `events: {} as E`.** Rejected: the type is then asserted, not inferred, and the two can disagree, which is today's problem with a validator attached.
- **One schema for the whole union** (`events: v.variant('type', […])`). Rejected: no per-event lookup, no per-event JSON Schema and no "which events are declared" without vendor introspection.
- **Validate in the engine's `send`.** Rejected: it makes `send` async or forbids async validators, runs the validator in the browser for `use()`d machines, and re-parses outputs on internal deliveries.
- **Validate every delivery, internal ones too.** Rejected for the double-parse problem, and because an effect's completion is typed against the output by the effect's own return annotation.
- **Hand the machine the input and keep validation as a check only.** Rejected: undeclared keys reach `ctx[ev.field]`-style code, and a schema with a default or transform would type the handler with a value it never receives.
- **Require input and output to be the same type.** A real fallback if the brand proves fragile, but it bans defaults, coercion and transforms, which every schema here could otherwise use.
- **HTTP 200 for a schema failure** (this spec's first draft). Superseded by the decision record here and in [[refused-dispatch-reasons]]: a response that carries a refusal is a 422, and the client transport reads it.
- **Generate schemas from the TypeScript union at build** (the agent-tools build pass, promoted to a validator). Rejected: the wire check would depend on a build step that dev, `createApp` and tests would each have to reproduce, and it cannot express a length or a pattern.
- **Depend on `@standard-schema/spec`.** Rejected under "The Standard Schema types".
- **Compute the report in `stator check`.** Rejected in the decision record: `check` would have to import machine modules, and it is static.
- **Leave schemas in `use()`d machines until an island pays for it** (the first draft). Superseded: once every machine carries schemas, every island that runs one pays.
- **Strip by replacing each schema with `null`, keeping the keys.** Rejected: nothing in the browser reads the keys, and an empty call is the smaller rewrite.

## Open Questions

- **Does the brand hold up?** The input type as an optional symbol-keyed property on each member needs a type-test spike before anything else is built: `Extract` in `OnMap`, effect return annotations, emit payload selectors, the template `send` typing in `template/types.ts`, and hover output. Fallback: input must equal output in 3.2.
- **What do `warn` and `off` mean at 4.0?** The record keeps them as switches and also removes `{} as E`. As specified, the switch governs the build and boot check only, and the type removal is unconditional, so a 4.0 app set to `off` can still boot a machine that no longer typechecks. If the switches are meant to let an app upgrade to 4.0 first and migrate after, the type has to keep accepting `{} as E` under a deprecation; if not, `off` at 4.0 does almost nothing. Needs a decision before the 4.0 PR, not before 3.2.
- **Does the `serverOnly` list go at 4.0?** Once every machine declares its events in the map, the `serverOnly` marker says everything the list does, next to the event it is about. Removing the list is one more cutover for the 4.0 ledger; keeping it costs two spellings of one thing. Recommended: deprecate the list in 3.2 for machines that use `events()`, remove it at 4.0. Needs a decision before the 4.0 PR.
- **Does a schema change reset sessions?** A schema lives in the machine module, so editing it moves that machine's hash and resets its sessions on deploy. The validator's `name@version` is a hash input for every machine whose graph reaches it (`server/machine-hash.ts:25-31`), so a Valibot bump resets the sessions of every machine with a payload schema. Probably right for a tightened schema, noisy for a message edit or a patch release.
- **The build importing every machine module** (under "The requirement"). If that proves unwelcome in CI, the report can run at dev boot only in `warn` and at `createApp` in `require`.
- **Client-side reuse.** An island that runs a schema before submit gets the vendor's issue shape, not the 3.1 `RefusalIssue` shape. A small vendor-neutral helper over `~standard.validate` (`issuesOf(schema, value)`) may be wanted in `@statorjs/stator/client`; wait for the starter to show it.
- **Descriptions for agent tools** on a map (JSDoc on keys, read by a small AST pass, or the vendor's own metadata). Belongs to the agent-tools spec.
- **Server-template forms** (`on:submit` collecting `FormData` into a schema'd event). FormData is all strings; a vendor schema can coerce (`v.pipe(v.string(), v.transform(Number), …)`), which is the input/output split doing its job. Showing issues without an island is the open part. See the same question in [[refused-dispatch-reasons]].
- **The event gate is by event type, not by (machine, type).** `build/offered-events.ts` lists the types a route's UI sends, and `/__events` accepts any session machine by name that handles an offered type. Tightening it is separate roadmap work, recorded in ROADMAP, and nothing here depends on it.

## Implementation Notes

Depends on [[refused-dispatch-reasons]] PRs 1–3 (the client reading 4xx bodies, the `Refusal` type, the envelope field and its 422). PR 1 and PR 4 here touch no file the 3.1 host work touches and can be written before 3.1 merges.

**PR 1 — types and the carrier (M).** `engine/standard-schema.ts`, `engine/events.ts`, `engine/types.ts` (`schemas`, `EventInputOf`, `BrowserEventOf`), `engine/define-machine.ts` (read the carrier), `engine/describe.ts` (`declared`), `engine/index.ts`. Starts with the brand spike. Tests: `tests/event-schemas.test-d.ts` (inference from a map; `null`; input vs output with a transforming fake schema; `OnMap` narrowing; effect completion typing; `{} as E` unchanged; a client `machine()` unchanged), `tests/engine.test.ts` (`def.schemas` populated, `undefined` without a map; the engine never calls `validate`), `tests/describe-machine.test.ts`, `tests/engine-hash.test.ts` (the pinned input list gains `engine/events.ts`). Changeset: minor; engine hash moves, sessions reset once.

**PR 2 — the three doors (M).** `server/validate-event.ts`, `server/http.ts` (the call site; the hand-written envelope check replacing `eventSchema` and the `zod` import, dependency left in `package.json`), `server/api-route.ts`, `server/routing.ts`, `server/app-dispatch.ts` (an internal unvalidated entry for `effects.ts` and `timers.ts`), `server/create-app.ts`, `server/boot.ts`, `server/dev.ts`, `server/dev-native.ts` (the bound `dispatchToApp` types), `server/effects.ts`, `server/timers.ts`, `WIRE.md`. Tests: `tests/event-schemas-wire.test.ts` (invalid → 422 with the envelope, `refusal.code === 'invalid'`, issues, and the actor's commit count unchanged; valid → output reaches the guard with extra keys gone; `null` drops every key but `type`; an unoffered or `serverOnly` event gets its 403 with no issues; a fake with an async `validate`; the issue cap; a type missing from a present map throws), `tests/http.test.ts` and `tests/http-hardening.test.ts` (each malformed-envelope case keeps its 400 under the hand-written check; a machine with no map answers byte-identically to 3.1), `tests/runtime-dispatch.test.ts` (API route), `tests/app-machine-events.test.ts` (`dispatchToApp` validates; an effect completion and an `after` send with a transforming schema are not re-parsed), `tests/events-idempotency.test.ts` (a schema refusal is not recorded and a retry answers the same 422).

**PR 3 — report and config (S).** `server/event-schema-report.ts`, `config.ts`, `build/build.ts` (load the machines, print or fail), `server/dev-native.ts` (at boot and on a changed list), `server/create-app.ts` (`require` throws). Tests: `tests/event-schema-report.test.ts` (a `{} as E` machine lists its handled, `after`, `subscribes` and `serverOnly` types; a mapped machine lists nothing; a mapped machine with a cast-in handler lists that type; a machine with no events is left out; app and session machines alike), `tests/build.test.ts` (`warn` prints and succeeds, `require` fails, `off` is silent; a machine that throws on import is named), `tests/dev-native.test.ts`, `tests/check.test.ts` (`check` prints nothing about schemas and imports no machine).

**PR 4 — island strip (M).** `build/islands-esbuild.ts` (the `onLoad` rewrite for machine modules in the `file` namespace), `build/machines.ts` (locating `events(…)` calls by import; the `.schemas` read error in `machineImportUse`). `packages/stator/package.json` gains `valibot` under `devDependencies`. Tests beside `tests/island-machine-leaks.test.ts` and `tests/island-machine-use.test.ts`: a dispatch-only island contains no schema source and no Valibot; a `use()`d machine with an inline map contains neither and still runs its transitions (`tests/dev-island-machine-use.test.ts` for the dev bundle); a `use()`d machine with a hoisted `const` schema contains neither; an island importing a schema from `lib/` contains it and Valibot; an island importing a named schema export from the machine module contains it and Valibot, and the map argument is still gone; `Machine.schemas` in an island script is an error at its line, in the bundler and in `stator check`; `tests/lib-islands-publish.test.ts` and `tests/library-islands-consume.test.ts` for a package machine. Depends on PR 1 only.

**PR 5 — examples and docs (M).** `examples/registration` (`valibot` in `package.json`; `lib/rules.ts` exports the schema; `machines/desk.ts` moves to `events()` and drops the `unknown` checks the schema now covers; the island pre-checks with the same schema), `examples/desksmith`, and every other example moved to `events()` so the 3.2 scaffolds boot with an empty report (`null`-only examples add no dependency). Docs under `apps/docs/src/content/docs/`: `guides/dispatching-events.md` (replace "What arrives is JSON, not your event type"), `guides/forms-and-inputs.md`, `concepts/events-and-dispatch.md`, `reference/machine.md` (`events()`, the input/output rule), `reference/config.md` (`events.schemas`), `guides/client-components.md` (what an island bundle gets, referencing a schema as a value), `guides/api-routes.md`, `recipes/receiving-webhooks.md`, `recipes/server-only-events.md`, `guides/testing.md`. ROADMAP: the Primitives entry, the agent-tools note, the 4.0 ledger lines above, the per-(machine, type) gate as future work.

**4.0 (M).** Flip the default to `require`; remove `{} as E` from `defineMachine`'s types and add the runtime throw and the `known`-versus-map check in `engine/define-machine.ts`; the internal entry for `client/machine.ts`; drop `zod` from `package.json`; `guides/upgrading-to-4.md`. No `unchecked` to remove. Tests: the type tests flip (`{} as E` is an error), `tests/client-machine-node.test.ts` (client machines unaffected), `tests/root-export.test.ts`. Blocked on the `warn`/`off` open question.

## Decision record (2026-11-22, Tony)

- 4.0 is planned, and requiring a schema for every event that crosses the wire is its reason. The other parked cutovers ride it: the old `reads` names, the 1 MiB default body limit, the `zod` dependency, the root `media/` dir.
- `stator check` stays static. Coverage is computed at `stator build` and at dev boot, not in `check`.
- A schema failure answers 422 with the refusal body, not 200 (see the decision record in [[refused-dispatch-reasons]]).
- **The validator (supersedes "The validator question" and "The built-in" above).** Bring your own Standard Schema validator. Stator ships no built-in and re-exports no vendor. Valibot is the default in docs and scaffolds, listed in the scaffold's `package.json`. `events({ INC: null })` needs no validator, so a payload-free app installs nothing. A built-in is reconsidered only on evidence before 4.0. The body of this spec still describes the built-in and needs revising to match: PR 2 (the built-in validator) is dropped, and the JSON Schema for agent tools comes from the vendor's Standard JSON Schema support.
- **Rollout.** `events.schemas` defaults to `warn` in 3.2 (not `off`), `require` at 4.0.
- **Every event gets a schema (supersedes "Migration: 3.2 to 4.0" above).** From 4.0 every event on a `defineMachine` machine is declared in the `events()` map with a schema or `null`; `{} as Events` and `unchecked<T>()` are removed. No line is drawn at the wire for the requirement, so no coverage calculation over offered events is needed: the `warn` list is the events without a schema. Validation still runs once, where an event enters from outside (`/__events`, API-route `dispatch`, `dispatchToApp`), so those two doors always have a schema to validate against. Engine-raised events (effect completions, timers, emits) are not re-validated. Client-only `machine()` machines are exempt. Consequence: stripping schemas from `use()`d machines in island bundles moves into 3.2 rather than being deferred. In 3.2 `unchecked<T>()` may still be needed as the bridge; decide when the body is revised.
- The event gate's offered list is by event type, not by machine. Making it per (machine, type) is future work recorded in ROADMAP.
- **`zod`.** The envelope check in `server/http.ts` becomes a hand-written check in 3.2; Stator takes no validator dependency of its own. The `zod` entry stays in `package.json` until 4.0 (a hoisted install may be importing it by accident). Valibot is an app-level dependency only.
- Body revised 2026-11-22 to match this record.
- **The report is at dev boot only in 3.x.** `stator build` does not import machine modules today, and making it do so is part of deciding how `build` and `check` enforce the requirement at 4.0. PR 3 therefore does not touch `build/build.ts`.
- **No `unchecked<T>()`.** A machine moves to `events()` whole.
- **`serverOnly<T>()` for events the browser may not send**, named for the existing concept and not `internal`. `serverOnly<T>()` is typed with no validator (effect completions, timers, emit deliveries, and anything server code raises from data it already trusts); `serverOnly(schema)` adds validation at API-route `dispatch` and `dispatchToApp` for a server-only event built from outside data. Both are refused at `/__events` with the existing 403. Body revised to match; PR 1 adds `serverOnly` to `engine/events.ts` and folds marked types into the def's `serverOnly` set; PR 2 needs no new refusal path.
