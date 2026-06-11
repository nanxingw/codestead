/**
 * tool-range.ts — copper/gold tool range expansion (GDD §3.5, ruling A-16; pure /
 * Phaser-free).
 *
 * Ranges (§3.5): tier 1 = the target tile only; tier 2 copper = "直线 3 格" — the
 * facing tile + 2 more tiles in the same direction; tier 3 gold = "3×3" — the 9 tiles
 * centered on the facing tile. Expansion happens in this INPUT-TRANSLATION layer; the
 * sim keeps receiving per-tile commands and re-validates every tile itself (legal
 * subset only, §3.9 #3 — the tilled cap is re-checked per tile by canTill).
 *
 * Tile order is deterministic (PRD 02 US25/US34 replay determinism): the line runs
 * near → far from the origin; the 3×3 is row-major, top-left → bottom-right. Keyboard
 * and mouse both expand through this single function, so the resulting sim command
 * sequences are identical by construction.
 */
import type { ItemId } from '../sim/data/items';
import type { Facing, TilePos, ToolTiers } from '../sim/types';
import { FACING_DELTA } from './aim';

export type ToolTier = 1 | 2 | 3;

/** Tier of the SELECTED item: only the two upgradable tools have one (GDD §3.5). */
export function toolTierFor(itemId: ItemId | null, tools: ToolTiers): ToolTier {
  if (itemId === 'hoe') return tools.hoe;
  if (itemId === 'watering_can') return tools.wateringCan;
  return 1;
}

export interface RangeBounds {
  width: number;
  height: number;
}

/**
 * Expand a tool target into its tier range (deterministic order, see header).
 * Out-of-bounds tiles are dropped when `bounds` is given — they could never be legal
 * targets, and dropping them keeps previews and command sequences clean at map edges.
 */
export function expandToolRange(
  origin: TilePos,
  facing: Facing,
  tier: ToolTier,
  bounds?: RangeBounds,
): TilePos[] {
  let tiles: TilePos[];
  if (tier === 1) {
    tiles = [{ x: origin.x, y: origin.y }];
  } else if (tier === 2) {
    const d = FACING_DELTA[facing];
    tiles = [0, 1, 2].map((i) => ({ x: origin.x + d.x * i, y: origin.y + d.y * i }));
  } else {
    tiles = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        tiles.push({ x: origin.x + dx, y: origin.y + dy });
      }
    }
  }
  if (!bounds) return tiles;
  return tiles.filter((t) => t.x >= 0 && t.y >= 0 && t.x < bounds.width && t.y < bounds.height);
}
