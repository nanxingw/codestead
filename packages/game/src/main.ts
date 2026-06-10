import Phaser from 'phaser';

import { BootScene } from './scenes/BootScene';
import { computeIntegerZoom, GAME_HEIGHT, GAME_WIDTH } from './scale';

/**
 * Pixel-art hard spec (game-design §0.3, constitutional):
 * - logical resolution 640x360 (16:9);
 * - integer zoom only (x2 / x3 ...), windows below 640x360 clamp to x1;
 * - pixelArt + roundPixels on, antialias off, no fractional positions.
 */
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#241e2c',
  pixelArt: true, // implies antialias: false + roundPixels: true; kept explicit below
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.NONE, // we control zoom ourselves to guarantee integer scaling
    zoom: computeIntegerZoom(window.innerWidth, window.innerHeight),
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene],
});

window.addEventListener('resize', () => {
  game.scale.setZoom(computeIntegerZoom(window.innerWidth, window.innerHeight));
});
