import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// Sidebar groups mirror the chisel docs categories under src/content/docs.
// Each group autogenerates from its directory; intra-group order comes from
// each page's `sidebar.order` frontmatter (which chisel reads/writes too).
export default defineConfig({
  integrations: [
    starlight({
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
        { label: 'API Reference', autogenerate: { directory: 'reference' } },
      ],
    }),
  ],
})
