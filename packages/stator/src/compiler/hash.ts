import { createHash } from 'node:crypto'

/** Deterministic per-component scope hash. Derived from a stable identifier
 *  (the file path when compiling a real file, else the source). 8 hex chars is
 *  ample to avoid collisions across a project's component set. */
export function scopeHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}
