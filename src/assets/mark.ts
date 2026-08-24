/**
 * The Wick mark: a candle whose fill is the gauge.
 *
 * The design archive contains no SVG. The mark is built there from two `div`s
 * — a rotated square with three rounded corners for the flame, and a rounded
 * rectangle with a bottom-anchored inner fill for the body. This module is that
 * construction measured and re-expressed as vector geometry, so that the popup,
 * the injected sidebar card, and the toolbar renderer all draw the same shape
 * from one definition rather than three approximations of it.
 *
 * Provenance and exact measurements: docs/design.md.
 *
 * **The fill is remaining quota, not consumption.** The archive shows Session
 * 68% and Weekly 82% used with the mark at 18% — that is `100 − max(used)`, the
 * most constrained window. Bars fill as you spend; the wick burns down. Do not
 * "fix" this asymmetry, it is the whole idea.
 */

/** Dimensions of one rendering of the mark, in CSS pixels. */
export interface MarkGeometry {
  /** Body width. */
  bodyWidth: number;
  /** Body height. */
  bodyHeight: number;
  /** Body corner radius. */
  bodyRadius: number;
  /** Side length of the flame's square, before rotation. */
  flameSize: number;
  /** Vertical gap between flame and body. */
  gap: number;
}

/**
 * The two sizes the archive draws.
 *
 * They are not proportional to each other — 5×13 and 7×26 are different aspect
 * ratios — so they are recorded as measured rather than derived from one
 * another.
 */
export const MARK_SIZES = {
  /** Inline, beside the wordmark. */
  inline: { bodyWidth: 5, bodyHeight: 13, bodyRadius: 3, flameSize: 4, gap: 2 },
  /** Hero, and the basis for the toolbar icon. */
  hero: { bodyWidth: 7, bodyHeight: 26, bodyRadius: 4, flameSize: 5, gap: 3 },
} as const satisfies Record<string, MarkGeometry>;

/** Half the diagonal of a square, as a multiple of its side. */
const HALF_DIAGONAL = Math.SQRT2 / 2;

/**
 * The flame's rotation, in degrees.
 *
 * Straight from the archive's `transform: rotate(45deg)`. Note what this does:
 * the sharp corner is the bottom-left one (`border-radius: 50% 50% 50% 0`), and
 * rotating clockwise by 45 degrees turns it to face **left**, not up. At 4px
 * that reads as a soft blob and nobody notices. Scaled to a 48px toolbar icon
 * it will be conspicuous.
 *
 * Reproduced faithfully rather than corrected — redrawing the mark is not a
 * decision to make unilaterally. Flagged in docs/design.md.
 */
export const FLAME_ROTATION_DEGREES = 45;

/** The box a rendering occupies, including the flame's overflow past its own square. */
export interface MarkViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
  /** Serialised for an SVG `viewBox` attribute. */
  toString(): string;
}

/**
 * Where everything sits, for one geometry.
 *
 * Laid out top-down: flame box, gap, body. The flame's rotation does not affect
 * layout — CSS transforms never do — so it overflows its own square by
 * `(√2 − 1)/2` of a side on every edge, and the view box has to allow for that
 * or the corners clip.
 */
export function layout(geometry: MarkGeometry) {
  const { bodyWidth, bodyHeight, flameSize, gap } = geometry;

  const overflow = flameSize * (HALF_DIAGONAL - 0.5);
  const contentWidth = Math.max(bodyWidth, flameSize * Math.SQRT2);
  const centreX = contentWidth / 2;

  const flameTop = overflow;
  const flameCentreY = flameTop + flameSize / 2;
  const bodyTop = flameTop + flameSize + gap;

  const viewBox: MarkViewBox = {
    minX: 0,
    minY: 0,
    width: contentWidth,
    height: bodyTop + bodyHeight + overflow,
    toString() {
      return `${this.minX} ${this.minY} ${this.width} ${this.height}`;
    },
  };

  return {
    viewBox,
    centreX,
    flame: {
      x: centreX - flameSize / 2,
      y: flameTop,
      size: flameSize,
      centreX,
      centreY: flameCentreY,
    },
    body: {
      x: centreX - bodyWidth / 2,
      y: bodyTop,
      width: bodyWidth,
      height: bodyHeight,
      radius: geometry.bodyRadius,
    },
  };
}

/**
 * Path data for the flame, unrotated.
 *
 * `border-radius: 50% 50% 50% 0` on a square, with every radius at exactly half
 * the side, collapses into something simpler than it sounds: three quarter-arcs
 * of one circle inscribed in the square, plus a square corner where the fourth
 * would be. So — a three-quarter circle, then two straight edges to the point.
 *
 * Apply `FLAME_ROTATION_DEGREES` about the flame's centre to place it.
 */
export function flamePath(x: number, y: number, size: number): string {
  const r = size / 2;
  const left = x;
  const middleY = y + r;
  const bottom = y + size;
  const middleX = x + r;

  return [
    `M${left} ${middleY}`,
    // Three quarters of the inscribed circle, clockwise from the left edge over
    // the top and round to the bottom.
    `A${r} ${r} 0 1 1 ${middleX} ${bottom}`,
    // The corner the radius skipped.
    `L${left} ${bottom}`,
    'Z',
  ].join('');
}

/** Path data for the body: a plain rounded rectangle. */
export function bodyPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M${x + r} ${y}`,
    `H${x + width - r}`,
    `A${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V${y + height - r}`,
    `A${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H${x + r}`,
    `A${r} ${r} 0 0 1 ${x} ${y + height - r}`,
    `V${y + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join('');
}

/**
 * The filled portion of the body, for a given amount of quota remaining.
 *
 * Anchored to the bottom and clipped by the body, exactly as the archive's
 * `align-items: flex-end` inside an `overflow: hidden` box does it.
 *
 * @param remaining Percentage of quota left, 0–100. Values outside that range
 * are clamped rather than rejected: a provider reporting 103% consumed should
 * empty the gauge, not blank it.
 */
export function fillRect(
  body: { x: number; y: number; width: number; height: number },
  remaining: number,
) {
  const fraction = Math.min(1, Math.max(0, remaining / 100));
  const height = body.height * fraction;
  return { x: body.x, y: body.y + body.height - height, width: body.width, height };
}

/**
 * Quota remaining across every window, as the mark shows it.
 *
 * The gauge tracks the most constrained window, because that is the one that
 * will stop you. Returns `null` when nothing is known — the mark then renders
 * as an empty track rather than a full one, since a confident "you have plenty"
 * is the worst thing to be wrong about.
 */
export function remainingFor(utilizations: readonly (number | null)[]): number | null {
  const known = utilizations.filter((u): u is number => u !== null);
  if (known.length === 0) return null;
  return 100 - Math.max(...known);
}
