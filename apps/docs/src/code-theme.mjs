// A VS Code theme for Expressive Code. Code sits on a near-black ground in
// both site themes, so one theme serves both.
const text = '#e4e4e0'
const keyword = '#ff9ccb'
const name = '#ffd60a'
const comment = '#a8a8a4'

export const statorCodeTheme = {
  name: 'stator',
  type: 'dark',
  colors: {
    'editor.background': '#141414',
    'editor.foreground': text,
  },
  tokenColors: [
    { settings: { foreground: text } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: comment },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'constant.language',
        'variable.language.this',
        'entity.name.tag',
        'support.class.component',
        'punctuation.definition.tag',
        'markup.heading',
      ],
      settings: { foreground: keyword },
    },
    {
      scope: ['keyword.operator', 'keyword.operator.assignment', 'keyword.operator.arithmetic'],
      settings: { foreground: text },
    },
    {
      scope: [
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
      ],
      settings: { foreground: keyword },
    },
    {
      scope: [
        'string',
        'punctuation.definition.string',
        'string.template punctuation.definition.template-expression',
        'markup.inline.raw',
      ],
      settings: { foreground: keyword },
    },
    {
      scope: ['meta.template.expression', 'punctuation.definition.template-expression'],
      settings: { foreground: text },
    },
    {
      scope: [
        'meta.object-literal.key',
        'entity.name.function',
        'support.function',
        'entity.other.attribute-name',
        'support.type.property-name',
        'entity.name.command',
        'meta.property-name',
        'markup.bold',
      ],
      settings: { foreground: name },
    },
    { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
    { scope: 'markup.inserted', settings: { foreground: '#8fd6c4' } },
    { scope: 'markup.deleted', settings: { foreground: '#ff8a5c' } },
  ],
}
