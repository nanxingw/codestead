/**
 * day-summary-panel.ts — the end-of-day settlement screen (GDD §2.5/§5.8/§6.7).
 *
 * The ONLY auto-opened modal in the game: pushed when the sim emits DayEnded. Stays up
 * indefinitely ("放下点" — no timer), closes on any key/click after a 400ms input grace
 * window. Shows harvest, settlement income, gold balance (=== the autosaved balance),
 * XP + level-ups, the ETA line (never a countdown) and ≤3 "明日之诺" entries (never
 * empty — falls back to the shop teaser).
 */
import type Phaser from 'phaser';

import { getCropDef } from '../../sim/data/crops';
import { XP_THRESHOLDS } from '../../sim/data/constants';
import { levelForXp } from '../../sim/leveling';
import type { DaySummary, TomorrowItem } from '../../sim/types';
import { formatGold } from '../format';
import { DEPTH, SUMMARY_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { safe } from '../safe';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

export const SUMMARY_INPUT_GRACE_MS = 400; // GDD §6.5

export class DaySummaryPanel implements Panel {
  readonly id: UiPanelId = 'daySummary';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private openedAt: number;

  constructor(
    private host: UiHost,
    private summary: DaySummary,
  ) {
    const scene = host.scene;
    this.openedAt = scene.time.now;
    const p = SUMMARY_PANEL;
    this.track(addScrim(scene, 0.7).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));

    const cx = p.x + p.width / 2;
    let y = p.y + 8;
    const title = t('summary.title', {
      day: summary.dayOfSeason,
      season: t(`season.${summary.season}`),
    });
    this.track(
      uiText(scene, cx, y, title, { color: PALETTE.gold.light, size: 24, align: 'center' })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    y += 32;

    // ---- harvest ----
    const harvestLine =
      summary.harvested.length === 0
        ? t('summary.nothing_harvested')
        : summary.harvested.map((h) => `${t(`crop.${h.cropId}`)} ×${h.count}`).join('  ');
    y = this.section(y, t('summary.harvested'), [harvestLine]);

    // ---- shipping settlement ----
    const shippedLines =
      summary.shipped.length === 0
        ? [t('summary.nothing_sold')]
        : summary.shipped.map(
            (s) => `${t(`crop.${s.cropId}`)} ×${s.count} → ${formatGold(s.gold)}g`,
          );
    if (summary.goldEarned > 0) {
      shippedLines.push(t('summary.gold_earned', { gold: formatGold(summary.goldEarned) }));
    }
    shippedLines.push(t('summary.gold_balance', { gold: formatGold(summary.goldBalance) }));
    y = this.section(y, t('summary.shipped'), shippedLines);

    // ---- progress ----
    const progressLines = [t('summary.xp', { xp: summary.xpGained })];
    for (const level of summary.levelUps) {
      progressLines.push(t('summary.level_up', { level }));
    }
    progressLines.push(this.etaLine());
    y = this.section(y, 'XP', progressLines);

    // ---- tomorrow (never empty — sim guarantees the fallback; double-guard here) ----
    const tomorrow =
      summary.tomorrow.length > 0
        ? summary.tomorrow.map((item) => this.tomorrowLine(item))
        : [t('summary.tomorrow_fallback')];
    tomorrow.push(
      summary.weatherNext === 'rain'
        ? t('summary.weather_next_rain')
        : t('summary.weather_next_sunny'),
    );
    this.section(y, t('summary.tomorrow'), tomorrow);

    this.track(
      uiText(scene, cx, p.y + p.height - 20, t('summary.continue'), {
        color: PALETTE.ui.textDim,
        align: 'center',
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );

    const zone = scene.add
      .zone(0, 0, scene.scale.width, scene.scale.height)
      .setOrigin(0, 0)
      .setInteractive()
      .setDepth(DEPTH.panel);
    zone.on('pointerdown', () => this.tryClose());
    this.track(zone);
  }

  refresh(): void {
    // Snapshot panel — content frozen at open.
  }

  /** ANY key closes after the grace window (GDD §6.8 day-summary column). */
  handleKey(_event: KeyboardEvent): boolean {
    this.tryClose();
    return true;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  private tryClose(): void {
    if (this.host.scene.time.now - this.openedAt < SUMMARY_INPUT_GRACE_MS) return;
    this.host.closeTop();
  }

  /** ETA per GDD §5.8: remaining ÷ mean(xpHistory ≤3 days), ceil; mean 0 → keep-going. */
  private etaLine(): string {
    const xp = this.host.state().progress.xp;
    const level = safe('levelForXp', () => levelForXp(xp), 1);
    if (level >= XP_THRESHOLDS.length) return '';
    const nextThreshold = XP_THRESHOLDS[level];
    const remaining = nextThreshold - xp;
    const history = this.host.state().progress.xpHistory;
    const mean = history.length > 0 ? history.reduce((a, b) => a + b, 0) / history.length : 0;
    if (mean <= 0) return t('summary.eta_keep_going');
    return t('summary.eta', {
      level: level + 1,
      xp: remaining,
      days: Math.ceil(remaining / mean),
    });
  }

  private tomorrowLine(item: TomorrowItem): string {
    switch (item.kind) {
      case 'rain':
        return t('summary.tomorrow_rain');
      case 'cropReady': {
        const name = safe(
          `cropDef:${item.cropId}`,
          () => t(getCropDef(item.cropId).nameKey),
          item.cropId,
        );
        return item.inDays === 1
          ? t('summary.tomorrow_crop_ready', { crop: name })
          : t('summary.tomorrow_crop_in', { crop: name, days: item.inDays });
      }
      default:
        return t('summary.tomorrow_fallback'); // construction/seasonEnd are M3
    }
  }

  private section(y: number, heading: string, lines: string[]): number {
    const p = SUMMARY_PANEL;
    this.track(
      uiText(this.host.scene, p.x + 16, y, heading, { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );
    const body = this.track(
      uiText(this.host.scene, p.x + 32, y + 14, lines.filter((l) => l !== '').join('\n'), {
        color: PALETTE.ui.text,
        wrapWidth: p.width - 48,
      }).setDepth(DEPTH.panel + 1),
    );
    return y + 14 + body.height + 6;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
