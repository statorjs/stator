/**
 * The wire protocol — the single source of truth for every shape that crosses
 * the server/client boundary. Documented in WIRE.md; produced by
 * `server/recompute.ts` and the API-route envelope; consumed by the client
 * runtime and island dispatch via `wire/apply.ts`.
 *
 * This module is types-only (no DOM, no server imports) so both sides can
 * import it. Keep it that way: a new patch op or directive is added HERE and
 * nowhere else — producers and appliers then fail to typecheck until they
 * handle it.
 */

/** Slot positions (data-slot) vs element identities (data-stator-id) — the
 *  two addressing dimensions, orthogonal to the op. */
export type SlotTarget = { kind: 'slot'; id: string }
export type ElementTarget = { kind: 'element'; id: string }
export type PatchTarget = SlotTarget | ElementTarget

/**
 * Wire patch. Addressing is a discriminated `target` and the op describes
 * what to do at that target.
 *
 * The keyed-list ops (`insert`/`remove`/`move`) address element children of a
 * list slot **by index, sequentially**: each op's indices refer to the DOM
 * state after every preceding op in the batch has been applied. The server
 * emits them from a replay simulation, so a batch is deterministic.
 *
 * Reserved future ops (not yet emitted, documented for the wire spec):
 *   - 'attr-add' / 'attr-remove' on element targets (per-class toggles)
 *   - 'prop' on element targets (IDL property writes that have no attr)
 */
export type Patch =
  | { target: SlotTarget; op: 'text'; value: string }
  | { target: SlotTarget; op: 'html'; value: string }
  /** `value: null` removes the attribute — boolean attributes (disabled,
   *  checked, open, …) toggle by presence, so the wire must express absence. */
  | { target: ElementTarget; op: 'attr'; name: string; value: string | null }
  | { target: SlotTarget; op: 'insert'; index: number; value: string }
  | { target: SlotTarget; op: 'remove'; index: number }
  | { target: SlotTarget; op: 'move'; from: number; to: number }

/** A client directive describing a side effect the client should perform
 *  after applying patches. See the response-directives spec for the full list. */
export type Directive =
  | { type: 'navigate'; to: string }
  | { type: 'reload' }
  | { type: 'push-url'; to: string }
  | { type: 'replace-url'; to: string }
  | { type: 'focus'; target: { kind: 'slot' | 'element'; id: string } }
  | {
      type: 'scroll'
      target: { kind: 'slot' | 'element'; id: string }
      behavior?: 'smooth' | 'auto'
    }
  | { type: 'event'; name: string; detail?: unknown }

/** The JSON envelope carried by `/__events` responses, API-route responses,
 *  and SSE messages. */
export interface WireEnvelope {
  patches?: Patch[]
  directives?: Directive[]
  /** POST /__events only: whether the event committed a transition (any
   *  machine touched). Distinguishes a guard-dropped event (HTTP 200, zero
   *  patches, committed: false) from a committed one that happened to patch
   *  nothing on this page. */
  committed?: boolean
}
