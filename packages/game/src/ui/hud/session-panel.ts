/**
 * session-panel.ts — the M2 session-HUD render shell (hud-sessions §3/§4/§5/§6;
 * GDD §7). A quiet notice board in the reserved rect (4,4)–(156,150): it READS
 * the HudStore and computes nothing itself (selectors live in src/hud/store.ts).
 *
 * Render discipline (§3.2): UIScene overlay, integer coordinates, discrete
 * frame/step animations only (no smooth tweens). The ONLY persistent animation
 * is the blocked breathing (2000ms period, 4 alpha steps — ≤0.5Hz photosafe);
 * working spins a 4-frame glyph at ~3fps; everything else is static.
 *
 * Anti-pattern guarantees (§6.2): no modal, no toast, no focus grab, no camera
 * moves, no forced pause — the panel only ever draws inside its own rect (plus
 * the transient hover tooltip to its right).
 *
 * Icons (§12-D5): the 8×8 state icons live in the ui atlas (self-drawn CC0,
 * frames HUD8_FRAMES — sharp at ×1/×2/×3 integer scale, §13-2); `source ===
 * 'process'` renders the `_hollow` stroke variants (US12). When the atlas is
 * not loaded (asset-stream tolerance, see widgets/panel.ts) icons degrade to
 * pixel-font glyphs with a 0.65-alpha dim standing in for hollow. The panel
 * background stays a Graphics rect: §3.2 specifies TWO alphas (fill at the
 * opacity setting, border at 1) which a single nine-slice image cannot carry —
 * the equivalent `hud_panel` 9-slice ships in the atlas for flat-chrome uses.
 *
 * Relayout discipline: the store subscription compares displayProjection()
 * values and only marks dirty when something the layout actually renders
 * changed — heartbeat frames and lastSignalAt-only upserts never rebuild a
 * Text object (§5.3; daemon-side throttle is the second half, §10.2).
 */
import type Phaser from 'phaser';

import { ERROR_MODIFIER_COLOR, SESSION_STATE_COLORS } from '@codestead/shared';
import type { SessionInfo, SessionState } from '@codestead/shared';

import { HUD8_FRAMES, TEXTURES, hud8Hollow } from '../../AssetKeys';
import type { HudStore } from '../../hud/hud-store';
import {
  HIGHLIGHT_MS,
  RESORT_MERGE_WINDOW_MS,
  displayName,
  displayProjection,
  filterDisplaySessions,
  formatDuration,
  movedRowIds,
  planOverflow,
  resortDeferMs,
  sortSessionRows,
  stateCounts,
} from '../../hud/store';
import type { HudState, OverflowPlan } from '../../hud/types';
import { DEPTH, HUD_RESERVED } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { hasFrame } from '../widgets/panel';
import { uiText } from '../widgets/text';

// ---- geometry (hud-sessions §3.2 — values are design law) ----

const PANEL_X = HUD_RESERVED.x; // 4
const PANEL_Y = HUD_RESERVED.y; // 4
const PANEL_W = HUD_RESERVED.width; // 152
const ROW_H = 14;
const PAD = 3;
const ICON_COL_W = 12;
const ICON_GAP = 2;
const TITLE_W = 100;
const COLLAPSED_H = 14; // §4.2
const TOOLTIP_X = PANEL_X + PANEL_W + 4;
const TOOLTIP_MAX_W = 220;
const TOOLTIP_DELAY_MS = 250; // §2.2
const DURATION_REFRESH_MS = 5_000; // §2.3
const BREATH_PERIOD_MS = 2_000; // §3.1 — 4-step ladder, ≤0.5Hz
const BREATH_STEPS = [0.55, 0.7, 0.85, 1.0, 0.85, 0.7] as const; // up-down through 4 levels
const SPINNER_FRAME_MS = 333; // §3.1 ≈3fps
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'] as const;
const FADE_ALPHA = 0.25; // §3.2 autoFade
const FADE_STEPS = 3; // 150ms, 3 discrete steps
const FADE_STEP_MS = 50;
const FADE_RECOVER_DELAY_MS = 300;
const STALE_ALPHA = 0.6; // §8.1 STALE row
const RECEIPT_MS = 800; // §6.1 H-key receipt

// ---- copy (HUD-specific zh-CN strings; calm statements only, §6.2-6) ----

const COPY = {
  empty: '暂无会话',
  disconnected: '会话服务已断开 · 重试中',
  connecting: '连接中…',
  incompatible: '守护进程需要更新（codestead 版本不匹配）',
  staleNote: '数据可能过期',
  overflow: (n: number) => `+${n} 个会话`,
  hiddenReceipt: '会话面板已隐藏（按 H 恢复）',
  lastPrompt: (s: string) => `最近输入：${s}`,
  sourceLine: (s: string, low: boolean) => `信号源：${s}${low ? '（置信度低）' : ''}`,
  unknownHint: '未接入 hooks——在终端运行 npx codestead install',
  stateLabel: {
    blocked: '等待输入',
    done: '已完成',
    working: '工作中',
    idle: '空闲',
    unknown: '未知',
  } as Record<SessionState, string>,
  errorLabel: 'API 错误',
} as const;

