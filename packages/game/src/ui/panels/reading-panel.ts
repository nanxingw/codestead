/**
 * reading-panel.ts — shared paper-style reading view for the intro letter, the market
 * bulletin board (pure stage-hint sign, GDD §1.9) and the key-map help page (§6.8).
 * Query-only: never auto-opens; Esc/E/click closes.
 */
import type Phaser from 'phaser';

import type { WorldState } from '../../sim/types';
import { getItemDef } from '../../sim/data/items';
import { DEPTH, READING_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

export type ReadingKind = 'letter' | 'board' | 'keysHelp';

export class ReadingPanel implements Panel {
  readonly id: UiPanelId;
  private objects: Phaser.GameObjects.GameObject[] = [];

  constructor(
    private host: UiHost,
    kind: ReadingKind,
  ) {
    this.id = kind;
    const scene = host.scene;
    const p = READING_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));

    const { title, body } = contentFor(kind, host.state());
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, title, { color: PALETTE.gold.light })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + 16, p.y + 32, body, {
        color: PALETTE.sand,
        wrapWidth: p.width - 32,
      }).setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + p.height - 20, `[Esc] ${t('ui.close')}`, {
        color: PALETTE.ui.textDim,
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    const zone = scene.add
      .zone(0, 0, scene.scale.width, scene.scale.height)
      .setOrigin(0, 0)
      .setInteractive()
      .setDepth(DEPTH.panel);
    zone.on('pointerdown', () => host.closeTop());
    this.track(zone);
  }

  refresh(): void {
    // Static content per open.
  }

  handleKey(event: KeyboardEvent): boolean {
    if (['Escape', 'e', 'E', 'Enter'].includes(event.key)) {
      this.host.closeTop();
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}

function contentFor(
  kind: ReadingKind,
  state: Readonly<WorldState>,
): { title: string; body: string } {
  switch (kind) {
    case 'letter':
      return { title: t('letter.title'), body: t('letter.body') };
    case 'keysHelp':
      return { title: t('keys.title'), body: t('keys.body') };
    case 'board':
      return { title: t('board.title'), body: boardHint(state) };
  }
}

/** Stage hints (GDD §1.9): no seeds → buy; seeds unplanted → till & sow; planted → water. */
function boardHint(state: Readonly<WorldState>): string {
  const hasPlanted = Object.values(state.farm.tiles).some((tile) => tile.crop !== null);
  if (hasPlanted) return t('board.hint_water');
  const hasSeeds = state.inventory.slots.some(
    (stack) => stack !== null && getItemDef(stack.itemId).category === 'seed',
  );
  return hasSeeds ? t('board.hint_plant') : t('board.hint_buy_seeds');
}
