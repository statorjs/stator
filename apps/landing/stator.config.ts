import { defineConfig } from '@statorjs/stator/config'

export default defineConfig({
  build: {
    // TODO: drop once the build copies directories that only an island's <script> imports.
    include: ['lib'],
  },
})
