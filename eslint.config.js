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
  // ---- Architecture boundary: sim/ is the headless simulation layer — zero Phaser imports
  // (tech-stack §1 / §6 risk #10). This is the project's most load-bearing test seam.
  // NOTE: rules don't merge across configs, so this block must repeat the idb-keyval ban.
  {
    files: ['packages/game/src/sim/**/*.ts'],
    rules: {
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
