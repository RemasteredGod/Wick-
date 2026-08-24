/**
 * Toolbar icon rendering.
 *
 * The icon is the primary surface: a gauge whose fill is quota remaining and
 * whose colour is threshold state, so status is readable without clicking.
 *
 * The drawing is split in two. `iconDisplayList` is pure — it turns a reading
 * into an ordered list of fill operations in device pixels — and `execute` is a
 * thin walk of that list against a canvas context. Everything worth being sure
 * about (which colour, how tall the fill, whether to redraw at all) lives in the
 * pure half, which runs in a test environment that has no `OffscreenCanvas` and
 * is not getting one.
 *
 * Nothing in this module may throw into the service worker. A toolbar icon is
 * not worth taking collection down for.
 */

import {
  FLAME_ROTATION_DEGREES,
  MARK_SIZES,
  bodyPath,
  fillRect,
  flamePath,
  rasterLayout,
  remainingFor,
} from '~/assets/mark';
import { field, thresholdState } from '~/core/normalise';
import type { LimitStatus, ThresholdState } from '~/core/types';
import { KEYS, readSnapshot } from './store';

/** Icon sizes Chrome asks for. */
export const ICON_SIZES = [16, 32, 48] as const;

/** Utilization is bucketed to this granularity before deciding to redraw. */
export const REDRAW_BUCKET_PERCENT = 5;

/**
 * Threshold colours, mirrored from `src/styles/tokens.css`.
 *
 * A service worker has no document, so `getComputedStyle` and CSS custom
 * properties are both unavailable — the values have to be literals here.
 * `tokens.css` remains the source of truth; these are copies of it. Exactly six
 * tokens are mirrored, listed below. If one changes there, change it here in
 * the same commit.
 */
const COLOURS = {
  /** `--wick-track` — the unfilled body, and the unlit flame. */
  track: '#332f2b',
  /** `--wick-flame` — the flame, whenever there is a reading. */
  flame: '#e8a33d',
  /** `--wick-accent` — the fill below the warn threshold. */
  accent: '#c96442',
  /** `--wick-warn` */
  warn: '#d99a2b',
  /** `--wick-crit` */
  crit: '#d92b31',
  /** `--wick-text-dim` — the "no reading" dash. */
  dim: '#8a857d',
} as const;

/**
 * Height of the unknown-state dash, as a fraction of the body.
 *
 * Sized rather than fixed so it is one pixel at 16px and a legible bar at 48px.
 */
const UNKNOWN_DASH_FRACTION = 0.1;

/** A reading, reduced to the two things the icon draws. */
export interface Gauge {
  /** Quota **remaining**, 0–100, or null when nothing is known. */
  remaining: number | null;
  /** Worst state across all windows. Drives colour, and nothing else does. */
  state: ThresholdState;
}

/* ---- Display list -------------------------------------------------------- */

/** Fill a path, optionally rotated about a point. */
export interface FillPathOp {
  kind: 'path';
  /** SVG path data, in device pixels. */
  d: string;
  colour: string;
  /** Rotation about a point, in degrees. Null when unrotated. */
  rotate: { degrees: number; x: number; y: number } | null;
}

/** Fill an axis-aligned rectangle, optionally clipped to a path. */
export interface FillRectOp {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  colour: string;
  /** Path data the rect is clipped to. Null when unclipped. */
  clip: string | null;
}

export type DrawOp = FillPathOp | FillRectOp;

/**
 * The mark, as a list of fills, for one icon size.
 *
 * Drawn back to front: flame, body track, then whatever the reading puts inside
 * the body — clipped to the body path rather than rounded, matching the
 * archive's `overflow: hidden`, so a nearly-empty gauge keeps the capsule's
 * bottom edge.
 *
 * **Three states have to be told apart at 16 pixels**, and "no reading" is the
 * one that must never be mistaken for good news:
 *
 * - *full* — the body is solid colour to its top, flame lit.
 * - *empty* — the body is bare track, flame lit. Burnt out, and it looks it.
 * - *unknown* — the body is bare track with a dim dash across its middle, and
 *   the flame is drawn in the track colour rather than lit. Two cues, and the
 *   dash is the load-bearing one: it sits at mid-height and is not anchored to
 *   the bottom, so it cannot be read as a level. Nothing else in the icon ever
 *   floats.
 *
 * A window can report `exceeded` with no number at all, which is "we don't know
 * how much is left, but you are blocked". That renders as the unknown gauge
 * with the dash in the state's colour, so the alarm survives the missing digit.
 */
