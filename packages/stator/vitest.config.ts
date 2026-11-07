import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests exercise failure paths on purpose (403s, snapshot recovery) —
    // silence the framework logger so the runner's output stays readable.
    // Export LOG_LEVEL to bring any level back while debugging.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
