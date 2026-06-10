import { describe, expect, it } from 'vitest';

import { formatStartupBanner } from '../src/banner.js';

// Minimal pure-function smoke test: proves the daemon package's test wiring works.
describe('formatStartupBanner', () => {
  it('includes the daemon version and protocol version', () => {
    const banner = formatStartupBanner('0.1.0', 1);
    expect(banner).toContain('v0.1.0');
    expect(banner).toContain('protocol v1');
  });
});
