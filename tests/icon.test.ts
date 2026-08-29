/**
 * The toolbar gauge.
 *
 * The icon is split so that almost all of it is testable without a canvas:
 * `gaugeFor` reads a snapshot, `iconDisplayList` turns a reading into an
 * ordered list of fills, and `bucketFor`/`needsRedraw` decide whether any of it
 * is worth doing. Those are asserted directly here.
 *
 * The wiring — storage change to bucket to `chrome.action.setIcon` — is
 * exercised through `installChromeMock()` plus the recorder below.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rasterLayout } from '~/assets/mark';
import {
  ICON_SIZES,
  REDRAW_BUCKET_PERCENT,
  actionTitleFor,
  bucketFor,
  gaugeFor,
  iconDisplayList,
  initIcon,
  needsRedraw,
  type DrawOp,
  type FillRectOp,
  type Gauge,
} from '~/background/icon';
import { KEYS } from '~/background/store';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

/* ---- Fixtures ------------------------------------------------------------ */

const TILE = '#141312';
const TRACK_REGULAR = '#3f3c37';
const TRACK_SMALL = '#5f5b55';
const FLAME = '#e8a33d';
const FLAME_END = '#c96442';
const ACCENT = '#c96442';
const WARN = '#d99a2b';
const CRIT = '#d92b31';
const DIM = '#8a857d';

function snapshotOf(...windows: { utilization: number | null; status?: string }[]) {
  return {
    providerId: 'claude',
    fetchedAt: 1_787_000_000_000,
    source: 'usage',
    windows: windows.map((w, i) => ({
      key: `w${i}`,
      label: `Window ${i}`,
      shortLabel: `W${i}`,
      utilization: w.utilization,
      status: w.status ?? 'ok',
      resetsAt: null,
      active: true,
    })),
  };
}

function rectOf(ops: readonly DrawOp[]): FillRectOp | undefined {
  return ops.find((op): op is FillRectOp => op.kind === 'rect' && op.clip !== null);
}

function tileOf(ops: readonly DrawOp[]): FillRectOp | undefined {
  return ops.find((op): op is FillRectOp => op.kind === 'rect' && op.clip === null);
}

function flameColourOf(ops: readonly DrawOp[]): string | undefined {
  return ops.find((op) => op.kind === 'path')?.colour;
}

/* ---- Reading the snapshot ------------------------------------------------ */

describe('gaugeFor', () => {
  it('reads remaining from the most constrained window', () => {
    // The archive's own numbers: session 68, weekly 82, mark at 18%.
    expect(gaugeFor(snapshotOf({ utilization: 68 }, { utilization: 82 }))).toEqual({
      remaining: 18,
      state: 'warn',
    });
  });

  it('takes the worst state, which need not be the busiest window', () => {
    // A window bound at 40% outranks a comfortable one at 85%.
    const gauge = gaugeFor(
      snapshotOf({ utilization: 40, status: 'exceeded' }, { utilization: 15 }),
    );
    expect(gauge.state).toBe('crit');
    expect(gauge.remaining).toBe(60);
  });

  it('treats an exceeded window at 98% as crit, not nearly-crit', () => {
    // Status wins over the number. 98% next to a composer that will not send
    // makes the extension look broken.
    expect(gaugeFor(snapshotOf({ utilization: 98, status: 'exceeded' })).state).toBe('crit');
  });

  it('lets an approaching flag outrank a comfortable number', () => {
    expect(gaugeFor(snapshotOf({ utilization: 20, status: 'approaching' })).state).toBe('warn');
  });

  it('reports unknown when no window carries a number', () => {
    expect(gaugeFor(snapshotOf({ utilization: null }, { utilization: null }))).toEqual({
      remaining: null,
      state: 'unknown',
    });
  });

  it('keeps the alarm when a window is blocked with no number at all', () => {
    const gauge = gaugeFor(snapshotOf({ utilization: null, status: 'exceeded' }));
    expect(gauge).toEqual({ remaining: null, state: 'crit' });
  });

  it.each([
    ['nothing stored', null],
    ['a primitive', 42],
    ['an empty object', {}],
    ['windows that are not an array', { providerId: 'claude', windows: 'soon' }],
    ['a window that is not an object', { windows: [null, 'x', 7] }],
    ['a utilization that is a string', { windows: [{ utilization: '62', status: 'ok' }] }],
    ['a utilization that is NaN', { windows: [{ utilization: NaN }] }],
    ['a status nobody has seen before', { windows: [{ utilization: 10, status: 'melting' }] }],
  ])('survives %s', (_label, value) => {
    expect(() => gaugeFor(value)).not.toThrow();
    const gauge = gaugeFor(value);
    expect(gauge.remaining === null || typeof gauge.remaining === 'number').toBe(true);
  });

  it('reports unknown rather than zero for a shape it cannot read', () => {
    // "Unknown, not zero" — a confident wrong number is worse than a gap.
    expect(gaugeFor({ windows: [{ utilization: '62' }] })).toEqual({
      remaining: null,
      state: 'unknown',
    });
  });
});

