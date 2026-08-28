import { defineConfig } from '@statorjs/stator/config'

export default defineConfig({
  // Uploaded photos — runtime data like the SQLite file, outside static/.
  // The framework image endpoint serves them at /media/* with on-demand
  // variants (extension = delivery format, ?w= from the allowlist).
  images: { dir: process.env.INDIE_BLOG_MEDIA ?? 'media', path: '/media' },
})
