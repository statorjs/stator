/**
 * The framework's machine API now lives in `../engine` — Stator's own
 * isomorphic state-machine engine (replacing the XState-backed POC). This
 * module re-exports it so existing server-side imports keep resolving, and
 * adds the small back-compat alias the glue layer still references.
 */
export * from '../engine/index.ts'

/** The dispatch shape a subscription delivers to its target. */
export type SubscribeEvent = string | { type: string; [k: string]: unknown }