/** §2.4 error.kind → calm tooltip copy. */
function errorCopy(kind: string): string {
  switch (kind) {
    case 'rate_limit':
      return 'API 错误：限流（rate_limit），稍后会自动恢复';
    case 'overloaded':
      return 'API 错误：服务过载（overloaded）';
    case 'authentication_failed':
      return 'API 错误：认证失败，需要到终端重新登录';
    case 'billing_error':
      return 'API 错误：计费问题，需要到终端处理';
    default:
      return `API 错误（${kind}）`;
  }
}

/** Icon recipe: atlas frame + glyph/color fallback (shape redundancy, §3.1). */
interface IconSpec {
  readonly frame: string;
  readonly glyph: string;
  readonly color: string;
}

function baseIconSpec(session: SessionInfo, spinnerFrame: number): IconSpec {
  if (session.state === 'blocked' && session.error) {
    return { frame: HUD8_FRAMES.error, glyph: '⚠', color: ERROR_MODIFIER_COLOR };
  }
  switch (session.state) {
    case 'blocked':
      return { frame: HUD8_FRAMES.blocked, glyph: '!', color: SESSION_STATE_COLORS.blocked };
    case 'done':
      return { frame: HUD8_FRAMES.done, glyph: '✓', color: SESSION_STATE_COLORS.done };
    case 'working':
      return {
        frame: HUD8_FRAMES.working[spinnerFrame],
        glyph: SPINNER_FRAMES[spinnerFrame],
        color: SESSION_STATE_COLORS.working,
      };
    case 'idle':
      return { frame: HUD8_FRAMES.idle, glyph: '○', color: SESSION_STATE_COLORS.idle };
    case 'unknown':
      return { frame: HUD8_FRAMES.unknown, glyph: '?', color: SESSION_STATE_COLORS.unknown };
  }
}

/** §3.1 low-confidence modifier: `source === 'process'` swaps in the hollow stroke frame. */
function iconSpecFor(session: SessionInfo, spinnerFrame: number): IconSpec {
  const base = baseIconSpec(session, spinnerFrame);
  return session.source === 'process' ? { ...base, frame: hud8Hollow(base.frame) } : base;
}