export function iconDisplayList(gauge: Gauge, size: number): DrawOp[] {
  // One geometry at every size. The only size-specific concession is the
  // minimum body width inside `rasterLayout` — see docs/decisions/0004.
  const { body, flame } = rasterLayout(MARK_SIZES.hero, size);
  const track = bodyPath(body.x, body.y, body.width, body.height, body.radius);
  const lit = gauge.remaining !== null;

  const ops: DrawOp[] = [
    {
      kind: 'path',
      d: flamePath(flame.x, flame.y, flame.size),
      colour: lit ? COLOURS.flame : COLOURS.track,
      rotate: { degrees: FLAME_ROTATION_DEGREES, x: flame.centreX, y: flame.centreY },
    },
    { kind: 'path', d: track, colour: COLOURS.track, rotate: null },
  ];

  if (gauge.remaining === null) {
    const height = Math.max(1, Math.round(body.height * UNKNOWN_DASH_FRACTION));
    ops.push({
      kind: 'rect',
      x: body.x,
      y: Math.round(body.y + (body.height - height) / 2),
      width: body.width,
      height,
      colour: gauge.state === 'unknown' ? COLOURS.dim : fillColour(gauge.state),
      clip: track,
    });
    return ops;
  }

  const fill = fillRect(body, gauge.remaining);
  if (fill.height <= 0) return ops;

  // A sliver left is not the same as none left, and at 16px one percent of the
  // body rounds to nothing. Anything above zero gets at least one pixel.
  const height = Math.max(1, Math.round(fill.height));
  ops.push({
    kind: 'rect',
    x: body.x,
    y: body.y + body.height - height,
    width: body.width,
    height,
    colour: fillColour(gauge.state),
    clip: track,
  });

  return ops;
}

function fillColour(state: ThresholdState): string {
  switch (state) {
    case 'warn':
      return COLOURS.warn;
    case 'crit':
      return COLOURS.crit;
    case 'unknown':
      return COLOURS.dim;
    case 'ok':
      return COLOURS.accent;
  }
}

/* ---- Reading a snapshot -------------------------------------------------- */

/** Ranked so the worst window wins. `unknown` loses to any real reading. */
const STATE_RANK: Record<ThresholdState, number> = { unknown: 0, ok: 1, warn: 2, crit: 3 };

/**
 * Reduce a stored snapshot to a gauge, defensively.
 *
 * Takes `unknown` because this runs on whatever `chrome.storage` happens to
 * hold — a snapshot written by an older version, or a half-written one. Every
 * field is checked; nothing here throws.
 *
 * Remaining comes from the most constrained window, but the colour comes from
 * the worst *state*, which need not be the same window: a window bound at 40%
 * outranks a comfortable one at 85%.
 */
export function gaugeFor(snapshot: unknown): Gauge {
  const windows = field(snapshot, 'windows');
  if (!Array.isArray(windows)) return { remaining: null, state: 'unknown' };

  const list: unknown[] = windows;
  const utilizations: (number | null)[] = [];
  let state: ThresholdState = 'unknown';

  for (const window of list) {
    const utilization = utilizationOf(window);
    utilizations.push(utilization);
    const next = thresholdState(utilization, statusOf(window));
    if (STATE_RANK[next] > STATE_RANK[state]) state = next;
  }

  return { remaining: remainingFor(utilizations), state };
}

