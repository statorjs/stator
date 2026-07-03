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
 * Reserved future ops (not yet emitted, documented for the wire spec):
 *   - 'attr-add' / 'attr-remove' on element targets (per-class toggles)
 *   - 'insert' / 'remove' / 'move' on slot targets (keyed list diffs)
 *   - 'prop' on element targets (IDL property writes that have no attr)
 */
export type Patch =
  | { target: SlotTarget; op: 'text'; value: string }
  | { target: SlotTarget; op: 'html'; value: string }
  | { target: ElementTarget; op: 'attr'; name: string; value: string }

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
}