/** `~` home abbreviation for tooltip paths (§2.2 line 2). */
export function abbreviateHome(cwd: string): string {
  return cwd.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** HH:MM of an ISO timestamp for the tooltip state line; '—' when unparsable. */
function clockOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Human zh duration for the tooltip state line (§2.2 line 4: 「（12 分钟）」). */
function tooltipDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return '刚刚';
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)} 分钟`;
  if (clamped < 86_400_000) return `${Math.floor(clamped / 3_600_000)} 小时`;
  return `${Math.floor(clamped / 86_400_000)} 天`;
}

/** Atlas image when the ui atlas carries the frame; pixel-font glyph fallback. */
type IconObject = Phaser.GameObjects.Image | Phaser.GameObjects.Text;

interface RowObjects {
  sessionId: string;
  icon: IconObject;
  /**
   * Resting icon alpha (anti-ratchet, review fix): 1 for atlas icons (hollow
   * frames carry the low-confidence style), 0.65 for the glyph-fallback
   * `process` dim. Final per-frame alpha = baseAlpha × animAlpha × panel alpha.
   */
  baseAlpha: number;
  /** Blocked breathing ladder value (1 for everything else). */
  animAlpha: number;
  /** Working rows: advance the 4-frame spinner (image frame or text glyph). */
  spin: ((frame: number) => void) | null;
  title: Phaser.GameObjects.Text;
  duration: Phaser.GameObjects.Text;
  y: number;
}

export interface SessionPanelDeps {
  /** Real-time clock (HUD shows REAL durations — the one allowed place, §1.3). */
  now: () => number;
  /** Player sprite screen rect for autoFade; null = unavailable (fade off). */
  playerScreenRect: () => { x: number; y: number; width: number; height: number } | null;
  reducedMotion: () => boolean;
}

/**
 * The left-top session panel. Owns everything inside (4,4)–(156,150) plus the
 * transient tooltip. `update()` is a no-op while hidden/suppressed/gated
 * (US23: hidden = zero per-frame logic, zero draws).
 */
export class SessionPanel {
  private readonly bg: Phaser.GameObjects.Graphics;
  private readonly highlightGfx: Phaser.GameObjects.Graphics;
  private rows: RowObjects[] = [];
  private extraTexts: Phaser.GameObjects.Text[] = [];
  private extraIcons: IconObject[] = [];
  private readonly hitZone: Phaser.GameObjects.Zone;
  private readonly tooltipBg: Phaser.GameObjects.Graphics;
  private readonly tooltipText: Phaser.GameObjects.Text;
  private receipt: Phaser.GameObjects.Text | null = null;
  private receiptAt = -Infinity;

  /** Displayed row order (ids) — reflows only on §5.3 trigger events. */
  private order: string[] = [];
  private lastMovedAt = new Map<string, number>();
  private pendingResortAt: number | null = null;

  private visibleMode: 'expanded' | 'collapsed' | 'none' = 'none';
  private suppressed = false; // day-summary screen showing (§4.6)
  private dirty = true;
  private lastDurationRefreshAt = 0;
  private lastSpinnerFrame = -1;

  // autoFade stepping state
  private fadeStep = 0; // 0 = opaque … FADE_STEPS = fully faded
  private fadeLastStepAt = 0;
  private fadeClearSince: number | null = null;

  // hover/tooltip state
  private hoverRow: number | null = null;
  private hoverStartAt = 0;
  private hoveredSessionId: string | null = null;
  private hoverIsOverflow = false;

  private panelH = 0;
  private chips: { key: SessionState; icon: IconObject; count: Phaser.GameObjects.Text }[] = [];
  private chipAppearAt = new Map<string, number>();
  private prevChipCounts: Record<string, number> = {};
  private flashAllBlockedAt: number | null = null;
  /** Last rendered displayProjection() — equal projections skip the relayout (§5.3). */
  private lastProjection: string | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly store: HudStore,
    private readonly deps: SessionPanelDeps,
  ) {
    this.bg = scene.add.graphics().setDepth(DEPTH.hud);
    this.highlightGfx = scene.add.graphics().setDepth(DEPTH.hud + 1);
    this.tooltipBg = scene.add.graphics().setDepth(DEPTH.tooltip).setVisible(false);
    this.tooltipText = uiText(scene, TOOLTIP_X + PAD + 1, PANEL_Y + PAD, '', {
      color: PALETTE.ui.text,
      wrapWidth: TOOLTIP_MAX_W - 8,
    })
      .setDepth(DEPTH.tooltip + 1)
      .setVisible(false);

    this.hitZone = scene.add
      .zone(PANEL_X, PANEL_Y, PANEL_W, ROW_H)
      .setOrigin(0, 0)
      .setDepth(DEPTH.hud + 2);
    this.hitZone.setInteractive();
    // Swallow clicks so nobody hoes a tile through the panel (§11-16); the
    // hidden mode disables the zone (does NOT swallow).
    this.hitZone.on(
      'pointerdown',
      (_p: Phaser.Input.Pointer, _x: number, _y: number, event: { stopPropagation(): void }) => {
        event.stopPropagation();
      },
    );
    this.hitZone.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.onPointerMove(pointer);
    });
    this.hitZone.on('pointerout', () => {
      this.clearHover();
    });

    this.store.subscribe((state) => {
      // Display-projection compare (§5.3 / §10.2): heartbeats and
      // lastSignalAt-only upserts produce an identical projection — no dirty,
      // no Text rasterization. Cooldown stamps are read per-frame instead.
      const projection = displayProjection(state);
      if (projection !== this.lastProjection) {
        this.lastProjection = projection;
        this.dirty = true;
      }
    });
  }

  /** Day-summary screen showing ⇒ panel hides; store keeps updating (§4.6/§11-19). */
  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    this.dirty = true;
  }

  /** H-key receipt: brief fading note at the panel anchor (§6.1 last row). */
  showHiddenReceipt(): void {
    this.receipt?.destroy();
    this.receipt = uiText(this.scene, PANEL_X, PANEL_Y, COPY.hiddenReceipt, {
      color: PALETTE.ui.textDim,
    }).setDepth(DEPTH.hud);
    this.receiptAt = this.deps.now();
  }

  /** §11-15: on tab visibility regain — recompute durations + ONE blocked flash. */
  onTabVisible(): void {
    this.lastDurationRefreshAt = 0;
    this.flashAllBlockedAt = this.deps.now();
    this.dirty = true;
  }

  destroy(): void {
    this.bg.destroy();
    this.highlightGfx.destroy();
    this.tooltipBg.destroy();
    this.tooltipText.destroy();
    this.hitZone.destroy();
    this.receipt?.destroy();
    this.clearRowObjects();
  }

  /** Per-frame driver. Hidden/gated/suppressed ⇒ near-zero work (one flag check). */
  update(): void {
    const now = this.deps.now();
    this.tickReceipt(now);

    const state = this.store.getState();
    const mode = this.effectiveMode(state);
    if (this.pendingResortAt !== null && now >= this.pendingResortAt) {
      this.pendingResortAt = null;
      this.dirty = true;
    }
    if (this.dirty || mode !== this.visibleMode) {
      this.layout(state, mode, now);
      this.dirty = false;
    }
    if (mode === 'none') return; // hidden / gated / suppressed: no per-frame logic

    this.tickAnimations(state, now);
    this.tickDurations(state, now);
    this.tickAutoFade(state, now);
    this.tickTooltip(state, now);
  }

  // ---- mode & layout ----

  private effectiveMode(state: HudState): 'expanded' | 'collapsed' | 'none' {
    if (!state.everConnected || this.suppressed) return 'none'; // §8.2 gate / §11-19
    if (state.settings.displayMode === 'hidden') return 'none';
    return state.settings.displayMode;
  }

  /** Rows the panel would display, in stable display order (§5.3 discipline). */
  private displayRows(
    state: HudState,
    now: number,
  ): {
    plan: OverflowPlan;
    all: SessionInfo[];
  } {
    const filtered = filterDisplaySessions([...state.sessions.values()], state.settings);
    const target = sortSessionRows(filtered);
    const targetIds = target.map((s) => s.sessionId);

    // §5.3: add/remove always reflow; pure state-changes within the same
    // membership defer while any mover re-sorted < 10s ago (counts/icons
    // update immediately either way — only the ORDER waits).
    const sameMembership =
      this.order.length === targetIds.length && this.order.every((id) => targetIds.includes(id));
    let ids = targetIds;
    if (sameMembership && !arraysEqual(this.order, targetIds)) {
      const wait = resortDeferMs(this.order, targetIds, this.lastMovedAt, now);
      if (wait > 0) {
        ids = this.order;
        this.pendingResortAt = Math.min(this.pendingResortAt ?? Infinity, now + wait);
      } else {
        for (const id of movedRowIds(this.order, targetIds)) this.lastMovedAt.set(id, now);
      }
    } else if (!arraysEqual(this.order, targetIds)) {
      // membership change: reflow now; movers still stamp their merge window
      for (const id of movedRowIds(this.order, targetIds)) this.lastMovedAt.set(id, now);
    }
    this.order = ids;
    const byId = new Map(target.map((s) => [s.sessionId, s]));
    const ordered = ids.map((id) => byId.get(id)).filter((s): s is SessionInfo => s !== undefined);
    return { plan: planOverflow(ordered, state.settings.maxRows), all: target };
  }

  private layout(state: HudState, mode: 'expanded' | 'collapsed' | 'none', now: number): void {
    this.clearRowObjects();
    this.bg.clear();
    this.highlightGfx.clear();
    this.visibleMode = mode;

    if (mode === 'none') {
      this.hitZone.disableInteractive(); // hidden never swallows clicks (§11-16)
      this.hideTooltip();
      return;
    }
    this.hitZone.setInteractive();

    const phase = state.conn.phase;
    const disconnectIcon: IconSpec = {
      frame: HUD8_FRAMES.disconnected,
      glyph: '⌁',
      color: PALETTE.hud.disconnected,
    };
    if (phase === 'backoff') {
      this.drawBar(disconnectIcon, COPY.disconnected, state);
      return;
    }
    if (phase === 'incompatible') {
      this.drawBar(disconnectIcon, COPY.incompatible, state);
      return;
    }
    if (phase === 'connecting' || phase === 'handshaking') {
      this.drawBar(disconnectIcon, COPY.connecting, state);
      return;
    }

    // LIVE / STALE
    if (mode === 'collapsed') {
      this.layoutCollapsed(state, now);
      return;
    }
    const { plan, all } = this.displayRows(state, now);
    if (plan.visible.length === 0) {
      this.drawBar(
        { frame: HUD8_FRAMES.idle, glyph: '○', color: PALETTE.ui.textDim },
        COPY.empty,
        state,
      );
      return;
    }
    const staleLine = phase === 'stale' ? 1 : 0;
    const overflowLine = plan.overflowCount > 0 ? 1 : 0;
    const rowCount = plan.visible.length + overflowLine + staleLine;
    this.panelH = 6 + rowCount * ROW_H; // §3.2 height formula
    this.drawPanelBg(PANEL_W, this.panelH, state);

    const spinnerFrame = this.spinnerFrame(now);
    plan.visible.forEach((session, i) => {
      const y = PANEL_Y + PAD + i * ROW_H;
      const made = this.addIcon(PANEL_X + PAD + 2, y, session, spinnerFrame);
      const name = state.settings.streamerMode
        ? session.sessionId.slice(0, 8) // privacy: never show title/cwd on stream (§2.2/§9)
        : displayName(session, all);
      const titleText = uiText(
        this.scene,
        PANEL_X + PAD + ICON_COL_W + ICON_GAP,
        y,
        truncateToWidth(this.scene, name, TITLE_W),
        { color: PALETTE.ui.text },
      ).setDepth(DEPTH.hud + 1);
      const durationText = uiText(
        this.scene,
        PANEL_X + PANEL_W - PAD,
        y,
        this.durationLabel(session, now),
        { color: PALETTE.ui.textDim },
      )
        .setOrigin(1, 0)
        .setDepth(DEPTH.hud + 1);
      this.rows.push({
        sessionId: session.sessionId,
        icon: made.icon,
        baseAlpha: made.baseAlpha,
        animAlpha: 1,
        spin: session.state === 'working' ? made.spin : null,
        title: titleText,
        duration: durationText,
        y,
      });
    });

    let y = PANEL_Y + PAD + plan.visible.length * ROW_H;
    if (overflowLine) {
      this.extraTexts.push(
        uiText(this.scene, PANEL_X + PAD + 2, y, COPY.overflow(plan.overflowCount), {
          color: PALETTE.ui.textDim,
        }).setDepth(DEPTH.hud + 1),
      );
      y += ROW_H;
    }
    if (staleLine) {
      this.extraTexts.push(
        uiText(this.scene, PANEL_X + PAD + 2, y, COPY.staleNote, {
          color: PALETTE.ui.textDim,
        }).setDepth(DEPTH.hud + 1),
      );
    }
    this.hitZone.setSize(PANEL_W, this.panelH);
    this.applyPanelAlpha(state);
  }

  /** Collapsed strip: `!2 ✓1 ◐3` — non-zero groups only, fixed order ! ✓ ◐ ○ ? (§4.2). */
  private layoutCollapsed(state: HudState, now: number): void {
    const filtered = filterDisplaySessions([...state.sessions.values()], state.settings);
    const counts = stateCounts(new Map(filtered.map((s) => [s.sessionId, s])));
    const groups: { key: SessionState; spec: IconSpec }[] = [
      {
        key: 'blocked',
        spec: { frame: HUD8_FRAMES.blocked, glyph: '!', color: SESSION_STATE_COLORS.blocked },
      },
      {
        key: 'done',
        spec: { frame: HUD8_FRAMES.done, glyph: '✓', color: SESSION_STATE_COLORS.done },
      },
      {
        key: 'working',
        spec: { frame: HUD8_FRAMES.working[0], glyph: '◐', color: SESSION_STATE_COLORS.working },
      },
      {
        key: 'idle',
        spec: { frame: HUD8_FRAMES.idle, glyph: '○', color: SESSION_STATE_COLORS.idle },
      },
      {
        key: 'unknown',
        spec: { frame: HUD8_FRAMES.unknown, glyph: '?', color: SESSION_STATE_COLORS.unknown },
      },
    ];
    const visible = groups.filter((g) => counts[g.key] > 0);
    // chip first-appearance flash bookkeeping (§6.1 collapsed row)
    for (const g of groups) {
      const prev = this.prevChipCounts[g.key] ?? 0;
      if (counts[g.key] > 0 && prev === 0) this.chipAppearAt.set(g.key, now);
      this.prevChipCounts[g.key] = counts[g.key];
    }
    if (visible.length === 0) {
      this.drawBar(
        { frame: HUD8_FRAMES.idle, glyph: '○', color: PALETTE.ui.textDim },
        COPY.empty,
        state,
      );
      return;
    }
    this.panelH = COLLAPSED_H;
    this.drawPanelBg(PANEL_W, COLLAPSED_H, state);
    let x = PANEL_X + PAD + 2;
    for (const g of visible) {
      const made = this.makeIcon(x, PANEL_Y + 1, g.spec);
      x += made.isImage ? 9 : Math.ceil((made.icon as Phaser.GameObjects.Text).width) + 1;
      const count = uiText(this.scene, x, PANEL_Y + 1, String(counts[g.key]), {
        color: g.spec.color,
      }).setDepth(DEPTH.hud + 1);
      this.chips.push({ key: g.key, icon: made.icon, count });
      x += Math.ceil(count.width) + 8;
    }
    this.hitZone.setSize(PANEL_W, COLLAPSED_H);
    this.applyPanelAlpha(state);
  }

  /** Single-line status bar (empty / disconnected / connecting / incompatible, §4.4/§4.5). */
  private drawBar(spec: IconSpec, text: string, state: HudState): void {
    const label = uiText(this.scene, PANEL_X + PAD + ICON_COL_W + ICON_GAP, PANEL_Y + PAD, text, {
      color: PALETTE.ui.textDim,
    }).setDepth(DEPTH.hud + 1);
    this.extraTexts.push(label);
    const made = this.makeIcon(PANEL_X + PAD + 2, PANEL_Y + PAD, spec);
    if (made.isImage) this.extraIcons.push(made.icon);
    else this.extraTexts.push(made.icon as Phaser.GameObjects.Text);
    const w = Math.min(PANEL_W, Math.ceil(label.x + label.width) - PANEL_X + PAD);
    this.panelH = 6 + ROW_H;
    this.drawPanelBg(Math.max(w, 64), this.panelH, state);
    this.hitZone.setSize(PANEL_W, this.panelH);
    this.applyPanelAlpha(state);
  }

  // ---- icon construction (atlas image with glyph fallback, §12-D5) ----

  /** 8×8 atlas icon at the row's text anchor; pixel-font glyph fallback. */
  private makeIcon(x: number, y: number, spec: IconSpec): { icon: IconObject; isImage: boolean } {
    if (hasFrame(this.scene, TEXTURES.ui, spec.frame)) {
      const image = this.scene.add
        .image(x, y + 2, TEXTURES.ui, spec.frame) // 8×8 centered in the 12px text row
        .setOrigin(0, 0)
        .setDepth(DEPTH.hud + 1);
      return { icon: image, isImage: true };
    }
    const text = uiText(this.scene, x, y, spec.glyph, { color: spec.color }).setDepth(
      DEPTH.hud + 1,
    );
    return { icon: text, isImage: false };
  }

  /** Session row icon: hollow frame carries `process`; glyph fallback dims to 0.65. */
  private addIcon(
    x: number,
    y: number,
    session: SessionInfo,
    spinnerFrame: number,
  ): { icon: IconObject; baseAlpha: number; spin: (frame: number) => void } {
    const spec = iconSpecFor(session, spinnerFrame);
    const made = this.makeIcon(x, y, spec);
    const hollow = session.source === 'process';
    const baseAlpha = made.isImage || !hollow ? 1 : 0.65;
    made.icon.setAlpha(baseAlpha);
    const spin = (frame: number): void => {
      if (made.isImage) {
        const name = HUD8_FRAMES.working[frame];
        (made.icon as Phaser.GameObjects.Image).setFrame(hollow ? hud8Hollow(name) : name);
      } else {
        (made.icon as Phaser.GameObjects.Text).setText(SPINNER_FRAMES[frame]);
      }
    };
    return { icon: made.icon, baseAlpha, spin };
  }

  private drawPanelBg(w: number, h: number, state: HudState): void {
    this.bg.clear();
    this.bg.fillStyle(hexToNum(PALETTE.hud.panelBg), state.settings.opacity);
    this.bg.fillRect(PANEL_X, PANEL_Y, w, h);
    this.bg.lineStyle(1, hexToNum(PALETTE.hud.panelBorder), 1);
    this.bg.strokeRect(PANEL_X + 0.5, PANEL_Y + 0.5, w - 1, h - 1); // square corners (§3.2)
  }

  // ---- per-frame ticks (LIVE panel only) ----

  private spinnerFrame(now: number): number {
    return this.deps.reducedMotion()
      ? 0
      : Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
  }

  private tickAnimations(state: HudState, now: number): void {
    // working spinner — 4 frames, ~3fps (§3.1)
    const frame = this.spinnerFrame(now);
    if (frame !== this.lastSpinnerFrame) {
      this.lastSpinnerFrame = frame;
      for (const row of this.rows) row.spin?.(frame);
    }
    // blocked breathing — 2000ms, 4 alpha steps, the ONLY persistent animation
    // (§3.1). Only animAlpha changes here; applyPanelAlpha composes
    // baseAlpha × animAlpha × panel alpha every frame (anti-ratchet).
    const breathing = this.deps.reducedMotion()
      ? 1
      : BREATH_STEPS[
          Math.floor(((now % BREATH_PERIOD_MS) / BREATH_PERIOD_MS) * BREATH_STEPS.length)
        ];
    for (const row of this.rows) {
      const session = state.sessions.get(row.sessionId);
      row.animAlpha = session?.state === 'blocked' ? breathing : 1;
    }
    // 600ms row highlight, 3-step fade (§3.2/§6.1) + chip flash + tab-return blocked flash
    this.highlightGfx.clear();
    for (const row of this.rows) {
      const session = state.sessions.get(row.sessionId);
      const cd = state.cooldowns.get(row.sessionId);
      const stampedAt = cd?.lastHighlightAt ?? -Infinity;
      const flashAt =
        session?.state === 'blocked' && this.flashAllBlockedAt !== null
          ? Math.max(stampedAt, this.flashAllBlockedAt)
          : stampedAt;
      const age = now - flashAt;
      if (age >= 0 && age < HIGHLIGHT_MS) {
        const step = Math.floor((age / HIGHLIGHT_MS) * 3); // 3 discrete fade steps
        const alpha = 0.12 * (1 - step / 3);
        this.highlightGfx.fillStyle(hexToNum(PALETTE.hud.highlight), alpha);
        this.highlightGfx.fillRect(PANEL_X + 1, row.y - 1, PANEL_W - 2, ROW_H);
      }
    }
    if (this.flashAllBlockedAt !== null && now - this.flashAllBlockedAt >= HIGHLIGHT_MS) {
      this.flashAllBlockedAt = null;
    }
    if (this.visibleMode === 'collapsed') {
      for (const chip of this.chips) {
        const at = this.chipAppearAt.get(chip.key);
        if (at !== undefined && now - at < HIGHLIGHT_MS) {
          const step = Math.floor(((now - at) / HIGHLIGHT_MS) * 3);
          const width = chip.count.x + Math.ceil(chip.count.width) - chip.icon.x;
          this.highlightGfx.fillStyle(hexToNum(PALETTE.hud.highlight), 0.12 * (1 - step / 3));
          this.highlightGfx.fillRect(chip.icon.x - 2, PANEL_Y + 1, width + 4, 12);
        }
      }
    }
  }

  /** §2.3: duration TEXT refreshes every 5s; never triggers a reflow. */
  private tickDurations(state: HudState, now: number): void {
    if (now - this.lastDurationRefreshAt < DURATION_REFRESH_MS) return;
    this.lastDurationRefreshAt = now;
    for (const row of this.rows) {
      const session = state.sessions.get(row.sessionId);
      if (session) row.duration.setText(this.durationLabel(session, now));
    }
  }

  private durationLabel(session: SessionInfo, now: number): string {
    if (session.state === 'unknown') return '—'; // §2.1/§11-14
    const since = Date.parse(session.since);
    if (Number.isNaN(since)) return '—'; // §10.2 parse failure
    return formatDuration(now - since);
  }

  /** autoFade: player behind panel → alpha 0.25 in 3 steps; recover 300ms after clear (§3.2). */
  private tickAutoFade(state: HudState, now: number): void {
    if (!state.settings.autoFade) {
      this.fadeStep = 0;
      this.fadeClearSince = null;
      this.applyPanelAlpha(state);
      return;
    }
    const rect = this.deps.playerScreenRect();
    const intersects =
      rect !== null &&
      rect.x < PANEL_X + PANEL_W &&
      rect.x + rect.width > PANEL_X &&
      rect.y < PANEL_Y + this.panelH &&
      rect.y + rect.height > PANEL_Y;
    const target = intersects ? FADE_STEPS : 0;
    if (intersects) this.fadeClearSince = null;
    else if (this.fadeStep > 0 && this.fadeClearSince === null) this.fadeClearSince = now;

    const mayRecover =
      target === 0 &&
      this.fadeClearSince !== null &&
      now - this.fadeClearSince >= FADE_RECOVER_DELAY_MS;
    if (this.fadeStep !== target && now - this.fadeLastStepAt >= FADE_STEP_MS) {
      if (target > this.fadeStep) {
        this.fadeStep += 1;
        this.fadeLastStepAt = now;
      } else if (mayRecover) {
        this.fadeStep -= 1;
        this.fadeLastStepAt = now;
      }
    }
    this.applyPanelAlpha(state);
  }

  private applyPanelAlpha(state: HudState): void {
    const fadeRatio = this.fadeStep / FADE_STEPS;
    const fadeAlpha = 1 - (1 - FADE_ALPHA) * fadeRatio;
    const staleFactor = state.conn.phase === 'stale' ? STALE_ALPHA : 1; // §8.1 STALE
    const alpha = fadeAlpha * staleFactor;
    this.bg.setAlpha(alpha);
    this.highlightGfx.setAlpha(alpha);
    for (const row of this.rows) {
      // Composed, never ratcheted: resting style × breathing × panel fade/stale.
      row.icon.setAlpha(row.baseAlpha * row.animAlpha * alpha);
      row.title.setAlpha(alpha);
      row.duration.setAlpha(alpha);
    }
    for (const text of this.extraTexts) text.setAlpha(alpha);
    for (const icon of this.extraIcons) icon.setAlpha(alpha);
    for (const chip of this.chips) {
      chip.icon.setAlpha(alpha);
      chip.count.setAlpha(alpha);
    }
  }

  // ---- hover tooltip (§2.2 — 250ms delay, right of the panel) ----

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.visibleMode !== 'expanded') {
      this.clearHover();
      return;
    }
    const rowIndex = Math.floor((pointer.y - PANEL_Y - PAD) / ROW_H);
    const overflowIndex = this.rows.length; // overflow line sits right below rows
    const isOverflow = rowIndex === overflowIndex && this.extraTexts.length > 0;
    const valid = (rowIndex >= 0 && rowIndex < this.rows.length) || isOverflow;
    if (!valid) {
      this.clearHover();
      return;
    }
    if (this.hoverRow !== rowIndex) {
      this.hoverRow = rowIndex;
      this.hoverIsOverflow = isOverflow;
      this.hoveredSessionId = isOverflow ? null : (this.rows[rowIndex]?.sessionId ?? null);
      this.hoverStartAt = this.deps.now();
      this.hideTooltip();
    }
  }

  private clearHover(): void {
    this.hoverRow = null;
    this.hoveredSessionId = null;
    this.hoverIsOverflow = false;
    this.hideTooltip();
  }

  private tickTooltip(state: HudState, now: number): void {
    if (this.hoverRow === null) return;
    // §11-17: hovered session removed ⇒ row & tooltip vanish together.
    if (!this.hoverIsOverflow && this.hoveredSessionId !== null) {
      if (!state.sessions.has(this.hoveredSessionId)) {
        this.clearHover();
        return;
      }
    }
    if (now - this.hoverStartAt < TOOLTIP_DELAY_MS) return;
    if (this.tooltipText.visible) return;

    const lines = this.hoverIsOverflow
      ? this.overflowTooltipLines(state)
      : this.sessionTooltipLines(state, now);
    if (lines.length === 0) return;
    const rowY = PANEL_Y + PAD + Math.max(0, this.hoverRow) * ROW_H;
    this.tooltipText.setText(lines.join('\n'));
    this.tooltipText.setPosition(TOOLTIP_X + PAD + 1, rowY);
    const w = Math.min(TOOLTIP_MAX_W, Math.ceil(this.tooltipText.width) + 8);
    const h = Math.ceil(this.tooltipText.height) + 6;
    this.tooltipBg.clear();
    this.tooltipBg.fillStyle(hexToNum(PALETTE.hud.panelBg), 0.92);
    this.tooltipBg.fillRect(TOOLTIP_X, rowY - PAD, w, h);
    this.tooltipBg.lineStyle(1, hexToNum(PALETTE.hud.panelBorder), 1);
    this.tooltipBg.strokeRect(TOOLTIP_X + 0.5, rowY - PAD + 0.5, w - 1, h - 1);
    this.tooltipBg.setVisible(true);
    this.tooltipText.setVisible(true);
  }

  private sessionTooltipLines(state: HudState, now: number): string[] {
    const session =
      this.hoveredSessionId !== null ? state.sessions.get(this.hoveredSessionId) : undefined;
    if (!session) return [];
    const streamer = state.settings.streamerMode;
    const lines: string[] = [];
    if (!streamer && session.title) lines.push(session.title);
    if (streamer) lines.push(session.sessionId.slice(0, 8));
    if (!streamer && session.cwd) lines.push(abbreviateHome(session.cwd)); // §2.2-2, privacy §2.2 note
    if (!streamer && session.subtitle) lines.push(COPY.lastPrompt(session.subtitle)); // §2.2-3
    const label =
      session.state === 'blocked' && session.error
        ? COPY.errorLabel
        : COPY.stateLabel[session.state];
    const since = Date.parse(session.since);
    lines.push(
      Number.isNaN(since)
        ? label
        : `${label} · ${clockOf(session.since)} 起（${tooltipDuration(now - since)}）`,
    );
    lines.push(COPY.sourceLine(session.source, session.source === 'process')); // §2.2-5
    if (session.error) lines.push(errorCopy(session.error.kind)); // §2.2-6
    if (session.state === 'unknown') lines.push(COPY.unknownHint); // §2.2-6'
    return lines;
  }

  /** Overflow row tooltip: icon+name list, capped at 12 (§5.2/§11-12). */
  private overflowTooltipLines(state: HudState): string[] {
    const { plan, all } = this.displayRows(state, this.deps.now());
    return plan.overflowPreview.map((session) => {
      const icon = baseIconSpec(session, 0);
      const name = state.settings.streamerMode
        ? session.sessionId.slice(0, 8)
        : displayName(session, all);
      return `${icon.glyph} ${name}`;
    });
  }

  private hideTooltip(): void {
    this.tooltipBg.setVisible(false);
    this.tooltipText.setVisible(false);
  }

  // ---- misc ----

  private tickReceipt(now: number): void {
    if (this.receipt && now - this.receiptAt >= RECEIPT_MS) {
      this.receipt.destroy();
      this.receipt = null;
    }
  }

  private clearRowObjects(): void {
    for (const row of this.rows) {
      row.icon.destroy();
      row.title.destroy();
      row.duration.destroy();
    }
    this.rows = [];
    for (const text of this.extraTexts) text.destroy();
    this.extraTexts = [];
    for (const icon of this.extraIcons) icon.destroy();
    this.extraIcons = [];
    for (const chip of this.chips) {
      chip.icon.destroy();
      chip.count.destroy();
    }
    this.chips = [];
    this.highlightGfx.clear();
    this.lastSpinnerFrame = -1;
  }
}

/** Resort merge-window re-export so the controller can schedule deferred reflows. */
export const RESORT_WINDOW_MS = RESORT_MERGE_WINDOW_MS;

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Pixel-width truncation with `…` (§2.1) — measured with a throwaway Text object. */
function truncateToWidth(scene: Phaser.Scene, text: string, maxWidth: number): string {
  const probe = uiText(scene, -1000, -1000, text).setVisible(false);
  try {
    if (probe.width <= maxWidth) return text;
    let result = text;
    while (result.length > 1) {
      result = result.slice(0, -1);
      probe.setText(`${result}…`);
      if (probe.width <= maxWidth) return `${result}…`;
    }
    return `${result}…`;
  } finally {
    probe.destroy();
  }
}
