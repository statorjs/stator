import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

// Starlight's docs collection. docsSchema() accepts unknown extra frontmatter
// keys (e.g. chisel's `created_at`), and maps our `sidebar.order` natively.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