/* ---- Accessible action title -------------------------------------------- */

describe('actionTitleFor', () => {
  it('describes a genuinely unknown reading without inventing zero or full', () => {
    expect(actionTitleFor({ remaining: null, state: 'unknown' })).toBe('Wick — usage unknown');
  });

  it('retains a known critical status when remaining is unavailable', () => {
    expect(actionTitleFor({ remaining: null, state: 'crit' })).toBe(
      'Wick — remaining unknown, critical',
    );
  });

  it.each([
    [{ remaining: 70, state: 'ok' }, 'Wick — 70% remaining, normal'],
    [{ remaining: 18, state: 'warn' }, 'Wick — 18% remaining, warning'],
    [{ remaining: 2, state: 'crit' }, 'Wick — 2% remaining, critical'],
  ] as const)('describes known remaining and status', (gauge, expected) => {
    expect(actionTitleFor(gauge)).toBe(expected);
  });
});

/* ---- Colour -------------------------------------------------------------- */

describe('iconDisplayList — colour', () => {
  it.each([
    [30, 'ok', ACCENT],
    [69, 'ok', ACCENT],
    [70, 'warn', WARN],
    [82, 'warn', WARN],
    [95, 'crit', CRIT],
  ])('draws %i%% used as %s', (used, _state, colour) => {
    const gauge = gaugeFor(snapshotOf({ utilization: used }));
    expect(rectOf(iconDisplayList(gauge, 16))?.colour).toBe(colour);
  });

  it('draws an exceeded window at 98% in crit', () => {
    const gauge = gaugeFor(snapshotOf({ utilization: 98, status: 'exceeded' }));
    expect(rectOf(iconDisplayList(gauge, 16))?.colour).toBe(CRIT);
  });

  it('draws an exceeded window in crit even with plenty of number left', () => {
    const gauge = gaugeFor(snapshotOf({ utilization: 40, status: 'exceeded' }));
    const rect = rectOf(iconDisplayList(gauge, 48));
    expect(rect?.colour).toBe(CRIT);
    // ...and still shows 60% left. The colour is the alarm, not the height.
    expect(rect?.height).toBeGreaterThan(0);
  });

  it('uses a solid ember and small optical track at 16px', () => {
    const ops = iconDisplayList({ remaining: 40, state: 'ok' }, 16);
    const [ember, track] = ops.filter((op) => op.kind === 'path');
    expect(ember?.colour).toBe(FLAME);
    expect(ember?.gradient).toBeNull();
    expect(track?.colour).toBe(TRACK_SMALL);
  });

  it('uses the exact ember gradient and regular track at 32px and above', () => {
    for (const size of [32, 48]) {
      const ops = iconDisplayList({ remaining: 40, state: 'ok' }, size);
      const [ember, track] = ops.filter((op) => op.kind === 'path');
      expect(ember).toBeDefined();
      expect(ember?.gradient).not.toBeNull();
      if (ember === undefined || ember.gradient === null) throw new Error('missing ember gradient');
      expect(ember.gradient).toMatchObject({ start: FLAME, end: FLAME_END });
      expect(ember.gradient.x2).toBeCloseTo(
        ember.gradient.x1 + rasterLayout(size).ember.bounds.width * 0.45,
      );
      expect(track?.colour).toBe(TRACK_REGULAR);
    }
  });

  it('draws an opaque dark tile behind every runtime size', () => {
    for (const size of ICON_SIZES) {
      expect(tileOf(iconDisplayList({ remaining: null, state: 'unknown' }, size))).toMatchObject({
        x: 0,
        y: 0,
        width: size,
        height: size,
        colour: TILE,
      });
    }
  });

  it('uses only the reviewed mirrored tokens', () => {
    const allowed = new Set([
      TILE,
      TRACK_REGULAR,
      TRACK_SMALL,
      FLAME,
      FLAME_END,
      ACCENT,
      WARN,
      CRIT,
      DIM,
    ]);
    const gauges: Gauge[] = [
      { remaining: null, state: 'unknown' },
      { remaining: null, state: 'crit' },
      { remaining: 0, state: 'crit' },
      { remaining: 50, state: 'warn' },
      { remaining: 100, state: 'ok' },
    ];
    for (const gauge of gauges) {
      for (const size of ICON_SIZES) {
        for (const op of iconDisplayList(gauge, size)) expect(allowed).toContain(op.colour);
      }
    }
  });
});

