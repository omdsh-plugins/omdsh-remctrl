import { defineConfig } from 'vitest/config'

/**
 * Source-plane tests: the specs import `src` directly, so a clean tree needs no
 * build.
 *
 * There is no harness alias table here and there does not need to be. The host
 * half imports no harness package at all — its listener, its hashing and its
 * randomness are `node:http`, `node:crypto` and `node:os` — and the browser
 * half's only harness imports are `import type`, erased before a spec runs. So
 * `pnpm install && pnpm test` passes on a bare clone against the committed
 * registry pin, with nothing resolved out of a checkout.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // node by default; specs touching the browser half opt in with a per-file
    // `// @vitest-environment jsdom` pragma (harness convention).
    environment: 'node',
    globals: false,
  },
})
