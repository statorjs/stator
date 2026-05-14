import {
  allocElementId,
  type RenderState,
  type ElementId,
} from '../server/render-context.ts'

type Mode =
  | 'text'
  | 'after_lt'
  | 'tag_name'
  | 'in_tag'
  | 'attr_name'
  | 'attr_after_eq'
  | 'attr_value_dq'
  | 'attr_value_sq'
  | 'closing_tag'

export type ValuePosition =
  | { kind: 'text' }
  | {
      kind: 'attr-value'
      attrName: string
      elementId: ElementId
      /** True if the static template literal had any non-whitespace content
       *  in this attribute value before the interpolation. Used to enforce
       *  the one-source-per-attribute rule. */
      hasLiteralText: boolean
    }
  | { kind: 'directive'; elementId: ElementId }
  | { kind: 'invalid'; reason: string }

/**
 * Streaming HTML builder. Consume static template strings via pushStatic, then
 * call positionForValue between strings to learn where an interpolation will land.
 * For directive / attr-value positions, the parser will assign a data-stator-id
 * to the parent element on demand via ensureCurrentElementId / addAttribute.
 */
export class HtmlBuilder {
  private chunks: string[] = []
  private mode: Mode = 'text'

  // Position in chunks where additional attributes for the current open tag
  // should be spliced in. Null when not inside a tag-open.
  private tagOpenInsertIdx: number | null = null
  private currentElementId: ElementId | null = null

  // The attribute name currently being built or just completed.
  private attrNameBuf = ''

  // Whether the current attribute value has any non-whitespace literal text.
  // Reset when an attribute value starts (opening quote) and consulted at
  // interpolation time to enforce the one-source-per-attribute rule.
  private attrValueLiteralHasText = false

  constructor(private readonly state: RenderState) {}

