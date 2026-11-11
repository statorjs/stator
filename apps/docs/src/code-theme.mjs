// A VS Code theme for Expressive Code, in the landing page's token colours.
// Code sits on a near-black ground in both site themes, so one theme serves both.
const text = '#e4e4e0'
const keyword = '#ff4fa3'
const string = '#ffd60a'
const call = '#b9a5ff'
const name = '#8fd6c4'
const number = '#ff8a5c'
const comment = '#8f8f8a'

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
      settings: { foreground: comment, fontStyle: 'italic' },
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
      settings: { foreground: string },
    },
    {
      scope: ['meta.template.expression', 'punctuation.definition.template-expression'],
      settings: { foreground: text },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
        'entity.other.attribute-name',
        'entity.name.command',
        'markup.bold',
      ],
      settings: { foreground: call },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
        'support.class.component',
      ],
      settings: { foreground: name },
    },
    {
      // Property names are data, not types: CSS and JSON keys stay plain.
      scope: ['support.type.property-name', 'meta.object-literal.key', 'meta.property-name'],
      settings: { foreground: text },
    },
    { scope: ['constant.numeric', 'keyword.other.unit'], settings: { foreground: number } },
    { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
    { scope: 'markup.inserted', settings: { foreground: name } },
    { scope: 'markup.deleted', settings: { foreground: number } },
  ],
}
