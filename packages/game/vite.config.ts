import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  // Relative base so the build can be served by any static server from any path
  // (keeps the road open for M5: daemon hosting the game on the same port, tech-stack §1).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
  },
});
