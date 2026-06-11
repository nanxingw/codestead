import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'game',
    environment: 'node',
    // sim contract tests live next to the sim layer (src/sim/__tests__) so they share
    // its zero-Phaser/zero-wall-clock lint envelope; everything else stays in test/.
    include: ['test/**/*.test.ts', 'src/sim/__tests__/**/*.test.ts'],
  },
});
