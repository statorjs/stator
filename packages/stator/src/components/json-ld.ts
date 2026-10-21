import type { Graph, Thing, WithContext } from 'schema-dts'
import { raw } from '../template/html.ts'
import type { HtmlFragment } from '../template/types.ts'

/**
 * `<JsonLd>` — render a typed schema.org JSON-LD `<script>` block.
 *
 * The payload is typed against `schema-dts`, serialized once, and emitted as a
 * raw `<script type="application/ld+json">` via `raw()`. There is no literal
 * `<script>` in any template, so it sidesteps both text auto-escaping and the
 * inline-`<script>`-is-a-client-component rule — a server data block is neither.
 *
 *   import { JsonLd } from '@statorjs/stator/components'
 *   <JsonLd json={{ "@type": "Product", name: "Pocket Notebook" }} />
 */
export interface JsonLdProps {
  /** A single schema.org entity, or an array (rendered as an `@graph`). */
  json: Thing | Thing[]
  /** Pretty-print indent, forwarded to {@link JSON.stringify}. */
  space?: string | number
}

export function JsonLd(props: JsonLdProps): HtmlFragment {
  return raw(`<script type="application/ld+json">${ldToString(props.json, props.space)}</script>`)
}

type JsonValue = string | boolean | number | null | Array<JsonValue> | { [key: string]: JsonValue }

const stripNulls = (_: string, value: JsonValue): JsonValue | undefined =>
  value === null ? undefined : value

/**
 * Escape the serialized JSON for a `<script>` element, per
 * https://www.w3.org/TR/json-ld11/#restrictions-for-contents-of-json-ld-script-elements
 * Script content is raw text to the HTML parser, so HTML entities would reach
 * consumers literally; JSON `\uXXXX` escapes decode back to the real characters.
 * Escaping `<` is what guarantees no `</script>` breakout.
 */
function escapeForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function withContext<T extends Thing>(thing: T): WithContext<T> {
  return {
    '@context': 'https://schema.org',
    ...(thing as object),
  } as WithContext<T>
}

function asGraph(things: Thing[]): Graph {
  return { '@context': 'https://schema.org', '@graph': things }
}

/** Serialize one entity (with `@context`) or many (as an `@graph`) to a
 *  JSON-LD string, safe to embed verbatim in a `<script>` element. */
export function ldToString(json: Thing | Thing[], space?: number | string): string {
  const ld = Array.isArray(json) ? asGraph(json) : withContext(json)
  return escapeForScript(JSON.stringify(ld, stripNulls, space))
}
