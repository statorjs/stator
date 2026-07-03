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
  return analyzeScriptClasses(script).map((c) => ({ name: c.name }))
}

/** Per-island analysis used by client codegen: which fields are `use()` client
 *  actors (field name → the machine identifier they instantiate) and the class's
 *  method names (so `on:click={inc}` can resolve `inc` to a method). */
export interface ScriptClass {
  name: string
  /** field name → machine identifier (e.g. `qty` → `Qty`). These are the
   *  reactive dependencies a `bind:`/`on:` expression can reference. */
  useFields: Map<string, string>
  /** method names declared on the class. */
  methods: Set<string>
  /** every member name (fields + methods) — for rewriting a template
   *  expression's class-member references to `this.<member>`. */
  members: Set<string>
  /** declared attribute surface from `static attrs = { unitPrice: Number, ... }`:
   *  camelCase prop name → value kind (drives server prop→attr rendering + types). */
  staticAttrs: Map<string, AttrKind>
}

export type AttrKind = 'number' | 'string' | 'boolean'

function attrKindOf(coercer: ts.Expression): AttrKind {
  if (ts.isIdentifier(coercer)) {
    if (coercer.text === 'Number') return 'number'
    if (coercer.text === 'Boolean') return 'boolean'
  }
  return 'string' // String, or any custom coercer → serialize as a string attribute
}

export function analyzeScriptClasses(script: string): ScriptClass[] {
  const sf = ts.createSourceFile(
    'script.ts',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const out: ScriptClass[] = []
  for (const stmt of sf.statements) {
    if (
      !ts.isClassDeclaration(stmt) ||
      !stmt.name ||
      !stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue
    }
    const useFields = new Map<string, string>()
    const methods = new Set<string>()
    const members = new Set<string>()
    const staticAttrs = new Map<string, AttrKind>()
    for (const member of stmt.members) {
      // `static attrs = { unitPrice: Number, selected: Boolean }`
      if (
        ts.isPropertyDeclaration(member) &&
        member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'attrs' &&
        member.initializer &&
        ts.isObjectLiteralExpression(member.initializer)
      ) {
        for (const p of member.initializer.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
            staticAttrs.set(p.name.text, attrKindOf(p.initializer))
          }
        }
        continue
      }
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
        members.add(member.name.text)
        const init = member.initializer
        // `field = use(Machine, ...)` → reactive client actor.
        if (
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'use' &&
          init.arguments[0] &&
          ts.isIdentifier(init.arguments[0])
        ) {
          useFields.set(member.name.text, (init.arguments[0] as ts.Identifier).text)
        }
      } else if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
        methods.add(member.name.text)
        members.add(member.name.text)
      }
    }
    out.push({
      name: stmt.name.text,
      useFields,
      methods,
      members,
      staticAttrs,
    })
  }
  return out
}

function loc(file?: string): DiagnosticLocation | undefined {
  return file ? { file, line: 1, column: 1, frame: '' } : undefined
}

/**
 * A `bind:` / `on:` directive collected from a client component's template
 * (Phase 3b stage 4). The marker addresses the node at runtime
 * (`data-b="<marker>"` ↔ `this.querySelector('[data-b="<marker>"]')`); stage 5
 * emits the wiring from this.
 */
export interface ClientDirective {
  /** Unique node marker, e.g. `b0`. The element gets `data-b="b0"`. */
  marker: string
  kind: 'on' | 'bind'
  /** on: the DOM event name (`click`). */
  event?: string
  /** bind: the target (`text` / `html` / `value` / `checked` / `disabled` / attr). */
  target?: string
  /** The author expression (handler for on:, value for bind:). */
  expr: string
  /** Reactive client-actor deps referenced by the expression (`use()` fields).
   *  Only meaningful for `bind:`; `on:` handlers fire on the event, not on state. */
  deps: string[]
}

/**
 * Infer which `use()` client actors an expression depends on: the identifiers it
 * references whose name is a known use-field, excluding the property-name side of
 * member access (so `qty.count` → `qty`, `qty.count + other.x` → `qty, other`).
 */
export function inferDeps(expr: string, useFields: Set<string>): string[] {
  const sf = ts.createSourceFile(
    'e.ts',
    `(${expr})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const found = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const isPropName = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
      if (!isPropName && useFields.has(n.text)) found.add(n.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...found]
}
