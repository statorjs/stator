import ts from 'typescript'
import { CompileError, type DiagnosticLocation } from './diagnostics.ts'

/**
 * Phase 3b — analyze a component's client `<script>` and its template's
 * custom-element tags, and validate the name-match binding:
 *
 *   <quantity-stepper>  ↔  export class QuantityStepper extends StatorElement
 *
 * The kebab-case tag binds to the PascalCase class of the same name. Checked
 * both directions: a tag with no class, or a class with no tag, is an error.
 * Custom-element names must contain a hyphen (the platform's rule), so a
 * single-word class name is rejected.
 */

export interface ClientElement {
  /** Kebab-case custom-element tag, e.g. `quantity-stepper`. */
  tag: string
  /** PascalCase class name, e.g. `QuantityStepper`. */
  className: string
}

export interface ClientAnalysis {
  /** Custom elements defined by this file (tag ↔ class, name-matched). */
  elements: ClientElement[]
}

/** kebab-case → PascalCase: `quantity-stepper` → `QuantityStepper`. */
export function kebabToPascal(tag: string): string {
  return tag
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

/** PascalCase → kebab-case: `QuantityStepper` → `quantity-stepper`. */
export function pascalToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** A tag is a custom-element tag if it's lowercase and contains a hyphen. */
export function isCustomElementTag(tag: string): boolean {
  return /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(tag)
}

/**
 * Validate the name-match between custom-element tags used in the template and
 * the classes exported from the `<script>`. Returns the matched elements.
 *
 * `script` is the raw `<script>` source; `tags` is the set of custom-element
 * tag names found in the template. `locForTag`/`locForClass` provide diagnostics
 * locations when available.
 */
export function analyzeClient(
  script: string,
  tags: Set<string>,
  opts: { file?: string } = {},
): ClientAnalysis {
  const exportedClasses = extractExportedClasses(script)
  const classByName = new Map(exportedClasses.map((c) => [c.name, c]))

  const elements: ClientElement[] = []

  // Each custom-element tag must have a same-named exported class.
  for (const tag of tags) {
    const className = kebabToPascal(tag)
    if (!classByName.has(className)) {
      throw new CompileError(
        `stator: <${tag}> has no matching client class. Add ` +
          `\`export class ${className} extends StatorElement { ... }\` to the <script>.`,
        loc(opts.file),
      )
    }
    elements.push({ tag, className })
  }

  // Each exported class must have a same-named custom-element tag in the template.
  for (const cls of exportedClasses) {
    const tag = pascalToKebab(cls.name)
    if (!tag.includes('-')) {
      throw new CompileError(
        `stator: client class "${cls.name}" maps to <${tag}>, which is not a valid ` +
          `custom-element name (it needs a hyphen). Use a multi-word name, e.g. ` +
          `"${cls.name}Widget" → <${tag}-widget>.`,
        loc(opts.file),
      )
    }
    if (!tags.has(tag)) {
      throw new CompileError(
        `stator: client class "${cls.name}" has no matching <${tag}> tag in the ` +
          `template. Add the element, or remove the class.`,
        loc(opts.file),
      )
    }
  }

  return { elements }
}

interface ExportedClass {
  name: string
}

/** Find `export class Foo ...` declarations in the script. */
function extractExportedClasses(script: string): ExportedClass[] {
  const sf = ts.createSourceFile('script.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: ExportedClass[] = []
  for (const stmt of sf.statements) {
    if (
      ts.isClassDeclaration(stmt) &&
      stmt.name &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      out.push({ name: stmt.name.text })
    }
  }
  return out
}

function loc(file?: string): DiagnosticLocation | undefined {
  return file ? { file, line: 1, column: 1, frame: '' } : undefined
}
