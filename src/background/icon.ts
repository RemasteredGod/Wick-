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
 * pure half. The thin canvas walk is exercised with API recorders for every
 * runtime size; pixel rasterisation itself remains the browser's job.
 *
 * Nothing in this module may throw into the service worker. A toolbar icon is
 * not worth taking collection down for.
 */

import {
  MARK_IDENTITY,
  bodyPath,
  fillRect,
  rasterLayout,
  remainingFor,
  type AffineTransform,
} from '~/assets/mark';
import { field, thresholdState } from '~/core/normalise';
import type { LimitStatus, ThresholdState } from '~/core/types';
import { KEYS, readSnapshot } from './store';

/** Icon sizes Chrome asks for. */
export const ICON_SIZES = [16, 32, 48] as const;

/** Utilization is bucketed to this granularity before deciding to redraw. */
export const REDRAW_BUCKET_PERCENT = 5;

/**
 * Neutral brand identity values (tile, two tracks, and two ember endpoints)
 * come from `brand/v3/geometry.json`. Four UI status values are mirrored from
 * `src/styles/tokens.css`, because a service worker has no document and cannot
 * read CSS custom properties. If one of those UI tokens changes there, change
 * its literal here in the same commit.
 */
const COLOURS = {
  /** `--wick-mark-tile` — the opaque icon tile. */
  tile: MARK_IDENTITY.colours.tile,
  /** Dedicated regular and <=18px optical-build tracks. */
  trackRegular: MARK_IDENTITY.colours.trackRegular,
  trackSmall: MARK_IDENTITY.colours.trackSmall,
  /** Exact canonical ember gradient endpoints; the small build uses start solid. */
  emberStart: MARK_IDENTITY.gradient.start,
  emberEnd: MARK_IDENTITY.gradient.end,
  /** Existing quota-state colours. */
  accent: '#c96442',
  warn: '#d99a2b',
  crit: '#d92b31',
  /** `--wick-text-dim` — the no-reading dash. */
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

/** Accessible toolbar text matching the state painted into the icon. */
export function actionTitleFor(gauge: Gauge): string {
  if (gauge.remaining === null) {
    return gauge.state === 'unknown'
      ? 'Wick — usage unknown'
      : `Wick — remaining unknown, ${stateLabel(gauge.state)}`;
  }

  return `Wick — ${String(Math.round(gauge.remaining))}% remaining, ${stateLabel(gauge.state)}`;
}

function stateLabel(state: ThresholdState): string {
  switch (state) {
    case 'ok':
      return 'normal';
    case 'warn':
      return 'warning';
    case 'crit':
      return 'critical';
    case 'unknown':
      return 'status unknown';
  }
}


export interface LinearGradientFill {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  start: string;
  end: string;
}

/** Fill a path, optionally transformed from canonical v3 coordinates. */
export interface FillPathOp {
  kind: 'path';
  /** Exact canonical SVG path data. */
  d: string;
  colour: string;
  transform: AffineTransform | null;
  gradient: LinearGradientFill | null;
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
  const { variant, body, ember } = rasterLayout(size);
  const trackPath = bodyPath(body.x, body.y, body.width, body.height, body.radius);
  const trackColour = variant === 'small' ? COLOURS.trackSmall : COLOURS.trackRegular;
  const lit = gauge.remaining !== null;
  const gradient =
    lit && ember.gradient
      ? {
          x1: ember.bounds.x + ember.bounds.width * MARK_IDENTITY.gradient.x1,
          y1: ember.bounds.y + ember.bounds.height * MARK_IDENTITY.gradient.y1,
          x2: ember.bounds.x + ember.bounds.width * MARK_IDENTITY.gradient.x2,
          y2: ember.bounds.y + ember.bounds.height * MARK_IDENTITY.gradient.y2,
          start: COLOURS.emberStart,
          end: COLOURS.emberEnd,
        }
      : null;

  const ops: DrawOp[] = [
    {
      kind: 'rect',
      x: 0,
      y: 0,
      width: size,
      height: size,
      colour: COLOURS.tile,
      clip: null,
    },
    {
      kind: 'path',
      d: ember.d,
      colour: lit ? COLOURS.emberStart : trackColour,
      transform: ember.transform,
      gradient,
    },
    {
      kind: 'path',
      d: trackPath,
      colour: trackColour,
      transform: null,
      gradient: null,
    },
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
      clip: trackPath,
    });
    return ops;
  }

  const fill = fillRect(body, gauge.remaining);
  if (fill.height <= 0) return ops;

  // A positive remainder must survive integer rasterisation at every size.
  const height = Math.max(1, Math.round(fill.height));
  ops.push({
    kind: 'rect',
    x: body.x,
    y: body.y + body.height - height,
    width: body.width,
    height,
    colour: fillColour(gauge.state),
    clip: trackPath,
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

/** Exact accessible title last requested from Chrome, independent of pixels. */
let titled: string | null = null;

/* ---- Drawing ------------------------------------------------------------- */

/**
 * Render every size Chrome asks for.
 *
 * The production `OffscreenCanvas`, `CanvasGradient`, transform, path, clip and
 * rectangle calls are exercised by recorders in `tests/icon.test.ts`; Chrome
 * remains responsible for actual pixel rasterisation.
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
    if (op.kind === 'path' && op.gradient !== null) {
      const gradient = context.createLinearGradient(
        op.gradient.x1,
        op.gradient.y1,
        op.gradient.x2,
        op.gradient.y2,
      );
      gradient.addColorStop(0, op.gradient.start);
      gradient.addColorStop(1, op.gradient.end);
      context.fillStyle = gradient;
    } else {
      context.fillStyle = op.colour;
    }

    if (op.kind === 'path') {
      if (op.transform !== null) {
        context.transform(
          op.transform.scaleX,
          0,
          0,
          op.transform.scaleY,
          op.transform.translateX,
          op.transform.translateY,
        );
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
    const redraw = needsRedraw(painted, next);
    const title = actionTitleFor(gauge);
    const retitle = title !== titled;
    if (!redraw && !retitle) return;

    const updates: Promise<void>[] = [];

    if (redraw) {
      try {
        const imageData = render(gauge);
        updates.push(
          chrome.action.setIcon({ imageData }).then(() => {
            painted = next;
          }),
        );
      } catch {
        // Title truth must not depend on canvas availability.
      }
    }

    if (retitle) {
      const previousTitle = titled;
      // Claim before awaiting so duplicate snapshots do not queue duplicate API calls.
      titled = title;
      try {
        updates.push(
          chrome.action.setTitle({ title }).catch(() => {
            if (titled === title) titled = previousTitle;
          }),
        );
      } catch {
        if (titled === title) titled = previousTitle;
      }
    }

    await Promise.allSettled(updates);
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
  // the first icon or exact title update.
  painted = null;
  titled = null;

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
