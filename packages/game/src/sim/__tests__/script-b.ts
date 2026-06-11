/**
 * Tool-purchase script B (GDD §4.6) — executable acceptance harness.
 *
 * Script B = script R + one rule: AFTER each settlement (= at wake-up, before the
 * morning routine), buy the next tool while
 *
 *   cash ≥ tool price + 10g × (empty tilled tiles)
 *
 * i.e. tools outrank seeds but never starve the replant (the 10g/tile radish reserve).
 * Purchase order is fixed: copper can → copper hoe → gold can → gold hoe
 * (350 / 350 / 2,650 / 2,650g — the M1 one-time 6,000g sink, GDD §4.7).
 *
 * Tools change throughput only, never economy values (§4.6), so in the headless sim a
 * tool purchase is a pure capital drain — income is allowed to trail script R by ≤15%.
 * Level locks (copper @Lv2, gold @Lv4 + copper prerequisite, §4.3) are left to the shop:
 * a blocked dispatch is a no-op here and the purchase retries on a later morning.
 */
import type { SimApi } from '../sim.js';
import { getCropDef } from '../data/crops.js';
import { SHOP_CATALOG_M1 } from '../data/constants.js';
import { effLevelOf, farmTileEntries } from './fixtures.js';
import { runScriptR, type ScriptRDayRecord } from './script-r.js';

/** §4.6 fixed purchase order: 铜壶 → 铜锄 → 金壶 → 金锄. */
export const TOOL_ORDER = [
  'tool_can_copper',
  'tool_hoe_copper',
  'tool_can_gold',
  'tool_hoe_gold',
] as const;
export type ToolEntryId = (typeof TOOL_ORDER)[number];

export interface ScriptBDayRecord extends ScriptRDayRecord {
  /** Post-settlement wallet at wake-up, BEFORE any tool purchase (§4.6 "结算后现金"). */
  wakeGold: number;
  /** Empty tilled tiles at wake-up — the 10g/tile reserve basis of the cash check. */
  emptyTilesAtWake: number;
  /** Effective level at wake-up (shop locks are evaluated against this, §4.3). */
  levelAtWake: number;
  /** Tools bought at this morning's wake (post-settlement of the previous night). */
  toolsBoughtAtWake: ToolEntryId[];
}

export interface ScriptBRun {
  records: ScriptBDayRecord[];
  /** entryId → game day the purchase happened on (the wake-up that passed the cash check). */
  purchaseDay: Partial<Record<ToolEntryId, number>>;
}

/** Ownership is encoded in ToolTiers (GDD §4.3): copper = tier 2, gold = tier 3. */
function toolTierOwned(sim: SimApi, entryId: ToolEntryId): boolean {
  const { hoe, wateringCan } = sim.state.tools;
  switch (entryId) {
    case 'tool_can_copper':
      return wateringCan >= 2;
    case 'tool_hoe_copper':
      return hoe >= 2;
    case 'tool_can_gold':
      return wateringCan >= 3;
    case 'tool_hoe_gold':
      return hoe >= 3;
  }
}

export function toolPrice(entryId: ToolEntryId): number {
  return toolCatalogEntry(entryId).price;
}

/** §4.3 shop level lock (copper @Lv2, gold @Lv4) as declared by the catalog. */
export function toolUnlockLevel(entryId: ToolEntryId): number {
  return toolCatalogEntry(entryId).unlockLevel;
}

function toolCatalogEntry(entryId: ToolEntryId) {
  const entry = SHOP_CATALOG_M1.find((e) => e.entryId === entryId);
  if (!entry) throw new Error(`shop entry missing from catalog: ${entryId}`);
  return entry;
}

function emptyTilledTiles(sim: SimApi): number {
  return farmTileEntries(sim.state).filter(({ tile }) => tile.crop === null).length;
}

/** The §4.6 script B purchase step, run once per wake-up. */
function buyToolsAtWake(sim: SimApi): ToolEntryId[] {
  const bought: ToolEntryId[] = [];
  for (;;) {
    const next = TOOL_ORDER.find((id) => !toolTierOwned(sim, id));
    if (!next) return bought; // all four owned — the 6,000g sink is spent
    const reserve = emptyTilledTiles(sim) * getCropDef('radish_quick').seedPrice; // 10g/格
    if (sim.state.economy.gold < toolPrice(next) + reserve) return bought;
    sim.dispatch({ type: 'buyShopEntry', entryId: next, requested: 1 });
    if (!toolTierOwned(sim, next)) return bought; // level/prerequisite lock — retry later
    bought.push(next);
  }
}

/** Run script B for `days` mornings (reuses the script R daily loop verbatim). */
export function runScriptB(sim: SimApi, days: number): ScriptBRun {
  const records: ScriptBDayRecord[] = [];
  const purchaseDay: Partial<Record<ToolEntryId, number>> = {};
  let cumulativeGross = 0;
  for (let i = 0; i < days; i++) {
    // Post-settlement of the previous night ≡ this wake-up (D1 wake: 100g, trivially no-op).
    const wakeGold = sim.state.economy.gold;
    const emptyTilesAtWake = emptyTilledTiles(sim);
    const levelAtWake = effLevelOf(sim.state.progress.xp);
    const toolsBoughtAtWake = buyToolsAtWake(sim);
    for (const id of toolsBoughtAtWake) purchaseDay[id] = sim.state.time.day;

    const rec = runScriptR(sim, 1)[0]; // the unmodified script R morning + settlement
    if (!rec) throw new Error('runScriptR(sim, 1) returned no record');
    cumulativeGross += rec.summary.goldEarned;
    records.push({
      ...rec,
      cumulativeGross,
      wakeGold,
      emptyTilesAtWake,
      levelAtWake,
      toolsBoughtAtWake,
    });
  }
  return { records, purchaseDay };
}
