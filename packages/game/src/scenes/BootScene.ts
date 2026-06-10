import Phaser from 'phaser';
import { PROTOCOL_VERSION } from '@codestead/shared';

import { GAME_HEIGHT, GAME_WIDTH } from '../scale';

/**
 * M0 boot scene: an empty 640x360 canvas proving the Phaser + Vite shell runs.
 * No gameplay, no HUD, no network — what you see is the honest current progress.
 * The Boot/Farm/UI three-scene split is an M1 concern (PRD 00, implementation decision 4).
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    const centerX = GAME_WIDTH / 2;
    const centerY = GAME_HEIGHT / 2;

    this.add
      .text(centerX, centerY - 12, 'Codestead', {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: '#f4e3c2',
      })
      .setOrigin(0.5);

    this.add
      .text(
        centerX,
        centerY + 16,
        `M0 scaffold · v${__APP_VERSION__} · protocol v${PROTOCOL_VERSION}`,
        {
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#9aa0a6',
        },
      )
      .setOrigin(0.5);
  }
}
