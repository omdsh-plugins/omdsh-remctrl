import { defineConfig } from 'vitest/config'

/**
 * Source-plane tests: the specs import `src` directly, so a clean tree needs no
 * build. Every harness import in this package is `import type` and therefore
 * erased before a spec runs, which is what lets `pnpm install && pnpm test`
 * pass on a bare clone against the committed registry pin.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
