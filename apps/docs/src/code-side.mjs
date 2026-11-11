// An Expressive Code plugin: a SERVER or BROWSER chip in a titled code
// block's title bar, saying where that file runs.
//
// `side="server"`, `side="browser"` or `side="none"` in the block's meta
// decides. Without it the title does: routes, machines and the root hooks run
// on the server; a `.stator` file is an island (browser) when it defines a
// StatorElement, and a server component otherwise.
const SERVER_PATH = /^(routes|machines)\/|^(middleware|boot)\.ts$|^stator\.config\.[cm]?[jt]s$/

function sideOf(codeBlock) {
  const explicit = codeBlock.metaOptions.getString('side')
  if (explicit) return explicit === 'server' || explicit === 'browser' ? explicit : undefined
  const title = codeBlock.props.title?.trim()
  if (!title) return undefined
  if (title.endsWith('.stator')) {
    return /extends\s+StatorElement\b/.test(codeBlock.code) ? 'browser' : 'server'
  }
  return SERVER_PATH.test(title) ? 'server' : undefined
}

const find = (node, tag) => {
  if (node.type === 'element' && node.tagName === tag) return node
  for (const child of node.children ?? []) {
    const hit = find(child, tag)
    if (hit) return hit
  }
  return undefined
}

export const codeSide = () => ({
  name: 'stator-code-side',
  hooks: {
    postprocessRenderedBlock: ({ codeBlock, renderData }) => {
      const side = sideOf(codeBlock)
      const header = side && find(renderData.blockAst, 'figcaption')
      if (!header || !find(header, 'span')) return
      header.children.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['side-chip', `side-chip--${side}`] },
        children: [{ type: 'text', value: side.toUpperCase() }],
      })
    },
  },
})
