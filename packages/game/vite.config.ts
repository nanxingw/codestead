import { cpSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * Runtime-loaded game data lives at the package root per GDD §11.7 (assets/, maps/ —
 * PreloadScene fetches the ASSET_PATHS strings at runtime, no bundling). The dev
 * server serves the package root as-is; production builds need the same tree copied
 * into dist/ (Vite only copies `publicDir`, which we keep unset to avoid moving the
 * §11.7 layout).
 */
function copyGameData(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url));
  return {
    name: 'codestead:copy-game-data',
    apply: 'build',
    closeBundle(): void {
      for (const dir of ['assets', 'maps']) {
        const src = `${root}${dir}`;
        if (existsSync(src)) cpSync(src, `${root}dist/${dir}`, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  // Relative base so the build can be served by any static server from any path
  // (keeps the road open for M5: daemon hosting the game on the same port, tech-stack §1).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [copyGameData()],
  build: {
    target: 'es2022',
  },
});