function utilizationOf(window: unknown): number | null {
  const value = field(window, 'utilization');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function statusOf(window: unknown): LimitStatus {
  const value = field(window, 'status');
  return value === 'ok' || value === 'approaching' || value === 'exceeded' ? value : 'unknown';
}

/* ---- Bucketing ----------------------------------------------------------- */

/** What the toolbar is showing, in the only terms a redraw decision needs. */
export interface IconBucket {
  /** Remaining quantised to `REDRAW_BUCKET_PERCENT`, or null when unknown. */
  bucket: number | null;
  state: ThresholdState;
}

export function bucketFor(gauge: Gauge): IconBucket {
  return {
    bucket: gauge.remaining === null ? null : Math.round(gauge.remaining / REDRAW_BUCKET_PERCENT),
    state: gauge.state,
  };
}

/**
 * Whether a new reading is worth redrawing for.
 *
 * The collector polls far more often than the icon changes, and at 16px a
 * percentage point is a tenth of a device pixel. Redrawing three canvases for a
 * difference nobody can see costs battery and buys nothing. A colour change
 * always redraws, even at an identical percentage — that is the transition the
 * user most needs to notice.
 */
export function needsRedraw(previous: IconBucket | null, next: IconBucket): boolean {
  if (previous === null) return true;
  return previous.bucket !== next.bucket || previous.state !== next.state;
}

/**
 * What the toolbar was last painted with.
 *
 * Module-level, so it is lost when the worker is torn down. That is harmless:
 * the icon Chrome is holding does not disappear with the worker, and the next
 * wake repaints unconditionally because `previous` is null. The cost of losing
 * it is at most one redundant draw, which produces the same pixels.
 */
let painted: IconBucket | null = null;

/* ---- Drawing ------------------------------------------------------------- */

/**
 * Render every size Chrome asks for.
 *
 * Impure and untested — `OffscreenCanvas` does not exist in the test
 * environment and a fake one would be a canvas polyfill by another name.
 * Everything it depends on is tested; this is the walk.
 */
function render(gauge: Gauge): Record<number, ImageData> {
  const images: Record<number, ImageData> = {};
  for (const size of ICON_SIZES) images[size] = execute(iconDisplayList(gauge, size), size);
  return images;
}

function execute(ops: readonly DrawOp[], size: number): ImageData {
  const context = new OffscreenCanvas(size, size).getContext('2d');
  if (context === null) throw new Error('no 2d context');

  for (const op of ops) {
    context.save();
    context.fillStyle = op.colour;
    if (op.kind === 'path') {
      if (op.rotate !== null) {
        context.translate(op.rotate.x, op.rotate.y);
        context.rotate((op.rotate.degrees * Math.PI) / 180);
        context.translate(-op.rotate.x, -op.rotate.y);
      }
      context.fill(new Path2D(op.d));
    } else {
      if (op.clip !== null) context.clip(new Path2D(op.clip));
      context.fillRect(op.x, op.y, op.width, op.height);
    }
    context.restore();
  }

  return context.getImageData(0, 0, size, size);
}

async function paint(snapshot: unknown): Promise<void> {
  try {
    const gauge = gaugeFor(snapshot);
    const next = bucketFor(gauge);
    if (!needsRedraw(painted, next)) return;

    await chrome.action.setIcon({ imageData: render(gauge) });
    painted = next;
  } catch {
    // Swallowed on purpose. A snapshot shaped in a way this did not expect, or
    // a canvas the browser declined to give us, must not surface as an
    // unhandled rejection in the worker.
  }
}

/* ---- Wiring -------------------------------------------------------------- */

/** Subscribe to snapshot changes and keep the toolbar icon in step. */
export function initIcon(): void {
  // A fresh worker has no idea what is on the toolbar, so it may not suppress
  // the first draw.
  painted = null;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[KEYS.snapshot];
    if (change === undefined) return;
    void paint(change.newValue);
  });

  // The listener alone would leave a revived worker showing nothing until the
  // next poll, and on a first run there may be no poll for minutes — so paint
  // once from what is already stored. With nothing stored that draws the
  // unknown gauge, which is the honest answer.
  void readSnapshot()
    .then((snapshot) => paint(snapshot))
    .catch(() => paint(null));
}
