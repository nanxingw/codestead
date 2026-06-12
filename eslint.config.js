// Single root flat config, differentiated per package (tech-stack §1).
// Prettier owns ALL formatting; ESLint owns correctness & architecture boundaries.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.husky/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting across the monorepo; each package's tsconfig.json
        // (the broad, noEmit one) covers its src + tests + config files.
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Convention: leading underscore marks intentionally unused (incl. rest-destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Plain JS files (configs) don't get type-aware rules.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Node test fixtures executed as standalone processes (e.g. the M4 stub-claude
  // fake CLI, PRD 05 seam e) run in a Node runtime — declare its globals so
  // no-undef doesn't flag Buffer/timers. Scoped to test fixtures only.
  {
    files: ['packages/*/test/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  // ---- Architecture boundary: idb-keyval is only allowed inside game's storage module
  // (game-design §10.1). The rule exists from M0 so it is already law when M1 adds saves.
  {
    files: ['packages/game/src/**/*.ts'],
    ignores: ['packages/game/src/storage/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'idb-keyval',
              message:
                'idb-keyval may only be imported inside packages/game/src/storage/** (game-design §10.1).',
            },
          ],
        },
      ],
    },
  },
  // ---- Architecture boundary: hud/ is the pure session-HUD store (M2, PRD 03 US61;
  // hud-sessions §13-5). Two laws, ESLint-enforced rather than oral discipline:
  //   1. ZERO sim imports — “HUD 与经济零绑定” is an architecture fact: session state
  //      never reads or writes farm state (acceptance §13-5 automated assertion);
  //   2. ZERO Phaser — the store is headless-testable; rendering belongs to the
  //      UIScene-side render shell, which only READS this store.
  // NOTE: rules don't merge across configs, so this block repeats the idb-keyval ban.
  {
    files: ['packages/game/src/hud/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message:
                'hud/** is the pure HUD store — Phaser stays in the render shell (hud-sessions §13-5, PRD 03).',
            },
            {
              name: 'idb-keyval',
              message:
                'idb-keyval may only be imported inside packages/game/src/storage/** (game-design §10.1).',
            },
          ],
          patterns: [
            {
              group: ['phaser/*'],
              message:
                'hud/** is the pure HUD store — Phaser stays in the render shell (hud-sessions §13-5, PRD 03).',
            },
            {
              group: ['**/sim/**'],
              message:
                'HUD store has ZERO imports from sim — session state and the farm economy are never coupled (hud-sessions §13-5, PRD 03 US61).',
            },
          ],
        },
      ],
    },
  },
  // ---- Architecture boundary: audio/ is the pure AudioDirector reducer (M3, PRD 04;
  // game-design §11.6) — sim events in, command lists out. Phaser stays in the thin
  // playback shell, which only EXECUTES commands; the reducer is replay-testable
  // without an AudioContext. NOTE: repeats the idb-keyval ban (rules don't merge).
  {
    files: ['packages/game/src/audio/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message:
                'audio/** is the pure AudioDirector reducer — Phaser stays in the playback shell (game-design §11.6, PRD 04).',
            },
            {
              name: 'idb-keyval',
              message:
                'idb-keyval may only be imported inside packages/game/src/storage/** (game-design §10.1).',
            },
          ],
          patterns: [
            {
              group: ['phaser/*'],
              message:
                'audio/** is the pure AudioDirector reducer — Phaser stays in the playback shell (game-design §11.6, PRD 04).',
            },
          ],
        },
      ],
    },
  },
  // ---- Architecture boundary: sim/ is the headless simulation layer — zero Phaser imports
  // (tech-stack §1 / §6 risk #10). This is the project's most load-bearing test seam.
  // NOTE: rules don't merge across configs, so this block must repeat the idb-keyval ban.
  {
    files: ['packages/game/src/sim/**/*.ts'],
    rules: {
      // Determinism second lock (PRD 01 US33 / GDD §2.2): sim/** has no wall clock and
      // no engine randomness — only the serialized sfc32 rng. CI greps the same surface.
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'sim/** is deterministic — no wall clock (GDD §2.2, PRD 01 US33).',
        },
        {
          name: 'performance',
          message: 'sim/** is deterministic — no wall clock (GDD §2.2, PRD 01 US33).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'sim/** is deterministic — no wall clock (GDD §2.2, PRD 01 US33).',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message:
            'sim/** is deterministic — use the serialized sfc32 rng, never Math.random (GDD §2.2, PRD 01 US33).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message:
                'sim/** must stay Phaser-free so it can run headless in Node (tech-stack §1, risk #10).',
            },
            {
              name: 'idb-keyval',
              message:
                'idb-keyval may only be imported inside packages/game/src/storage/** (game-design §10.1).',
            },
          ],
          patterns: [
            {
              group: ['phaser/*'],
              message:
                'sim/** must stay Phaser-free so it can run headless in Node (tech-stack §1, risk #10).',
            },
          ],
        },
      ],
    },
  },
);
