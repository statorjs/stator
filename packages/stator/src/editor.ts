/**
 * The editor contract: types the Stator language server reads from the
 * PROJECT's own install of `@statorjs/stator`, never from the copy bundled in
 * the editor extension.
 *
 * The extension updates on its own schedule while each project pins a Stator
 * version, so anything the editor shows about Stator's API must come from the
 * project. The language server checks whether the installed package exports
 * this subpath. When it does, every `.stator` file's virtual code types the
 * `Stator` macros from `StatorMacros` here, so a project on any release sees
 * exactly that release's surface, and a renamed or removed macro is a type
 * error only in the releases that removed it. When it does not (releases
 * before this subpath existed), the server falls back to a frozen copy of the
 * shape those releases had.
 *
 * Keep this module type-only. Changing `StatorMacros` changes what the editor
 * accepts for projects on this release and later, and nothing else.
 */

import type { AnyMachineDef } from './engine/index.ts'
import type { InstanceOf, StatorIntrinsicElements } from './template/index.ts'

/** The `Stator.*` macros a `.stator` frontmatter can use. The compiler
 *  rewrites each one; these types are what the editor checks them against. */
export interface StatorMacros {
  /** A component's props, typed by `P`. */
  props<P>(): P
  /** A route's machine bindings, one instance per def, in order. */
  reads<const T extends readonly AnyMachineDef[]>(
    defs: T,
  ): { -readonly [K in keyof T]: InstanceOf<T[K]> }
  /** A directive a parent forwarded onto this component (`on:*` only). */
  forwarded(name: `on:${string}`): (() => unknown) | undefined
  // biome-ignore lint/suspicious/noExplicitAny: the route request is untyped in the editor today, as in the bundled shape
  request: any
  response: {
    status: number
    headers: Headers
    // biome-ignore lint/suspicious/noExplicitAny: matches the bundled shape
    cookies: any
  }
}

/** The intrinsic elements the editor's JSX namespace extends. */
export type { StatorIntrinsicElements }