/* ---- Geometry of the drawn gauge ----------------------------------------- */

describe('iconDisplayList — the gauge', () => {
  it('anchors the fill to the bottom of the body and clips it to the body', () => {
    const { body } = rasterLayout(48);
    const rect = rectOf(iconDisplayList({ remaining: 50, state: 'ok' }, 48));

    expect(rect?.y ?? 0).toBeGreaterThan(body.y);
    expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBe(body.y + body.height);
    expect(rect?.height).toBe(Math.round(body.height / 2));
    expect(rect?.clip).not.toBeNull();
  });

  it('fills the whole body at 100%', () => {
    const { body } = rasterLayout(48);
    const rect = rectOf(iconDisplayList({ remaining: 100, state: 'ok' }, 48));
    expect(rect?.y).toBe(body.y);
    expect(rect?.height).toBe(body.height);
  });

  it('draws nothing inside the body at 0%', () => {
    const ops = iconDisplayList({ remaining: 0, state: 'crit' }, 16);
    expect(rectOf(ops)).toBeUndefined();
  });

  it('keeps a sliver visible rather than rounding it away', () => {
    // At 16px the body is 12 pixels for 100 points, so 2% would round to
    // nothing — and "almost none left" is not the same claim as "none left".
    const rect = rectOf(iconDisplayList({ remaining: 2, state: 'crit' }, 16));
    expect(rect?.height).toBe(1);
  });

  it('grows with remaining at every size', () => {
    for (const size of ICON_SIZES) {
      const heights = [10, 40, 90].map(
        (remaining) => rectOf(iconDisplayList({ remaining, state: 'ok' }, size))?.height ?? 0,
      );
      expect([...heights].sort((a, b) => a - b)).toEqual(heights);
    }
  });
});

/* ---- The unknown state --------------------------------------------------- */

