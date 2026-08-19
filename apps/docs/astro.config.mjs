import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'

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
