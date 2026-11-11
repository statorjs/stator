import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'
import { statorCodeTheme } from './src/code-theme.mjs'

// Sidebar groups mirror the chisel docs categories under src/content/docs.
// Each group autogenerates from its directory; intra-group order comes from
// each page's `sidebar.order` frontmatter (which chisel reads/writes too).
export default defineConfig({
  site: 'https://docs.statorjs.dev',
  redirects: {
    '/guides/forms-and-binding/': '/guides/forms-and-inputs/',
  },
  integrations: [
    starlight({
      // Link validation at build time. Relative links are exempt (the
      // Chisel-managed contents page links by bare slug), and the class:list
      // anchor is excluded: the plugin's slugger disagrees with the rendered
      // id for a colon-bearing heading (`#classlist` exists in the DOM).
      plugins: [
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          exclude: ['/guides/directives/#classlist'],
        }),
      ],
      title: 'Stator',
      description:
        'A server-canonical web framework where state machines are the unit of composition and the DOM renders where its state lives.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
      },
      favicon: '/favicon.svg',
      customCss: [
        '@fontsource-variable/space-grotesk',
        '@fontsource-variable/jetbrains-mono',
        './src/styles/tokens.css',
        './src/styles/chrome.css',
        './src/styles/content.css',
        './src/styles/code.css',
      ],
      components: {
        PageTitle: './src/components/PageTitle.astro',
      },
      expressiveCode: {
        themes: [statorCodeTheme],
        minSyntaxHighlightingColorContrast: 0,
        styleOverrides: {
          borderWidth: '4px',
          borderRadius: '12px',
          borderColor: 'var(--st-line)',
          codeBackground: 'var(--st-code-bg)',
          codeForeground: 'var(--st-code-fg)',
          codeFontSize: '0.84375rem',
          codeLineHeight: '1.7',
          codePaddingBlock: '1.125rem',
          codePaddingInline: '1.25rem',
          uiFontFamily: 'var(--__sl-font-mono)',
          uiFontSize: '0.8125rem',
          uiFontWeight: '700',
          focusBorder: 'var(--st-code-fg)',
          scrollbarThumbColor: '#e4e4e033',
          scrollbarThumbHoverColor: '#e4e4e066',
          frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            editorBackground: 'var(--st-code-bg)',
            editorTabBarBackground: 'var(--st-card)',
            editorTabBarBorderColor: 'transparent',
            editorTabBarBorderBottomColor: 'var(--st-line)',
            editorActiveTabBackground: 'var(--st-card)',
            editorActiveTabForeground: 'var(--st-text)',
            editorActiveTabBorderColor: 'transparent',
            editorActiveTabIndicatorHeight: '0px',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabsMarginInlineStart: '0',
            editorTabsMarginBlockStart: '0',
            editorTabBorderRadius: '0',
            terminalBackground: 'var(--st-code-bg)',
            terminalTitlebarBackground: 'var(--st-card)',
            terminalTitlebarForeground: 'var(--st-text)',
            terminalTitlebarBorderBottomColor: 'var(--st-line)',
            terminalTitlebarDotsForeground: 'var(--st-text-2)',
            terminalTitlebarDotsOpacity: '1',
            inlineButtonBackground: 'var(--st-yellow)',
            inlineButtonForeground: 'var(--st-ink)',
            inlineButtonBorder: 'var(--st-code-fg)',
            inlineButtonBorderOpacity: '1',
            inlineButtonBackgroundIdleOpacity: '1',
            inlineButtonBackgroundHoverOrFocusOpacity: '1',
            inlineButtonBackgroundActiveOpacity: '1',
            tooltipSuccessBackground: 'var(--st-violet)',
            tooltipSuccessForeground: 'var(--st-paper)',
          },
          textMarkers: {
            markBackground: '#ffd60a24',
            markBorderColor: 'var(--st-yellow)',
            insBackground: '#8fd6c424',
            insBorderColor: '#8fd6c4',
            insDiffIndicatorColor: '#8fd6c4',
            delBackground: '#ff5a1f2e',
            delBorderColor: 'var(--st-vermilion)',
            delDiffIndicatorColor: '#ff8a5c',
            backgroundOpacity: '100%',
            borderOpacity: '100%',
          },
        },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/statorjs/stator',
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'introduction' },
        },
        { label: 'Tutorial', autogenerate: { directory: 'tutorial' } },
        { label: 'Core Concepts', autogenerate: { directory: 'concepts' } },
        { label: 'Guides', autogenerate: { directory: 'guides' } },
        { label: 'Recipes', autogenerate: { directory: 'recipes' } },
        { label: 'API Reference', autogenerate: { directory: 'reference' } },
        { label: 'Changelog', link: '/changelog/' },
      ],
    }),
  ],
})
