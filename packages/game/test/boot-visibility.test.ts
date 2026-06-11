import { describe, expect, it } from 'vitest';

import {
  bindVisibilityPause,
  type VisibilityDocumentLike,
  type VisibilityPauseSource,
  type VisibilityWindowLike,
} from '../src/boot/visibility';

class FakeDoc implements VisibilityDocumentLike {
  visibilityState = 'visible';
  focused = true;
  private listeners: (() => void)[] = [];
  hasFocus(): boolean {
    return this.focused;
  }
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  fire(): void {
    this.listeners.forEach((l) => l());
  }
  get listenerCount(): number {
    return this.listeners.length;
  }
}

class FakeWin implements VisibilityWindowLike {
  private listeners = new Map<string, (() => void)[]>();
  addEventListener(type: 'blur' | 'focus', listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: 'blur' | 'focus', listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
  fire(type: 'blur' | 'focus'): void {
    (this.listeners.get(type) ?? []).forEach((l) => l());
  }
}

function harness(pauseOnBlur?: () => boolean) {
  const doc = new FakeDoc();
  const win = new FakeWin();
  const sources = new Set<VisibilityPauseSource>();
  const autosaves: ('immediate' | 'debounced')[] = [];
  const unbind = bindVisibilityPause(
    {
      addPauseSource: (s) => sources.add(s),
      removePauseSource: (s) => sources.delete(s),
      requestAutosave: (mode) => autosaves.push(mode),
      pauseOnBlur,
    },
    { doc, win },
  );
  return { doc, win, sources, autosaves, unbind };
}

describe('bindVisibilityPause (GDD §2.4 / §10.4 trigger B)', () => {
  it('hidden tab → tab_hidden source + immediate autosave; visible → released', () => {
    const h = harness();
    expect(h.sources.size).toBe(0);

    h.doc.visibilityState = 'hidden';
    h.doc.focused = false;
    h.doc.fire();
    expect(h.sources.has('tab_hidden')).toBe(true);
    expect(h.autosaves).toEqual(['immediate']);

    h.doc.visibilityState = 'visible';
    h.doc.focused = true;
    h.doc.fire();
    expect(h.sources.has('tab_hidden')).toBe(false);
    expect(h.autosaves).toEqual(['immediate']); // no save on the way back
  });

  it('blur → window_blur source + debounced autosave; focus → released', () => {
    const h = harness();
    h.doc.focused = false;
    h.win.fire('blur');
    expect(h.sources.has('window_blur')).toBe(true);
    expect(h.autosaves).toEqual(['debounced']);

    h.doc.focused = true;
    h.win.fire('focus');
    expect(h.sources.has('window_blur')).toBe(false);
  });

  it('pauseOnBlur=false: blur never pauses but data safety still saves', () => {
    const h = harness(() => false);
    h.doc.focused = false;
    h.win.fire('blur');
    expect(h.sources.has('window_blur')).toBe(false);
    expect(h.autosaves).toEqual(['debounced']);
  });

  it('release re-queries the live state — a stale visible event keeps the pause (§2.9)', () => {
    const h = harness();
    h.doc.visibilityState = 'hidden';
    h.doc.fire();
    expect(h.sources.has('tab_hidden')).toBe(true);

    // The event fires, but the query still says hidden → source must stay.
    h.doc.fire();
    expect(h.sources.has('tab_hidden')).toBe(true);
  });

  it('binding in a hidden tab starts paused; unbind removes listeners', () => {
    const doc = new FakeDoc();
    doc.visibilityState = 'hidden';
    doc.focused = false;
    const win = new FakeWin();
    const sources = new Set<VisibilityPauseSource>();
    const unbind = bindVisibilityPause(
      {
        addPauseSource: (s) => sources.add(s),
        removePauseSource: (s) => sources.delete(s),
        requestAutosave: () => undefined,
      },
      { doc, win },
    );
    expect(sources.has('tab_hidden')).toBe(true);
    unbind();
    expect(doc.listenerCount).toBe(0);
  });
});
