/**
 * shop-panel.ts — the unmanned grocery stand (GDD §4.3, §6.7).
 *
 * Buy tab: rows from economy.catalog() — available / locked silhouette ("Lv N 解锁") /
 * owned ("已购"); entries further than the catalog exposes fold into one count line;
 * NEW badge on the first game day after unlock; unaffordable rows stay visible, grayed,
 * with the gold gap. Left click ×1, right click ×5, 150ms debounce; granted quantity is
 * clamped by the sim (min(requested, affordable, fits)) and a blocked purchase toasts
 * exactly one reason.
 *
 * Sell tab: crops/materials consign to the shippingBin ("今晚结算 ✓", same container as
 * the bin, ruling A-1); seeds refund instantly at 100% (ruling A-11); tools are dimmed
 * and unsellable. Shift+left sells the whole stack.
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { INVENTORY_EXPANSION_PRICE, MATERIAL_SHOP_BUY_PRICE } from '../../sim/data/buildings';
import { SHOP_CATALOG_M1, type ShopEntryDef } from '../../sim/data/constants';
import { getItemDef, seedItemId } from '../../sim/data/items';
import { catalog, type ShopEntryView } from '../../sim/economy';
import { maxAddable } from '../../sim/inventory';
import { effectiveLevel } from '../../sim/leveling';
import type { WorldState } from '../../sim/types';
import { formatGold } from '../format';
import { DEPTH, SHOP_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { qualityOf, stackUnitSalePrice, withQualityMark } from '../quality-view';
import { safe } from '../safe';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

const ROW_HEIGHT = 20;
const CLICK_DEBOUNCE_MS = 150; // GDD §4.3 purchase state machine

interface RowView {
  zone: Phaser.GameObjects.Zone;
  texts: Phaser.GameObjects.Text[];
}

export class ShopPanel implements Panel {
  readonly id: UiPanelId = 'shop';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];
  private tab: 'buy' | 'sell' = 'buy';
  private cursor = 0;
  private lastClickAt = -Infinity;
  private buyTabLabel!: Phaser.GameObjects.Text;
  private sellTabLabel!: Phaser.GameObjects.Text;
  private goldText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = SHOP_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + 8, p.y + 4, t('shop.title'), { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );
    this.goldText = this.track(
      uiText(scene, p.x + p.width - 8, p.y + 4, '', { color: PALETTE.gold.light })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );

    this.buyTabLabel = this.track(
      uiText(scene, p.x + 8, p.y + 20, t('shop.tab_buy')).setDepth(DEPTH.panel + 1),
    );
    this.sellTabLabel = this.track(
      uiText(scene, p.x + 64, p.y + 20, t('shop.tab_sell')).setDepth(DEPTH.panel + 1),
    );
    for (const [label, tab] of [
      [this.buyTabLabel, 'buy'],
      [this.sellTabLabel, 'sell'],
    ] as const) {
      label.setInteractive({ useHandCursor: true });
      label.on('pointerdown', () => {
        this.tab = tab;
        this.cursor = 0;
        this.refresh();
      });
    }

    this.hintText = this.track(
      uiText(scene, p.x + 8, p.y + p.height - 18, '', { color: PALETTE.ui.textDim }).setDepth(
        DEPTH.panel + 1,
      ),
    );
    this.refresh();
  }

  refresh(): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];
    const state = this.host.state();
    this.goldText.setText(`${formatGold(state.economy.gold)}g`);
    this.buyTabLabel.setColor(this.tab === 'buy' ? PALETTE.gold.light : PALETTE.ui.textDim);
    this.sellTabLabel.setColor(this.tab === 'sell' ? PALETTE.gold.light : PALETTE.ui.textDim);
    if (this.tab === 'buy') {
      this.renderBuyTab(state);
      this.hintText.setText(t('shop.buy_keys'));
    } else {
      this.renderSellTab(state);
      this.hintText.setText(t('shop.sell_keys'));
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowUp':
        this.cursor = Math.max(0, this.cursor - 1);
        this.refresh();
        return true;
      case 'ArrowDown':
        this.cursor += 1;
        this.refresh();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
        this.tab = this.tab === 'buy' ? 'sell' : 'buy';
        this.cursor = 0;
        this.refresh();
        return true;
      case 'e':
      case 'E':
      case 'Enter':
        this.activateCursor(1, false);
        return true;
      case 'Escape':
        this.host.closeTop();
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    for (const obj of this.rowObjects) obj.destroy();
    for (const obj of this.objects) obj.destroy();
    this.rowObjects = [];
    this.objects = [];
  }

  // ---- buy tab ----

  private catalogView(state: Readonly<WorldState>): ShopEntryView[] {
    return safe('shop.catalog', () => catalog(state as WorldState), this.fallbackCatalog(state));
  }

  private renderBuyTab(state: Readonly<WorldState>): void {
    const p = SHOP_PANEL;
    const entries = this.catalogView(state).filter((e) => e.availability !== 'hidden');
    const hiddenCount = this.catalogView(state).length - entries.length;
    this.cursor = Math.min(this.cursor, Math.max(0, entries.length - 1));

    entries.forEach((view, i) => {
      const y = p.y + 40 + i * ROW_HEIGHT;
      const row = this.addRow(p.x + 8, y, p.width - 16);
      const { entry, availability, isNew } = view;
      const locked = availability === 'locked';
      const owned = availability === 'owned';
      const affordable = state.economy.gold >= entry.price;
      const nameColor = locked
        ? PALETTE.ui.textDim
        : owned
          ? PALETTE.green.light
          : affordable
            ? PALETTE.ui.text
            : PALETTE.ui.textDim;
      const name = locked
        ? `▒▒ ${t('shop.locked_lv', { level: entry.unlockLevel })}`
        : t(entry.nameKey);
      row.texts.push(
        uiText(this.host.scene, p.x + 12, y + 3, name, { color: nameColor }).setDepth(
          DEPTH.panel + 1,
        ),
      );
      if (isNew && !locked) {
        row.texts.push(
          uiText(this.host.scene, p.x + 12 + row.texts[0].width + 6, y + 3, t('shop.new_badge'), {
            color: PALETTE.berry,
          }).setDepth(DEPTH.panel + 1),
        );
      }
      const priceLabel = owned
        ? t('shop.owned')
        : locked
          ? ''
          : affordable
            ? `${formatGold(entry.price)}g`
            : `${formatGold(entry.price)}g · ${t('shop.gold_gap', { gap: formatGold(entry.price - state.economy.gold) })}`;
      row.texts.push(
        uiText(this.host.scene, p.x + p.width - 12, y + 3, priceLabel, {
          color: owned ? PALETTE.green.light : affordable ? PALETTE.gold.light : PALETTE.ui.textDim,
        })
          .setOrigin(1, 0)
          .setDepth(DEPTH.panel + 1),
      );
      if (i === this.cursor) row.texts[0].setColor(PALETTE.gold.light);
      if (!locked && !owned) {
        row.zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
          this.cursor = i;
          this.tryBuy(view, pointer.rightButtonDown() ? 5 : 1);
        });
      } else if (locked) {
        row.zone.removeInteractive(); // silhouettes are not clickable (GDD §4.3)
      } else {
        row.zone.on('pointerdown', () => this.host.toast('toast.already_owned'));
      }
      for (const text of row.texts) this.rowObjects.push(text);
    });

    let nextRow = entries.length;
    if (hiddenCount > 0) {
      const y = p.y + 40 + nextRow * ROW_HEIGHT;
      this.rowObjects.push(
        uiText(this.host.scene, p.x + 12, y + 3, t('shop.folded', { n: hiddenCount }), {
          color: PALETTE.ui.textDim,
        }).setDepth(DEPTH.panel + 1),
      );
      nextRow += 1;
    }
    this.renderSupplyRows(state, nextRow);
  }

  /**
   * M3 supplies section (PRD 04 §E/§H): the wood/stone buy-in floor (5g each, anti-soft-
   * lock §8.1/§4.4) and the 1,000g backpack expansion (12 → 24, level-independent §6.2/§6.9).
   * These are NOT SHOP_CATALOG_M1 rows (that table is the frozen §4.3 M1 contract) — they
   * route to the dedicated buyMaterial / expandInventory SimCommands. Mouse-driven like the
   * catalog rows; the sim clamps and reports the single blocked reason.
   */
  private renderSupplyRows(state: Readonly<WorldState>, startRow: number): void {
    const p = SHOP_PANEL;
    const headerY = p.y + 40 + startRow * ROW_HEIGHT;
    this.rowObjects.push(
      uiText(this.host.scene, p.x + 12, headerY + 3, t('shop.supplies_header'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );

    const supplyRows: {
      labelKey: string;
      price: number;
      affordable: boolean;
      onBuy: () => void;
    }[] = [
      {
        labelKey: 'shop.buy_wood',
        price: MATERIAL_SHOP_BUY_PRICE.wood,
        affordable: state.economy.gold >= MATERIAL_SHOP_BUY_PRICE.wood,
        onBuy: () => this.tryBuyMaterial('wood'),
      },
      {
        labelKey: 'shop.buy_stone',
        price: MATERIAL_SHOP_BUY_PRICE.stone,
        affordable: state.economy.gold >= MATERIAL_SHOP_BUY_PRICE.stone,
        onBuy: () => this.tryBuyMaterial('stone'),
      },
    ];
    // The expansion is one-time: shown as "已扩容" once capacity flips to 24, else a buy row.
    const expanded = state.inventory.capacity >= 24;
    supplyRows.push({
      labelKey: 'shop.expand_backpack',
      price: INVENTORY_EXPANSION_PRICE,
      affordable: expanded || state.economy.gold >= INVENTORY_EXPANSION_PRICE,
      onBuy: () => this.tryExpandBackpack(),
    });

    supplyRows.forEach((sr, i) => {
      const y = headerY + (i + 1) * ROW_HEIGHT;
      const row = this.addRow(p.x + 8, y, p.width - 16);
      const owned = sr.labelKey === 'shop.expand_backpack' && expanded;
      const nameColor = owned
        ? PALETTE.green.light
        : sr.affordable
          ? PALETTE.ui.text
          : PALETTE.ui.textDim;
      row.texts.push(
        uiText(this.host.scene, p.x + 12, y + 3, t(sr.labelKey), { color: nameColor }).setDepth(
          DEPTH.panel + 1,
        ),
      );
      const priceLabel = owned
        ? t('shop.backpack_done')
        : sr.affordable
          ? `${formatGold(sr.price)}g`
          : `${formatGold(sr.price)}g · ${t('shop.gold_gap', { gap: formatGold(sr.price - state.economy.gold) })}`;
      row.texts.push(
        uiText(this.host.scene, p.x + p.width - 12, y + 3, priceLabel, {
          color: owned
            ? PALETTE.green.light
            : sr.affordable
              ? PALETTE.gold.light
              : PALETTE.ui.textDim,
        })
          .setOrigin(1, 0)
          .setDepth(DEPTH.panel + 1),
      );
      if (owned) {
        row.zone.on('pointerdown', () => this.host.toast('toast.already_owned'));
      } else {
        row.zone.on('pointerdown', () => sr.onBuy());
      }
      for (const text of row.texts) this.rowObjects.push(text);
    });
  }

  private tryBuyMaterial(material: 'wood' | 'stone'): void {
    const now = this.host.scene.time.now;
    if (now - this.lastClickAt < CLICK_DEBOUNCE_MS) return;
    this.lastClickAt = now;
    const state = this.host.state();
    const itemId = material === 'wood' ? 'material_wood' : 'material_stone';
    if (state.economy.gold < MATERIAL_SHOP_BUY_PRICE[material]) {
      this.host.toast('toast.not_enough_gold');
      this.host.playSfx(SFX.uiError);
      return;
    }
    if (maxAddable(state.inventory, itemId) === 0) {
      this.host.toast('toast.inventory_full');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch({ type: 'buyMaterial', material, requested: 1 });
    this.refresh();
  }

  private tryExpandBackpack(): void {
    const now = this.host.scene.time.now;
    if (now - this.lastClickAt < CLICK_DEBOUNCE_MS) return;
    this.lastClickAt = now;
    const state = this.host.state();
    if (state.inventory.capacity >= 24) {
      this.host.toast('toast.already_owned');
      return;
    }
    if (state.economy.gold < INVENTORY_EXPANSION_PRICE) {
      this.host.toast('toast.not_enough_gold');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch({ type: 'expandInventory' });
    this.refresh();
  }

  private tryBuy(view: ShopEntryView, requested: number): void {
    const now = this.host.scene.time.now;
    if (now - this.lastClickAt < CLICK_DEBOUNCE_MS) return;
    this.lastClickAt = now;
    const state = this.host.state();
    const { entry } = view;
    // Pre-validate for the single blocked-reason toast (sim stays the authority).
    if (entry.requires) {
      const ownedRequired = this.fallbackOwned(state, entry.requires);
      if (!ownedRequired) {
        this.host.toast('toast.requires_copper');
        this.host.playSfx(SFX.uiError);
        return;
      }
    }
    if (state.economy.gold < entry.price) {
      this.host.toast('toast.not_enough_gold');
      this.host.playSfx(SFX.uiError);
      return;
    }
    // Full backpack on a seed entry: same maxAddable source as economy.buy's
    // INVENTORY_FULL verdict, single-reason toast (GDD §4.3 / US58). Tool upgrades
    // never enter the backpack, so they skip this check.
    if (
      entry.kind === 'seed' &&
      entry.cropId !== undefined &&
      maxAddable(state.inventory, seedItemId(entry.cropId)) === 0
    ) {
      this.host.toast('toast.inventory_full');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch({ type: 'buyShopEntry', entryId: entry.entryId, requested });
    this.refresh();
  }

  // ---- sell tab ----

  private renderSellTab(state: Readonly<WorldState>): void {
    const p = SHOP_PANEL;
    this.rowObjects.push(
      uiText(
        this.host.scene,
        p.x + 8,
        p.y + 36,
        `${t('shop.consign_hint')} · ${t('shop.refund_hint')}`,
        {
          color: PALETTE.ui.textDim,
          wrapWidth: p.width - 16,
        },
      ).setDepth(DEPTH.panel + 1),
    );
    const rows = state.inventory.slots
      .map((stack, slot) => ({ stack, slot }))
      .filter((r): r is { stack: NonNullable<typeof r.stack>; slot: number } => r.stack !== null);
    if (rows.length === 0) {
      this.rowObjects.push(
        uiText(this.host.scene, p.x + 12, p.y + 72, t('shop.empty_sell'), {
          color: PALETTE.ui.textDim,
        }).setDepth(DEPTH.panel + 1),
      );
      return;
    }
    this.cursor = Math.min(this.cursor, rows.length - 1);
    rows.forEach(({ stack, slot }, i) => {
      const def = getItemDef(stack.itemId);
      // M3: artisan goods consign like crops (GDD §6.1 寄售 row; PRD 04 US75).
      const sellable =
        def.category === 'crop' || def.category === 'material' || def.category === 'artisan_good';
      const refundable = def.category === 'seed';
      const y = p.y + 60 + i * ROW_HEIGHT;
      const row = this.addRow(p.x + 8, y, p.width - 16);
      const dim = !sellable && !refundable;
      // Quality is double-encoded in text rows too (◆银 / ★金, §4.5; PRD 04 US45).
      const name = withQualityMark(t(def.nameKey), qualityOf(stack));
      row.texts.push(
        uiText(this.host.scene, p.x + 12, y + 3, `${name} ×${stack.count}`, {
          color: dim
            ? PALETTE.ui.textDim
            : i === this.cursor
              ? PALETTE.gold.light
              : PALETTE.ui.text,
        }).setDepth(DEPTH.panel + 1),
      );
      // Unit price through the §4.5 single entry — silver/gold and profession
      // multipliers show the real consignment value (金+园艺师芜菁 = 62, US44).
      const tag = refundable
        ? `${def.sellPrice ?? 0}g · 退货`
        : sellable
          ? `${stackUnitSalePrice(state, stack)}g · 今晚结算 ✓`
          : '—';
      row.texts.push(
        uiText(this.host.scene, p.x + p.width - 12, y + 3, tag, {
          color: dim ? PALETTE.ui.textDim : PALETTE.gold.light,
        })
          .setOrigin(1, 0)
          .setDepth(DEPTH.panel + 1),
      );
      if (dim) {
        row.zone.on('pointerdown', () => {
          this.host.toast('toast.not_sellable');
          this.host.playSfx(SFX.uiError);
        });
      } else {
        row.zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
          this.cursor = i;
          const count = pointer.event.shiftKey
            ? stack.count
            : pointer.rightButtonDown()
              ? Math.min(5, stack.count)
              : 1;
          this.sellFrom(slot, count, refundable);
        });
      }
      for (const text of row.texts) this.rowObjects.push(text);
    });
  }

  private sellFrom(slot: number, count: number, refundable: boolean): void {
    const now = this.host.scene.time.now;
    if (now - this.lastClickAt < CLICK_DEBOUNCE_MS) return;
    this.lastClickAt = now;
    if (refundable) {
      this.host.dispatch({ type: 'refundSeeds', slot, count }); // instant 100% (A-11)
    } else {
      this.host.dispatch({ type: 'depositToBin', slot, count }); // consignment (A-1)
    }
    this.refresh();
  }

  private activateCursor(count: number, _shift: boolean): void {
    const state = this.host.state();
    if (this.tab === 'buy') {
      const entries = this.catalogView(state).filter((e) => e.availability !== 'hidden');
      const view = entries[this.cursor];
      if (view && view.availability === 'available') this.tryBuy(view, count);
    } else {
      const rows = state.inventory.slots
        .map((stack, slot) => ({ stack, slot }))
        .filter((r) => r.stack !== null);
      const row = rows[this.cursor];
      if (!row?.stack) return;
      const def = getItemDef(row.stack.itemId);
      if (def.category === 'seed') this.sellFrom(row.slot, count, true);
      else if (
        def.category === 'crop' ||
        def.category === 'material' ||
        def.category === 'artisan_good' // M3 consignment (GDD §6.1)
      )
        this.sellFrom(row.slot, count, false);
      else {
        this.host.toast('toast.not_sellable');
        this.host.playSfx(SFX.uiError);
      }
    }
  }

  // ---- helpers ----

  private addRow(x: number, y: number, width: number): RowView {
    const zone = this.host.scene.add
      .zone(x, y, width, ROW_HEIGHT - 2)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(DEPTH.panel + 2);
    this.rowObjects.push(zone);
    return { zone, texts: [] };
  }

  /**
   * Resilience fallback while economy.catalog() is not merged yet: availability from
   * the authoritative M1 table + effectiveLevel + tool tiers (same §4.3 rules; the sim
   * implementation replaces this as the authority at integration time).
   */
  private fallbackCatalog(state: Readonly<WorldState>): ShopEntryView[] {
    const level = safe('effectiveLevel', () => effectiveLevel(state.progress.xp), 1);
    return SHOP_CATALOG_M1.map((entry) => {
      let availability: ShopEntryView['availability'];
      if (this.fallbackOwned(state, entry.entryId)) availability = 'owned';
      else if (entry.unlockLevel <= level) availability = 'available';
      else if (entry.unlockLevel - level <= 2) availability = 'locked';
      else availability = 'hidden';
      return { entry, availability, isNew: false };
    });
  }

  private fallbackOwned(state: Readonly<WorldState>, entryId: ShopEntryDef['entryId']): boolean {
    switch (entryId) {
      case 'tool_hoe_copper':
        return state.tools.hoe >= 2;
      case 'tool_hoe_gold':
        return state.tools.hoe >= 3;
      case 'tool_can_copper':
        return state.tools.wateringCan >= 2;
      case 'tool_can_gold':
        return state.tools.wateringCan >= 3;
      default:
        return false; // seeds are never one-time
    }
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
