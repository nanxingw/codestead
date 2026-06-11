/**
 * feedback-model.ts — pure helpers behind the in-place success feedback layer
 * (ui/hud/feedback-view.ts). Phaser-free so the merge / flight-path / clamp rules are
 * unit-testable headless (same discipline as ui/notifications.ts).
 *
 * Authority: GDD §6.4 (harvest timeline 0ms pop → 60ms flight → 300ms land), §5.8
 * (XP floaters; same-frame batch merges into ONE xp line — PRD 01 US68), §10.8
 * (reducedMotion: 收割抛物线 → 200ms 淡出), ruling A-9 (the (4,4)–(156,150)
 * session-HUD reserve stays pixel-free — spawn points are clamped out of it).
 */
import type { CropId } from '../../sim/data/crops';
import type { ItemId } from '../../sim/data/items';
import type { TilePos } from '../../sim/types';
import { HOTBAR, HUD_RESERVED, SLOT_GAP, SLOT_SIZE } from '../layout';

export interface Point {
  x: number;
  y: number;
}

// ---- §6.4 harvest timeline (0ms 上弹+音效 → 60ms 贝塞尔弧起飞 → 300ms 槽位 bounce+浮字+入包音) ----

/** The icon pops on the tile for this beat before the flight starts (§6.4 "60ms"). */
export const FLY_DELAY_MS = 60;
/** Flight duration; FLY_DELAY_MS + FLY_MS lands exactly on the §6.4 300ms mark. */
export const FLY_MS = 240;
/** §6.4 "作物上弹": how far the icon pops up during the pre-flight beat (render px). */
export const POP_PX = 4;

// ---- §10.8 reducedMotion (wired from day one) ----

/** 收割抛物线 → 200ms 淡出: no flight, the icon fades in place; floaters skip the rise. */
export const REDUCED_FADE_MS = 200;
/** Hold before the reduced-motion floater fade so the text stays readable. */
export const REDUCED_FLOAT_HOLD_MS = 500;

// ---- floater motion (render-side presentation; placement & merge rules are the GDD's) ----

export const FLOAT_RISE_PX = 12;
export const FLOAT_MS = 700;
export const FLOAT_FADE_MS = 300;

// ---- same-frame merging (PRD 01 US68: 同帧批量收获合并为一条) ----

export interface HarvestEventLike {
  cropId: CropId;
  count: number;
  xp: number;
  tile: TilePos;
}

export interface HarvestGroup {
  cropId: CropId;
  count: number;
  tile: TilePos;
}

/**
 * Merge one frame's CropHarvested batch: counts collapse per crop (first tile kept as
 * the visual anchor) and ALL xp collapses into one total — the view renders a single
 * "+{xp} xp" floater beside the first item line (§5.8 「飘字合并」).
 */
export function mergeHarvests(events: readonly HarvestEventLike[]): {
  groups: HarvestGroup[];
  totalXp: number;
} {
  const byCrop = new Map<CropId, HarvestGroup>();
  let totalXp = 0;
  for (const ev of events) {
    totalXp += ev.xp;
    const group = byCrop.get(ev.cropId);
    if (group) group.count += ev.count;
    else byCrop.set(ev.cropId, { cropId: ev.cropId, count: ev.count, tile: ev.tile });
  }
  return { groups: [...byCrop.values()], totalXp };
}

export interface PickupEventLike {
  itemId: ItemId;
  count: number;
}

/** Merge one frame's ItemPicked batch per itemId (one flight + one floater per item). */
export function mergePickups(
  events: readonly PickupEventLike[],
): { itemId: ItemId; count: number }[] {
  const byItem = new Map<ItemId, { itemId: ItemId; count: number }>();
  for (const ev of events) {
    const entry = byItem.get(ev.itemId);
    if (entry) entry.count += ev.count;
    else byItem.set(ev.itemId, { itemId: ev.itemId, count: ev.count });
  }
  return [...byItem.values()];
}

// ---- flight path (二次贝塞尔, §6.4) ----

/** Quadratic bezier point: p0 → p1 with control point c. */
export function quadBezier(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/** Arc height above the chord (render choice — the GDD specifies "贝塞尔弧", not px). */
export const FLIGHT_ARC_PX = 40;

/** Control point above the chord midpoint so the icon arcs up before diving to the slot. */
export function flightControlPoint(from: Point, to: Point): Point {
  return { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - FLIGHT_ARC_PX };
}

// ---- ruling A-9: keep every spawned pixel out of the session-HUD reserve ----

const RESERVE_RIGHT = HUD_RESERVED.x + HUD_RESERVED.width;
const RESERVE_BOTTOM = HUD_RESERVED.y + HUD_RESERVED.height;
/** Extra clearance: floaters rise FLOAT_RISE_PX, so points just below the rect count too. */
const RESERVE_MARGIN = 8;

/**
 * Push a spawn point right of the reserve when it would land inside (or rise into) the
 * (4,4)–(156,150) rect. Because the hotbar target x ≥ 222 and the bezier x stays within
 * the hull of {start, control = midpoint, target}, a clamped start keeps the WHOLE
 * flight path out of the reserve.
 */
export function clampOutsideHudReserve(p: Point): Point {
  if (
    p.x < RESERVE_RIGHT + RESERVE_MARGIN &&
    p.y < RESERVE_BOTTOM + FLOAT_RISE_PX + RESERVE_MARGIN
  ) {
    return { x: RESERVE_RIGHT + RESERVE_MARGIN, y: p.y };
  }
  return p;
}

// ---- hotbar geometry (slot rects fixed by GDD §6.6: (222,336), 9×20px + 2px gaps) ----

/** Screen-space center of a hotbar slot; null → the hotbar midpoint fallback (the
 *  received stack sits in a backpack row, GDD §6.2 — no visible slot to bounce). */
export function hotbarSlotCenter(slot: number | null): Point {
  if (slot === null) {
    return { x: HOTBAR.x + HOTBAR.width / 2, y: HOTBAR.y + SLOT_SIZE / 2 };
  }
  return {
    x: HOTBAR.x + slot * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2,
    y: HOTBAR.y + SLOT_SIZE / 2,
  };
}
