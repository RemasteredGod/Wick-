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
import { MARK_SIZES, rasterLayout } from '~/assets/mark';
import {
  ICON_SIZES,
  REDRAW_BUCKET_PERCENT,
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

const TRACK = '#332f2b';
const FLAME = '#e8a33d';
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
  return ops.find((op): op is FillRectOp => op.kind === 'rect');
}

function flameColourOf(ops: readonly DrawOp[]): string | undefined {
  return ops[0]?.colour;
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

  it('lights the flame whenever there is a reading, in the archive colour', () => {
    const ops = iconDisplayList({ remaining: 40, state: 'ok' }, 16);
    expect(flameColourOf(ops)).toBe(FLAME);
  });

  it('uses only the mirrored tokens', () => {
    const allowed = new Set([TRACK, FLAME, ACCENT, WARN, CRIT, DIM]);
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
    const { body } = rasterLayout(MARK_SIZES.hero, 48);
    const rect = rectOf(iconDisplayList({ remaining: 50, state: 'ok' }, 48));

    expect(rect?.y ?? 0).toBeGreaterThan(body.y);
    expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBe(body.y + body.height);
    expect(rect?.height).toBe(Math.round(body.height / 2));
    expect(rect?.clip).not.toBeNull();
  });

  it('fills the whole body at 100%', () => {
    const { body } = rasterLayout(MARK_SIZES.hero, 48);
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
    const { body } = rasterLayout(MARK_SIZES.hero, 16);
    const dash = rectOf(unknown);

    expect(dash).toBeDefined();
    expect(dash?.y ?? 0).toBeGreaterThan(body.y);
    // Not bottom-anchored: that is the whole point of it.
    expect((dash?.y ?? 0) + (dash?.height ?? 0)).toBeLessThan(body.y + body.height);
    expect(dash?.colour).toBe(DIM);
  });

  it('leaves the flame unlit', () => {
    expect(flameColourOf(unknown)).toBe(TRACK);
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
function installCanvasRecorder(): void {
  const context = {
    fillStyle: '',
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    fill: () => {},
    clip: () => {},
    fillRect: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ width, height }),
  };

  const globals = globalThis as { OffscreenCanvas?: unknown; Path2D?: unknown };
  globals.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return context;
    }
  };
  globals.Path2D = class {
    constructor(readonly d?: string) {}
  };
}

function removeCanvasRecorder(): void {
  const globals = globalThis as { OffscreenCanvas?: unknown; Path2D?: unknown };
  delete globals.OffscreenCanvas;
  delete globals.Path2D;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('initIcon', () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installChromeMock();
    installCanvasRecorder();
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
  }

  async function put(snapshot: unknown): Promise<void> {
    await chrome.storage.local.set({ [KEYS.snapshot]: snapshot });
    await flush();
  }

  it('subscribes once', () => {
    initIcon();
    expect(fake.storageListenerCount()).toBe(1);
  });

  it('paints on startup, so a revived worker is not left blank', async () => {
    fake.store.set(KEYS.snapshot, snapshotOf({ utilization: 30 }));
    initIcon();
    await flush();
    expect(fake.iconCalls).toHaveLength(1);
  });

  it('gives Chrome an image for every size it asks for', async () => {
    await start();
    await put(snapshotOf({ utilization: 30 }));

    const call = fake.iconCalls[0] as { imageData: Record<number, unknown> };
    expect(Object.keys(call.imageData).map(Number)).toEqual([...ICON_SIZES]);
  });

  it('suppresses a redraw inside the bucket and allows one across it', async () => {
    await start();

    await put(snapshotOf({ utilization: 30 })); // 70 remaining
    expect(fake.iconCalls).toHaveLength(1);

    await put(snapshotOf({ utilization: 32 })); // 68 remaining — same bucket
    expect(fake.iconCalls).toHaveLength(1);

    await put(snapshotOf({ utilization: 38 })); // 62 remaining — next bucket
    expect(fake.iconCalls).toHaveLength(2);
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

  it('does not throw when the canvas is unavailable', async () => {
    // A worker can be asked to draw before the browser will hand out a canvas.
    // The icon is not worth taking collection down for.
    removeCanvasRecorder();
    await start();
    await expect(put(snapshotOf({ utilization: 30 }))).resolves.toBeUndefined();
    expect(fake.iconCalls).toHaveLength(0);
  });
});
