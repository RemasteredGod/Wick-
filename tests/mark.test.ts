/**
 * The mark's geometry.
 *
 * Everything here is pure arithmetic over `src/assets/mark.ts`. The popup, the
 * injected card and the toolbar icon all draw from these functions, so a change
 * that passes here is a change that is safe on three surfaces at once — and a
 * change that fails here has moved the design.
 */

import { describe, expect, it } from 'vitest';
import {
  FLAME_ROTATION_DEGREES,
  MARK_SIZES,
  MIN_BODY_DEVICE_PIXELS,
  bodyPath,
  fillRect,
  flamePath,
  layout,
  rasterLayout,
  remainingFor,
} from '~/assets/mark';

const SIZES = Object.entries(MARK_SIZES);
const HALF_DIAGONAL = Math.SQRT2 / 2;

/** Numbers only, and no NaN pretending to be one. */
const PATH_GRAMMAR = /^M[MAHVLZ0-9 .-]*Z$/;

describe('layout', () => {
  it.each(SIZES)('gives %s a view box that fits the rotated flame', (_name, geometry) => {
    const { viewBox, flame } = layout(geometry);

    // The flame is a square rotated 45 degrees about its own centre, so its
    // silhouette is its diagonal — it overflows the square it was laid out in
    // on every edge. If the view box only allowed for the square, the popup
    // would clip the corners.
    const reach = flame.size * HALF_DIAGONAL;
    expect(flame.centreY - reach).toBeGreaterThanOrEqual(viewBox.minY - 1e-9);
    expect(flame.centreX - reach).toBeGreaterThanOrEqual(viewBox.minX - 1e-9);
    expect(flame.centreX + reach).toBeLessThanOrEqual(viewBox.minX + viewBox.width + 1e-9);
    expect(viewBox.width).toBeGreaterThanOrEqual(flame.size * Math.SQRT2);
  });

  it.each(SIZES)('keeps %s body inside the view box, below the flame', (_name, geometry) => {
    const { viewBox, body, flame } = layout(geometry);

    expect(body.y).toBeGreaterThanOrEqual(flame.y + flame.size + geometry.gap - 1e-9);
    expect(body.x).toBeGreaterThanOrEqual(0);
    expect(body.x + body.width).toBeLessThanOrEqual(viewBox.width + 1e-9);
    expect(body.y + body.height).toBeLessThanOrEqual(viewBox.height + 1e-9);
  });

  it('centres the flame on the body', () => {
    const { body, flame } = layout(MARK_SIZES.hero);
    expect(flame.centreX).toBeCloseTo(body.x + body.width / 2, 10);
  });

  it('serialises a view box an SVG attribute can take', () => {
    expect(layout(MARK_SIZES.inline).viewBox.toString()).toMatch(
      /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/,
    );
  });
});

describe('fillRect', () => {
  const body = { x: 2, y: 10, width: 7, height: 26 };
  const bottom = body.y + body.height;

  it('anchors to the bottom of the body', () => {
    const fill = fillRect(body, 40);
    expect(fill.y + fill.height).toBeCloseTo(bottom, 10);
    expect(fill.height).toBeCloseTo(26 * 0.4, 10);
    expect(fill.x).toBe(body.x);
    expect(fill.width).toBe(body.width);
  });

  it('fills the body exactly at 100', () => {
    expect(fillRect(body, 100)).toEqual({ ...body });
  });

  it('draws nothing at 0, still anchored', () => {
    const fill = fillRect(body, 0);
    expect(fill.height).toBe(0);
    expect(fill.y).toBe(bottom);
  });

  it('clamps above 100 rather than overflowing the body', () => {
    // A provider reporting 103% consumed must empty the gauge, not invert it.
    expect(fillRect(body, 140)).toEqual(fillRect(body, 100));
  });

  it('clamps below 0', () => {
    expect(fillRect(body, -25)).toEqual(fillRect(body, 0));
  });

  it('grows monotonically with remaining', () => {
    const heights = [0, 10, 25, 50, 75, 100].map((r) => fillRect(body, r).height);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
  });
});

describe('remainingFor', () => {
  it('tracks the most constrained window, because that is the one that stops you', () => {
    expect(remainingFor([68, 82])).toBe(18);
  });

  it('reproduces the archive: session 68, weekly 82, mark at 18%', () => {
    // docs/design.md, "The mark". The fill is remaining, not consumption.
    expect(remainingFor([68, 82])).toBe(18);
  });

  it('ignores windows the provider did not report', () => {
    expect(remainingFor([null, 30, null])).toBe(70);
  });

  it('returns null when nothing at all is known', () => {
    expect(remainingFor([null, null])).toBeNull();
    expect(remainingFor([])).toBeNull();
  });

  it('goes to zero, not negative, at exhaustion', () => {
    expect(remainingFor([100])).toBe(0);
  });
});