  pushStatic(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.consume(s[i]!)
    }
  }

  /** Append raw HTML at the current position (text content only). */
  pushRaw(s: string): void {
    if (this.mode !== 'text' && this.mode !== 'attr_value_dq' && this.mode !== 'attr_value_sq') {
      throw new Error(
        `stator: cannot insert content at this position (parser mode: ${this.mode})`,
      )
    }
    this.chunks.push(s)
  }

  /** Classify the next interpolation's position based on current parser state. */
  positionForValue(): ValuePosition {
    if (this.mode === 'text') return { kind: 'text' }
    if (this.mode === 'attr_value_dq' || this.mode === 'attr_value_sq') {
      const elementId = this.ensureCurrentElementId()
      return {
        kind: 'attr-value',
        attrName: this.attrNameBuf,
        elementId,
        hasLiteralText: this.attrValueLiteralHasText,
      }
    }
    if (this.mode === 'in_tag' || this.mode === 'tag_name') {
      const elementId = this.ensureCurrentElementId()
      return { kind: 'directive', elementId }
    }
    if (this.mode === 'attr_name') {
      return {
        kind: 'invalid',
        reason: 'cannot interpolate inside an attribute name; use a directive instead',
      }
    }
    if (this.mode === 'attr_after_eq') {
      return {
        kind: 'invalid',
        reason: 'unquoted attribute values are not supported; wrap the value in quotes',
      }
    }
    return { kind: 'invalid', reason: `unexpected parser state: ${this.mode}` }
  }

  /**
   * Add an attribute to the current open tag.
   * Throws if not currently inside a tag-open.
   */
  addAttribute(name: string, value: string): ElementId {
    if (this.tagOpenInsertIdx === null) {
      throw new Error('stator: addAttribute called outside of an open tag')
    }
    const id = this.ensureCurrentElementId()
    this.chunks.splice(this.tagOpenInsertIdx, 0, ` ${name}="${escapeAttribute(value)}"`)
    this.tagOpenInsertIdx += 1
    return id
  }

  /**
   * Ensure the current open tag has a data-stator-id and return it.
   * Throws if not currently inside a tag-open.
   */
  ensureCurrentElementId(): ElementId {
    if (this.tagOpenInsertIdx === null) {
      throw new Error('stator: ensureCurrentElementId called outside of an open tag')
    }
    if (!this.currentElementId) {
      this.currentElementId = allocElementId(this.state)
      this.chunks.splice(
        this.tagOpenInsertIdx,
        0,
        ` data-stator-id="${this.currentElementId}"`,
      )
      this.tagOpenInsertIdx += 1
    }
    return this.currentElementId
  }

  toString(): string {
    return this.chunks.join('')
  }

  private consume(c: string): void {
    switch (this.mode) {
      case 'text':
        this.chunks.push(c)
        if (c === '<') this.mode = 'after_lt'
        return

      case 'after_lt':
        this.chunks.push(c)
        if (c === '/') {
          this.mode = 'closing_tag'
        } else if (isAlpha(c)) {
          this.mode = 'tag_name'
        } else {
          this.mode = 'text'
        }
        return

      case 'tag_name':
        if (isAlphaNum(c) || c === '-') {
          this.chunks.push(c)
          return
        }
        // tag name ends — record splice position before consuming this char
        this.tagOpenInsertIdx = this.chunks.length
        this.currentElementId = null
        this.mode = 'in_tag'
        this.handleInTag(c)
        return

      case 'in_tag':
        this.handleInTag(c)
        return

      case 'attr_name':
        if (isAlphaNum(c) || c === '-' || c === '_' || c === ':') {
          this.attrNameBuf += c
          this.chunks.push(c)
          return
        }
        if (c === '=') {
          this.chunks.push(c)
          this.mode = 'attr_after_eq'
          return
        }
        // attr name ended without '=' — boolean attribute or end of tag
        if (c === '>') {
          this.chunks.push(c)
          this.tagOpenInsertIdx = null
          this.currentElementId = null
          this.attrNameBuf = ''
          this.mode = 'text'
          return
        }
        this.chunks.push(c)
        this.attrNameBuf = ''
        this.mode = 'in_tag'
        return

      case 'attr_after_eq':
        if (c === '"') {
          this.chunks.push(c)
          this.attrValueLiteralHasText = false
          this.mode = 'attr_value_dq'
          return
        }
        if (c === "'") {
          this.chunks.push(c)
          this.attrValueLiteralHasText = false
          this.mode = 'attr_value_sq'
          return
        }
        // Unquoted attribute value — POC requires quotes, but be lenient on whitespace/>.
        if (c === '>' || isWhitespace(c)) {
          this.chunks.push(c)
          this.attrNameBuf = ''
          if (c === '>') {
            this.tagOpenInsertIdx = null
            this.currentElementId = null
            this.mode = 'text'
          } else {
            this.mode = 'in_tag'
          }
          return
        }
        // tolerate but treat as in_tag
        this.chunks.push(c)
        this.mode = 'in_tag'
        return

      case 'attr_value_dq':
        this.chunks.push(c)
        if (c === '"') {
          this.attrNameBuf = ''
          this.mode = 'in_tag'
        } else if (!isWhitespace(c)) {
          this.attrValueLiteralHasText = true
        }
        return

      case 'attr_value_sq':
        this.chunks.push(c)
        if (c === "'") {
          this.attrNameBuf = ''
          this.mode = 'in_tag'
        } else if (!isWhitespace(c)) {
          this.attrValueLiteralHasText = true
        }
        return

      case 'closing_tag':
        this.chunks.push(c)
        if (c === '>') this.mode = 'text'
        return
    }
  }

  private handleInTag(c: string): void {
    if (c === '>') {
      this.chunks.push(c)
      this.tagOpenInsertIdx = null
      this.currentElementId = null
      this.attrNameBuf = ''
      this.mode = 'text'
      return
    }
    if (isWhitespace(c) || c === '/') {
      this.chunks.push(c)
      return
    }
    if (isAlpha(c) || c === '_' || c === ':' || c === '@') {
      this.attrNameBuf = c
      this.chunks.push(c)
      this.mode = 'attr_name'
      return
    }
    this.chunks.push(c)
  }
}

function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
function isAlphaNum(c: string): boolean {
  return isAlpha(c) || (c >= '0' && c <= '9')
}
function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
}

export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
