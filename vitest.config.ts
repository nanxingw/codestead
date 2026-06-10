import { defineConfig } from 'vitest/config';

// Root-level projects mode (tech-stack §1): `pnpm test` runs all packages,
// and any new package under packages/* with a vitest.config.ts is picked up automatically.
export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
    },
  },
});
