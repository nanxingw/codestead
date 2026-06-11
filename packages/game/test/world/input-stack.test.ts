import { describe, expect, it } from 'vitest';

import { InputStack } from '../../src/world/input-stack';

describe('InputStack (GDD §1.6)', () => {
  it('last pressed key wins (stack top)', () => {
    const s = new InputStack();
    s.press('up');
    s.press('left');
    expect(s.current).toBe('left');
    s.release('left');
    expect(s.current).toBe('up');
    s.release('up');
    expect(s.current).toBeNull();
  });

  it('same-frame presses resolve in the fixed order up > down > left > right', () => {
    const s = new InputStack();
    // Hardware order scrambled on purpose — push order must be deterministic.
    s.pressSameFrame(['right', 'up']);
    expect(s.current).toBe('right'); // right pushed last per fixed order
    const t = new InputStack();
    t.pressSameFrame(['down', 'up']);
    expect(t.current).toBe('down');
  });

  it('opposite keys on the same frame resolve deterministically (GDD §1.10 #4)', () => {
    const a = new InputStack();
    a.pressSameFrame(['left', 'right']);
    const b = new InputStack();
    b.pressSameFrame(['right', 'left']);
    expect(a.current).toBe(b.current);
    expect(a.current).toBe('right');
  });

  it('re-pressing a held direction re-tops it', () => {
    const s = new InputStack();
    s.press('up');
    s.press('left');
    s.press('up');
    expect(s.current).toBe('up');
    s.release('up');
    expect(s.current).toBe('left');
  });
});
