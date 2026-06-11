import { describe, expect, it } from 'vitest';

import { lightingAt } from '../../src/world/lighting';

describe('lightingAt (GDD §2.7)', () => {
  it('dawn starts at 25% warm tint and fades to 0 by 7:30', () => {
    expect(lightingAt(360, 'sunny').phase).toBe('dawn');
    expect(lightingAt(360, 'sunny').tintAlpha).toBeCloseTo(0.25);
    expect(lightingAt(450, 'sunny').tintAlpha).toBe(0);
  });

  it('daytime has no tint', () => {
    const mid = lightingAt(720, 'sunny'); // 12:00
    expect(mid.phase).toBe('day');
    expect(mid.tintAlpha).toBe(0);
  });

  it('golden hour ramps to 15% by 19:00', () => {
    expect(lightingAt(1020, 'sunny').phase).toBe('golden');
    expect(lightingAt(1130, 'sunny').tintAlpha).toBeLessThanOrEqual(0.15);
    expect(lightingAt(1139, 'sunny').phase).toBe('golden');
  });

  it('dusk ramps to 45% by 22:00', () => {
    expect(lightingAt(1140, 'sunny').phase).toBe('dusk');
    expect(lightingAt(1320, 'sunny').tintAlpha).toBeCloseTo(0.45);
  });

  it('steps every 10 game minutes (no continuous drift)', () => {
    expect(lightingAt(361, 'sunny').tintAlpha).toBe(lightingAt(369, 'sunny').tintAlpha);
    expect(lightingAt(360, 'sunny').tintAlpha).not.toBe(lightingAt(370, 'sunny').tintAlpha);
  });

  it('rain flag passes through for the overlay + particles', () => {
    expect(lightingAt(720, 'rain').rain).toBe(true);
    expect(lightingAt(720, 'sunny').rain).toBe(false);
  });
});