describe('path data', () => {
  it('is deterministic', () => {
    expect(bodyPath(1, 2, 7, 26, 4)).toBe(bodyPath(1, 2, 7, 26, 4));
    expect(flamePath(0, 0, 5)).toBe(flamePath(0, 0, 5));
  });

  it.each(SIZES)('is well-formed for %s', (_name, geometry) => {
    const { body, flame } = layout(geometry);
    for (const d of [
      bodyPath(body.x, body.y, body.width, body.height, body.radius),
      flamePath(flame.x, flame.y, flame.size),
    ]) {
      expect(d).toMatch(PATH_GRAMMAR);
      expect(d).not.toContain('NaN');
      expect(d).not.toContain('Infinity');
    }
  });

  it('clamps the body radius so an over-large value cannot invert the path', () => {
    // The archive's radii exceed half the width at both sizes, which is what
    // makes the body a capsule. A radius larger still must not change it.
    expect(bodyPath(0, 0, 7, 26, 4)).toBe(bodyPath(0, 0, 7, 26, 3.5));
    expect(bodyPath(0, 0, 7, 26, 99)).toBe(bodyPath(0, 0, 7, 26, 3.5));
  });

  it('closes the flame with the one square corner the archive gives it', () => {
    // 50% 50% 50% 0 — three quarter-arcs of the inscribed circle, then a
    // straight run into the corner the radius skipped.
    const d = flamePath(0, 0, 5);
    expect(d).toContain('A2.5 2.5 0 1 1');
    expect(d).toContain('L0 5');
  });
});

describe('the flame orientation', () => {
  it('is still the archive rotation', () => {
    // 45 degrees clockwise on a square whose sharp corner is bottom-left puts
    // that corner to the LEFT, not up — see docs/decisions/0004-mark-at-16px.md.
    // Faithful to the archive and flagged there for the owner. This test exists
    // so correcting it is a deliberate act rather than a drive-by.
    expect(FLAME_ROTATION_DEGREES).toBe(45);
  });
});

describe('rasterLayout — the 16px decision', () => {
  it('snaps the body to whole pixels at every size', () => {
    for (const size of [16, 32, 48]) {
      const { body } = rasterLayout(MARK_SIZES.hero, size);
      expect(Number.isInteger(body.x)).toBe(true);
      expect(Number.isInteger(body.y)).toBe(true);
      expect(Number.isInteger(body.width)).toBe(true);
      expect(Number.isInteger(body.height)).toBe(true);
    }
  });

  it('widens the body to the minimum at 16px, where the faithful width is 3.1', () => {
    const { body, scale } = rasterLayout(MARK_SIZES.hero, 16);
    expect(MARK_SIZES.hero.bodyWidth * scale).toBeLessThan(MIN_BODY_DEVICE_PIXELS);
    expect(body.width).toBe(MIN_BODY_DEVICE_PIXELS);
  });

  it('leaves 32 and 48 alone — the floor binds at 16px only', () => {
    for (const size of [32, 48]) {
      const { body, scale } = rasterLayout(MARK_SIZES.hero, size);
      expect(body.width).toBe(Math.round(MARK_SIZES.hero.bodyWidth * scale));
      expect(body.width).toBeGreaterThan(MIN_BODY_DEVICE_PIXELS);
    }
  });

  it('keeps the flame at every size, blob or not', () => {
    // Decision 0004: dropping it below some size was weighed and rejected.
    for (const size of [16, 32, 48]) {
      expect(rasterLayout(MARK_SIZES.hero, size).flame.size).toBeGreaterThan(0);
    }
  });

  it('fits the whole mark inside the square box, flush, with no margin', () => {
    for (const size of [16, 32, 48]) {
      const { body, flame } = rasterLayout(MARK_SIZES.hero, size);
      const reach = flame.size * HALF_DIAGONAL;

      expect(flame.centreY - reach).toBeGreaterThanOrEqual(-1e-9);
      expect(body.x).toBeGreaterThanOrEqual(0);
      expect(body.x + body.width).toBeLessThanOrEqual(size);
      expect(body.y + body.height).toBeLessThanOrEqual(size);
      // Flush: the mark reaches the bottom edge, give or take the rounding that
      // put it on the pixel grid.
      expect(body.y + body.height).toBeGreaterThanOrEqual(size - 1);
    }
  });

  it('centres the flame over the snapped body, not over the unsnapped one', () => {
    for (const size of [16, 32, 48]) {
      const { body, flame } = rasterLayout(MARK_SIZES.hero, size);
      expect(flame.centreX).toBeCloseTo(body.x + body.width / 2, 10);
    }
  });

  it('scales the body height with the box', () => {
    const small = rasterLayout(MARK_SIZES.hero, 16).body.height;
    const large = rasterLayout(MARK_SIZES.hero, 48).body.height;
    expect(large).toBeGreaterThan(small * 2.5);
  });
});
