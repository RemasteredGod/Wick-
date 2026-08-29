import identity from '../../brand/v3/geometry.json' with { type: 'json' };

/** The exact owner-approved v3 geometry, shared with the icon generator as inert JSON. */
export const MARK_IDENTITY = identity;

export type MarkSize = keyof typeof identity.componentFootprints;
export type MarkVariant = 'regular' | 'small';

/** Existing SVG layout boxes are retained so identity changes do not move popup/content UI. */
export const MARK_SIZES = identity.componentFootprints;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BodyRect extends Rect {
  radius: number;
}

export interface AffineTransform {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

export interface RasterMark {
  variant: MarkVariant;
  body: BodyRect;
  ember: {
    d: string;
    bounds: Rect;
    transform: AffineTransform;
    gradient: boolean;
  };
}

/** Canonical SVG path data. It is intentionally not reconstructed or rounded. */
export const EMBER_PATH = identity.regular.emberPath;

/** The canonical regular mark is the source for popup/content and every raster >=32px. */
export function layout() {
  return identity.regular;
}

/** Path data for a rounded rectangle, including the v3 capsule body. */
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

/** Bottom-anchored remaining-quota fill, clamped defensively to the body. */
export function fillRect(body: Rect, remaining: number): Rect {
  const fraction = Math.min(1, Math.max(0, remaining / 100));
  const height = body.height * fraction;
  return { x: body.x, y: body.y + body.height - height, width: body.width, height };
}

/**
 * Place the exact regular or approved small optical build into a square icon.
 * Only 16px selects the small build; Chrome's 32px and larger images use v3 regular.
 */
export function rasterLayout(boxSize: number): RasterMark {
  const variant: MarkVariant = boxSize < 18 ? 'small' : 'regular';
  const source = identity[variant];
  const scale = boxSize / source.viewBox.height;
  const centreX = boxSize / 2;
  const body = source.body;
  const bodyWidth = Math.round(body.width * scale);
  const bodyHeight = Math.round(body.height * scale);
  const baseTransform =
    variant === 'small'
      ? identity.small.emberTransform
      : { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };
  const emberScaleX = baseTransform.scaleX * scale;
  const canonicalEmberCentre =
    identity.regular.emberBounds.x + identity.regular.emberBounds.width / 2;
  const emberWidth = source.emberBounds.width * scale;

  return {
    variant,
    body: {
      x: centreX - bodyWidth / 2,
      y: boxSize - bodyHeight,
      width: bodyWidth,
      height: bodyHeight,
      radius: Math.min(body.radius * scale, bodyWidth / 2),
    },
    ember: {
      d: EMBER_PATH,
      bounds: {
        x: centreX - emberWidth / 2,
        y: source.emberBounds.y * scale,
        width: emberWidth,
        height: source.emberBounds.height * scale,
      },
      transform: {
        scaleX: emberScaleX,
        scaleY: baseTransform.scaleY * scale,
        translateX: centreX - canonicalEmberCentre * emberScaleX,
        translateY: baseTransform.translateY * scale,
      },
      gradient: variant === 'regular',
    },
  };
}

/** Quota remaining is governed by the most constrained known window. */
export function remainingFor(utilizations: readonly (number | null)[]): number | null {
  const known = utilizations.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value),
  );
  if (known.length === 0) return null;
  return Math.min(100, Math.max(0, 100 - Math.max(...known)));
}
