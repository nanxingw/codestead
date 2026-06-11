/**
 * top-right-panel.ts — the play HUD panel at (540,4) 96×30 + 4px XP bar (GDD §6.6):
 * date/clock (10-game-minute steps, amber from 21:30), weather, gold (300ms roll),
 * level badge; XP tooltip on hover; tilled-cap counter while the hoe is held (§5.8).
 *
 * The top-LEFT rect (4,4)–(156,150) belongs to the M2 session HUD — nothing here may
 * touch it (ruling A-9).
 */
import type Phaser from 'phaser';

import { TIME, XP_CAP, XP_THRESHOLDS } from '../../sim/data/constants';
import { effectiveLevel, levelForXp } from '../../sim/leveling';
import { tilledCapForLevel, tilledCount } from '../../sim/tiles';
import { timeView } from '../../sim/time';
import type { TimeView, WorldState } from '../../sim/types';
import { formatClock, formatGold } from '../format';
import { DEPTH, TOP_RIGHT_PANEL, XP_BAR } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { safe } from '../safe';
import { t } from '../strings';
import { addPanel } from '../widgets/panel';
import { uiText } from '../widgets/text';

const GOLD_ROLL_MS = 300;

export class TopRightPanel {
  private clockText: Phaser.GameObjects.Text;
  private goldText: Phaser.GameObjects.Text;
  private xpBar: Phaser.GameObjects.Graphics;
  private tilledText: Phaser.GameObjects.Text;
  private tooltip: Phaser.GameObjects.Text;

  private displayedGold = 0;
  private goldFrom = 0;
  private goldTarget = 0;
  private goldRollStart = -Infinity;
  private initialized = false;

  constructor(
    private scene: Phaser.Scene,
    private reducedMotion: () => boolean,
  ) {
    const p = TOP_RIGHT_PANEL;
    addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.hud);
    this.clockText = uiText(scene, p.x + 4, p.y + 2, '').setDepth(DEPTH.hud + 1);
    this.goldText = uiText(scene, p.x + 4, p.y + 15, '', {
      color: PALETTE.gold.light,
    }).setDepth(DEPTH.hud + 1);
    this.xpBar = scene.add.graphics().setDepth(DEPTH.hud + 1);
    this.tilledText = uiText(scene, p.x + 4, XP_BAR.y + 8, '', {
      color: PALETTE.ui.textDim,
    }).setDepth(DEPTH.hud + 1);
    this.tooltip = uiText(scene, p.x + p.width, p.y + p.height + 24, '', {
      color: PALETTE.ui.text,
    })
      .setOrigin(1, 0)
      .setDepth(DEPTH.tooltip)
      .setVisible(false);

    const zone = scene.add
      .zone(p.x, p.y, p.width, p.height + 8)
      .setOrigin(0, 0)
      .setInteractive();
    zone.on('pointerover', () => this.tooltip.setVisible(true));
    zone.on('pointerout', () => this.tooltip.setVisible(false));
  }

  update(state: Readonly<WorldState>, nowMs: number): void {
    const view = safe<TimeView | null>('timeView', () => timeView(state.time), null);
    const minute = state.time.minuteOfDay;
    const clock = view
      ? formatClock(view.hh, view.mm)
      : formatClock(Math.floor(minute / 60), (minute % 60) - (minute % TIME.CLOCK_DISPLAY_STEP));
    const season = view ? t(`season.${view.season}`) : t('season.spring');
    const dayOfSeason = view ? view.dayOfSeason : ((state.time.day - 1) % TIME.DAYS_PER_SEASON) + 1;
    const weatherGlyph = state.time.weatherToday === 'rain' ? '☔' : '☀';
    this.clockText.setText(`${season} ${dayOfSeason}日 ${clock} ${weatherGlyph}`);
    // 21:30 amber clock — the ONE soft end-of-day cue (GDD §2.1/§6.6).
    this.clockText.setColor(
      minute >= TIME.CLOCK_AMBER_FROM_MINUTE ? PALETTE.amber : PALETTE.ui.text,
    );

    this.updateGold(state.economy.gold, nowMs);

    const xp = state.progress.xp;
    const level = safe('levelForXp', () => levelForXp(xp), 1);
    const effLevel = safe('effectiveLevel', () => effectiveLevel(xp), level);
    this.goldText.setText(`${formatGold(this.displayedGold)}g  Lv${effLevel}`);
    this.drawXpBar(xp, level);

    // Tilled-cap counter while the hoe is selected (GDD §5.8).
    const selected = state.inventory.slots[state.inventory.selected];
    if (selected?.itemId === 'hoe') {
      const count = safe(
        'tilledCount',
        () => tilledCount(state as WorldState),
        null as number | null,
      );
      const cap = safe('tilledCap', () => tilledCapForLevel(effLevel), null as number | null);
      this.tilledText.setText(
        count !== null && cap !== null ? `${t('ui.tilled_counter')} ${count}/${cap}` : '',
      );
    } else {
      this.tilledText.setText('');
    }
  }

  private updateGold(gold: number, nowMs: number): void {
    if (!this.initialized) {
      this.initialized = true;
      this.displayedGold = this.goldFrom = this.goldTarget = gold;
      return;
    }
    if (gold !== this.goldTarget) {
      this.goldFrom = this.displayedGold;
      this.goldTarget = gold;
      this.goldRollStart = nowMs;
    }
    if (this.reducedMotion()) {
      this.displayedGold = this.goldTarget; // §10.8: numbers jump straight to final value
      return;
    }
    const p = Math.min(1, (nowMs - this.goldRollStart) / GOLD_ROLL_MS);
    this.displayedGold = Math.round(this.goldFrom + (this.goldTarget - this.goldFrom) * p);
  }

  private drawXpBar(xp: number, level: number): void {
    const lower = XP_THRESHOLDS[Math.min(level, XP_THRESHOLDS.length) - 1] ?? 0;
    const upper = level < XP_THRESHOLDS.length ? XP_THRESHOLDS[level] : XP_CAP;
    const span = Math.max(1, upper - lower);
    const fill = Math.max(0, Math.min(1, (xp - lower) / span));
    const b = XP_BAR;
    this.xpBar.clear();
    this.xpBar.fillStyle(hexToNum(PALETTE.ui.panelLight), 1);
    this.xpBar.fillRect(b.x, b.y, b.width, b.height);
    this.xpBar.fillStyle(hexToNum(PALETTE.gold.mid), 1); // XP bars are gold.mid (§11.3)
    this.xpBar.fillRect(b.x, b.y, Math.round(b.width * fill), b.height);
    this.xpBar.lineStyle(1, hexToNum(PALETTE.ink), 1);
    this.xpBar.strokeRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1);
    // Hover tooltip: `312 / 380 XP · 距 Lv3 还差 68` (GDD §5.8).
    if (level < XP_THRESHOLDS.length) {
      this.tooltip.setText(`${xp} / ${upper} XP · 距 Lv${level + 1} 还差 ${upper - xp}`);
    } else {
      this.tooltip.setText(`${xp} XP`);
    }
  }
}