describe('iconDisplayList — unknown', () => {
  const unknown = iconDisplayList({ remaining: null, state: 'unknown' }, 16);
  const full = iconDisplayList({ remaining: 100, state: 'ok' }, 16);
  const empty = iconDisplayList({ remaining: 0, state: 'crit' }, 16);

  it('looks like neither a full gauge nor an empty one', () => {
    expect(unknown).not.toEqual(full);
    expect(unknown).not.toEqual(empty);
  });

  it('floats its mark at mid-height, where a level could never be', () => {
    const { body } = rasterLayout(16);
    const dash = rectOf(unknown);

    expect(dash).toBeDefined();
    expect(dash?.y ?? 0).toBeGreaterThan(body.y);
    // Not bottom-anchored: that is the whole point of it.
    expect((dash?.y ?? 0) + (dash?.height ?? 0)).toBeLessThan(body.y + body.height);
    expect(dash?.colour).toBe(DIM);
  });

  it('leaves the flame unlit', () => {
    expect(flameColourOf(unknown)).toBe(TRACK_SMALL);
    expect(flameColourOf(full)).toBe(FLAME);
    expect(flameColourOf(empty)).toBe(FLAME);
  });

  it('keeps a dash at every size', () => {
    for (const size of ICON_SIZES) {
      const dash = rectOf(iconDisplayList({ remaining: null, state: 'unknown' }, size));
      expect(dash?.height ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it('colours the dash by state when the provider says blocked but not how much', () => {
    const ops = iconDisplayList({ remaining: null, state: 'crit' }, 16);
    expect(rectOf(ops)?.colour).toBe(CRIT);
    expect(ops).not.toEqual(unknown);
  });
});

/* ---- Bucketing ----------------------------------------------------------- */

describe('bucketing', () => {
  const at = (remaining: number | null, state: Gauge['state'] = 'ok') =>
    bucketFor({ remaining, state });

  it('always draws when nothing has been drawn yet', () => {
    expect(needsRedraw(null, at(70))).toBe(true);
  });

  it('suppresses a change smaller than a bucket', () => {
    expect(needsRedraw(at(70), at(68))).toBe(false);
    expect(needsRedraw(at(70), at(70))).toBe(false);
  });

  it('draws across a bucket boundary', () => {
    expect(needsRedraw(at(70), at(62))).toBe(true);
    expect(Math.abs(70 - 62)).toBeGreaterThan(REDRAW_BUCKET_PERCENT);
  });

  it('draws on a colour change at an identical percentage', () => {
    expect(needsRedraw(at(38, 'ok'), at(38, 'crit'))).toBe(true);
  });

  it('draws when a reading appears or disappears', () => {
    expect(needsRedraw(at(null, 'unknown'), at(90))).toBe(true);
    expect(needsRedraw(at(90), at(null, 'unknown'))).toBe(true);
  });
});

/* ---- Wiring -------------------------------------------------------------- */

/**
 * A recorder standing in for `OffscreenCanvas`.
 *
 * Not a canvas and not a polyfill: it rasterises nothing and returns no pixels.
 * It exists only so the path from a storage change to `chrome.action.setIcon`
 * can be walked end to end. What gets drawn is asserted against the display
 * list above, which is exactly why the display list is a value.
 */
interface CanvasRecording {
  sizes: number[];
  transforms: number[][];
  gradients: Array<{ coordinates: number[]; stops: Array<[number, string]> }>;
  fills: string[];
  clips: string[];
  rects: number[][];
}

function installCanvasRecorder(): CanvasRecording {
  const recording: CanvasRecording = {
    sizes: [],
    transforms: [],
    gradients: [],
    fills: [],
    clips: [],
    rects: [],
  };

  const globals = globalThis as { OffscreenCanvas?: unknown; Path2D?: unknown };
  globals.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      recording.sizes.push(width);
      expect(height).toBe(width);
    }
    getContext() {
      return {
        fillStyle: '' as string | object,
        save: () => {},
        restore: () => {},
        transform: (...values: number[]) => recording.transforms.push(values),
        createLinearGradient: (...coordinates: number[]) => {
          const gradient = { coordinates, stops: [] as Array<[number, string]> };
          recording.gradients.push(gradient);
          return {
            addColorStop: (offset: number, colour: string) => gradient.stops.push([offset, colour]),
          };
        },
        fill: (path: { d?: string }) => recording.fills.push(path.d ?? ''),
        clip: (path: { d?: string }) => recording.clips.push(path.d ?? ''),
        fillRect: (...values: number[]) => recording.rects.push(values),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({ width, height }),
      };
    }
  };
  globals.Path2D = class {
    constructor(readonly d?: string) {}
  };
  return recording;
}

function removeCanvasRecorder(): void {
  const globals = globalThis as { OffscreenCanvas?: unknown; Path2D?: unknown };
  delete globals.OffscreenCanvas;
  delete globals.Path2D;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('initIcon', () => {
  let fake: FakeChrome;
  let canvas: CanvasRecording;

  beforeEach(() => {
    fake = installChromeMock();
    canvas = installCanvasRecorder();
  });

  afterEach(() => {
    uninstallChromeMock();
    removeCanvasRecorder();
  });

  /** Start the renderer and discard the startup paint, which is not under test. */
  async function start(): Promise<void> {
    initIcon();
    await flush();
    fake.iconCalls.length = 0;
    fake.titleCalls.length = 0;
    canvas.sizes.length = 0;
    canvas.transforms.length = 0;
    canvas.gradients.length = 0;
    canvas.fills.length = 0;
    canvas.clips.length = 0;
    canvas.rects.length = 0;
  }

  async function put(snapshot: unknown): Promise<void> {
    await chrome.storage.local.set({ [KEYS.snapshot]: snapshot });
    await flush();
  }

  it('subscribes once', () => {
    initIcon();
    expect(fake.storageListenerCount()).toBe(1);
  });

  it('sets an honest unknown title on an empty startup paint', async () => {
    initIcon();
    await flush();
    expect(fake.iconCalls).toHaveLength(1);
    expect(fake.titleCalls).toEqual([{ title: 'Wick — usage unknown' }]);
  });

  it('paints on startup, so a revived worker is not left blank', async () => {
    fake.store.set(KEYS.snapshot, snapshotOf({ utilization: 30 }));
    initIcon();
    await flush();
    expect(fake.iconCalls).toHaveLength(1);
    expect(fake.titleCalls).toEqual([{ title: 'Wick — 70% remaining, normal' }]);
  });

  it('walks production canvas APIs for dynamic 16/32/48 paint and updates its title', async () => {
    await start();
    await put(snapshotOf({ utilization: 82 }));

    expect(canvas.sizes).toEqual([16, 32, 48]);
    expect(canvas.gradients).toHaveLength(2);
    expect(canvas.gradients.map((gradient) => gradient.stops)).toEqual([
      [[0, FLAME], [1, FLAME_END]],
      [[0, FLAME], [1, FLAME_END]],
    ]);
    expect(canvas.transforms).toHaveLength(3);
    expect(canvas.fills.filter((path) => path === rasterLayout(16).ember.d)).toHaveLength(3);
    expect(canvas.clips).toHaveLength(3);
    expect(canvas.rects.length).toBeGreaterThan(ICON_SIZES.length);
    expect(fake.titleCalls).toEqual([{ title: 'Wick — 18% remaining, warning' }]);
    expect(fake.titleCalls).toHaveLength(fake.iconCalls.length);
  });

  it('gives Chrome an image for every size it asks for', async () => {
    await start();
    await put(snapshotOf({ utilization: 30 }));

    const call = fake.iconCalls[0] as { imageData: Record<number, unknown> };
    expect(Object.keys(call.imageData).map(Number)).toEqual([...ICON_SIZES]);
  });

  it('updates an exact title inside the icon bucket and redraws only across buckets', async () => {
    await start();

    await put(snapshotOf({ utilization: 30 })); // 70 remaining
    expect(fake.iconCalls).toHaveLength(1);

    await put(snapshotOf({ utilization: 32 })); // 68 remaining — same bucket
    expect(fake.iconCalls).toHaveLength(1);

    await put(snapshotOf({ utilization: 38 })); // 62 remaining — next bucket
    expect(fake.iconCalls).toHaveLength(2);
    expect(fake.titleCalls).toEqual([
      { title: 'Wick — 70% remaining, normal' },
      { title: 'Wick — 68% remaining, normal' },
      { title: 'Wick — 62% remaining, normal' },
    ]);
  });

  it('suppresses duplicate exact titles independently of redraws', async () => {
    await start();

    const snapshot = snapshotOf({ utilization: 30 });
    await put(snapshot);
    await put(snapshot);

    expect(fake.iconCalls).toHaveLength(1);
    expect(fake.titleCalls).toEqual([{ title: 'Wick — 70% remaining, normal' }]);
  });

  it('keeps known, status-only, and unknown transitions truthful', async () => {
    await start();

    await put(snapshotOf({ utilization: 30 }));
    await put(snapshotOf({ utilization: null, status: 'exceeded' }));
    await put(snapshotOf({ utilization: null }));

    expect(fake.titleCalls).toEqual([
      { title: 'Wick — 70% remaining, normal' },
      { title: 'Wick — remaining unknown, critical' },
      { title: 'Wick — usage unknown' },
    ]);
  });

  it('redraws on a colour change at an identical percentage', async () => {
    await start();

    await put(snapshotOf({ utilization: 62 }));
    expect(fake.iconCalls).toHaveLength(1);

    await put(snapshotOf({ utilization: 62, status: 'exceeded' }));
    expect(fake.iconCalls).toHaveLength(2);
  });

  it('ignores writes to other keys', async () => {
    await start();
    await chrome.storage.local.set({ [KEYS.history]: [] });
    await flush();
    expect(fake.iconCalls).toHaveLength(0);
  });

  it('does not throw into the worker on a malformed snapshot', async () => {
    await start();
    for (const value of [null, 42, 'soon', {}, { windows: 'soon' }, { windows: [null] }]) {
      await expect(put(value)).resolves.toBeUndefined();
    }
  });

  it('still updates the exact title when the canvas is unavailable', async () => {
    // Title truth must not depend on the browser accepting an icon canvas.
    removeCanvasRecorder();
    await start();
    await expect(put(snapshotOf({ utilization: 30 }))).resolves.toBeUndefined();
    expect(fake.iconCalls).toHaveLength(0);
    expect(fake.titleCalls).toEqual([{ title: 'Wick — 70% remaining, normal' }]);
  });
});
