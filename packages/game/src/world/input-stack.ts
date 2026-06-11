/**
 * input-stack.ts — direction input stack (GDD §1.6, pure / Phaser-free).
 *
 * Press pushes, release pops, the stack TOP is the current movement direction;
 * four directions only, no diagonals. Same-frame multi-key presses are pushed in the
 * fixed order `up > down > left > right` (deterministic, replay-test friendly): the
 * LAST pushed key wins, so among keys pressed on the same frame `right` ends on top.
 * When idle the player keeps the last facing (owned by the player controller).
 */

export type Dir = 'up' | 'down' | 'left' | 'right';

/** Fixed same-frame push order (GDD §1.6 input stack). */
export const DIR_PUSH_ORDER: readonly Dir[] = ['up', 'down', 'left', 'right'];

export class InputStack {
  private stack: Dir[] = [];

  /** Push one direction on top (re-pressing an already-held direction re-tops it). */
  press(dir: Dir): void {
    this.releaseInternal(dir);
    this.stack.push(dir);
  }

  /**
   * Push several directions registered on the SAME frame in the fixed
   * `up > down > left > right` order regardless of hardware event order.
   */
  pressSameFrame(dirs: Iterable<Dir>): void {
    const set = new Set(dirs);
    for (const dir of DIR_PUSH_ORDER) {
      if (set.has(dir)) this.press(dir);
    }
  }

  release(dir: Dir): void {
    this.releaseInternal(dir);
  }

  /** Current movement direction (stack top) or null when no key is held. */
  get current(): Dir | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  get isEmpty(): boolean {
    return this.stack.length === 0;
  }

  clear(): void {
    this.stack = [];
  }

  private releaseInternal(dir: Dir): void {
    const i = this.stack.indexOf(dir);
    if (i !== -1) this.stack.splice(i, 1);
  }
}
