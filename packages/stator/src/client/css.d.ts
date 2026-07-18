// `.css` files are imported as text (esbuild `.css: 'text'` loader in
// `bundleInspector()`), so the default export is the stylesheet source string.
declare module '*.css' {
  const css: string
  export default css
}
