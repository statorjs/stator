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

type JsonValueScalar = string | boolean | number
type JsonValue = JsonValueScalar | Array<JsonValue> | { [key: string]: JsonValue }
type JsonReplacer = (_: string, value: JsonValue) => JsonValue | undefined

const ESCAPE_ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
})
const ESCAPE_REGEX = new RegExp(`[${Object.keys(ESCAPE_ENTITIES).join('')}]`, 'g')
const ESCAPE_REPLACER = (t: string): string => ESCAPE_ENTITIES[t as keyof typeof ESCAPE_ENTITIES]

/**
 * A `JSON.stringify` replacer that strips JSON-LD of HTML sequences illegal in a
 * `<script>` element, per
 * https://www.w3.org/TR/json-ld11/#restrictions-for-contents-of-json-ld-script-elements
 * Escaping `<`/`>` is what guarantees no `</script>` breakout in the raw output.
 */
const safeJsonLdReplacer: JsonReplacer = (_: string, value: JsonValue): JsonValue | undefined => {
  switch (typeof value) {
    case 'object':
      // Omit null values.
      if (value === null) return undefined
      return value // JSON.stringify recurses, re-applying this replacer.
    case 'number':
    case 'boolean':
    case 'bigint':
      return value // Not risky.
    case 'string':
      return value.replace(ESCAPE_REGEX, ESCAPE_REPLACER)
    default: {
      // No other types are expected; JSON.stringify drops an `undefined` return.
      isNever(value)
      return undefined
    }
  }
}

function isNever(_: never): void {}

function withContext<T extends Thing>(thing: T): WithContext<T> {
  return { '@context': 'https://schema.org', ...(thing as object) } as WithContext<T>
}

function asGraph(things: Thing[]): Graph {
  return { '@context': 'https://schema.org', '@graph': things }
}

/** Serialize one entity (with `@context`) or many (as an `@graph`) to a
 *  JSON-LD string, safe to embed verbatim in a `<script>` element. */
export function ldToString(json: Thing | Thing[], space?: number | string): string {
  const ld = Array.isArray(json) ? asGraph(json) : withContext(json)
  return JSON.stringify(ld, safeJsonLdReplacer, space)
}
