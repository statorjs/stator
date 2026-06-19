import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'

/**
 * Scope a component's `<style>` content with the attribute approach.
 *
 *   - Each rule's subject compound gets `[data-s-<hash>]` appended, so it only
 *     matches this component's elements (which the compiler marks with the same
 *     attribute). Subject-only scoping (Vue-style) keeps descendant selectors
 *     working without over-constraining ancestors.
 *   - `:global(...)` is unwrapped; if the *subject* is global, that selector is
 *     left unscoped (the escape hatch for reaching outside the component).
 *   - `@keyframes` names are renamed per-hash (and `animation`/`animation-name`
 *     references rewritten) so animations don't leak or collide.
 *
 * Pure function — the Vite plugin calls it, then Vite's own CSS pipeline handles
 * url()/nesting/minify on the result.
 */
export function scopeCss(css: string, hash: string): string {
  const attr = `data-s-${hash}`
  const root = postcss.parse(css)

  // 1. Rename @keyframes and rewrite references.
  const renamed = new Map<string, string>()
  root.walkAtRules((at) => {
    if (/^(-\w+-)?keyframes$/i.test(at.name)) {
      const from = at.params.trim()
      const to = `${from}-${hash}`
      renamed.set(from, to)
      at.params = to
    }
  })
  if (renamed.size > 0) {
    root.walkDecls((decl) => {
      if (decl.prop === 'animation-name') {
        decl.value = decl.value
          .split(',')
          .map((n) => renamed.get(n.trim()) ?? n.trim())
          .join(', ')
      } else if (decl.prop === 'animation') {
        decl.value = decl.value
          .split(',')
          .map((part) =>
            part
              .trim()
              .split(/\s+/)
              .map((tok) => renamed.get(tok) ?? tok)
              .join(' '),
          )
          .join(', ')
      }
    })
  }

  // 2. Scope each rule's selectors (skip keyframe step selectors).
  root.walkRules((rule) => {
    const parent = rule.parent
    if (parent && parent.type === 'atrule' && /keyframes$/i.test((parent as postcss.AtRule).name)) {
      return
    }
    rule.selector = scopeSelectorList(rule.selector, attr)
  })

  return root.toString()
}

function scopeSelectorList(selector: string, attr: string): string {
  const transform = selectorParser((selectors) => {
    selectors.each((sel) => {
      // Is the subject (last compound) inside :global()? Compute before unwrap.
      const subjectIsGlobal = isSubjectGlobal(sel)

      // Unwrap every :global(...) to its inner nodes.
      sel.walkPseudos((pseudo) => {
        if (pseudo.value === ':global') {
          const inner = pseudo.nodes[0]
          if (inner && inner.nodes.length > 0) {
            pseudo.replaceWith(...inner.nodes.map((n) => n.clone()))
          } else {
            pseudo.remove()
          }
        }
      })

      if (subjectIsGlobal) return

      // Insert the scope attribute after the subject's last simple selector,
      // before any trailing pseudo-elements (::before, ::after).
      const nodes = sel.nodes
      let insertAfter: selectorParser.Node | undefined
      for (const node of nodes) {
        if (node.type === 'combinator') {
          insertAfter = undefined // reset at each combinator; track the subject only
          continue
        }
        if (node.type === 'pseudo' && node.value.startsWith('::')) continue // pseudo-element stays last
        insertAfter = node
      }
      const attrNode = selectorParser.attribute({
        attribute: attr,
        value: undefined,
        raws: {},
        quoteMark: null,
      } as never)
      if (insertAfter) sel.insertAfter(insertAfter as never, attrNode)
      else sel.append(attrNode)
    })
  })
  return transform.processSync(selector)
}

/** True when the selector's subject compound (after the last combinator) is
 *  inside a `:global(...)`. */
function isSubjectGlobal(sel: selectorParser.Selector): boolean {
  const nodes = sel.nodes
  let lastCombinator = -1
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i]!.type === 'combinator') {
      lastCombinator = i
      break
    }
  }
  for (let i = lastCombinator + 1; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.type === 'pseudo' && n.value === ':global') return true
  }
  return false
}
