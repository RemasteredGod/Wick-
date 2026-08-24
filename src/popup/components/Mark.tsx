import {
  MARK_SIZES,
  FLAME_ROTATION_DEGREES,
  bodyPath,
  flamePath,
  fillRect,
  layout,
  type MarkGeometry,
} from '~/assets/mark';
import type { ThresholdState } from '~/core/types';

interface MarkProps {
  /**
   * Quota **remaining**, 0–100, or `null` when nothing is known. Not
   * consumption — see src/assets/mark.ts.
   */
  remaining: number | null;
  /** Drives the fill colour. Nothing else does. */
  state: ThresholdState;
  size?: keyof typeof MARK_SIZES;
  /** Override the measured geometry. Used by the panel header. */
  geometry?: MarkGeometry;
}

/**
 * The mark, drawn as SVG from the geometry in src/assets/mark.ts.
 *
 * SVG rather than the archive's two nested divs, because the same shape has to
 * render into an OffscreenCanvas for the toolbar icon in M5, and maintaining
 * one definition beats keeping a DOM version and a canvas version in step.
 */
export function Mark({ remaining, state, size = 'inline', geometry }: MarkProps) {
  const spec: MarkGeometry = geometry ?? MARK_SIZES[size];
  const { viewBox, body, flame } = layout(spec);
  const fill = fillRect(body, remaining ?? 0);

  const clipId = `wick-mark-clip-${spec.bodyWidth}x${spec.bodyHeight}`;

  return (
    <svg
      class="wick-mark"
      width={viewBox.width}
      height={viewBox.height}
      viewBox={viewBox.toString()}
      role="img"
      aria-label={remaining === null ? 'Usage unknown' : `${Math.round(remaining)}% remaining`}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={bodyPath(body.x, body.y, body.width, body.height, body.radius)} />
        </clipPath>
      </defs>

      <path
        d={flamePath(flame.x, flame.y, flame.size)}
        transform={`rotate(${FLAME_ROTATION_DEGREES} ${flame.centreX} ${flame.centreY})`}
        fill="var(--wick-flame)"
      />

      <path
        d={bodyPath(body.x, body.y, body.width, body.height, body.radius)}
        fill="var(--wick-track)"
      />

      {/* Clipped rather than rounded, matching the archive's overflow:hidden —
          so a nearly-empty gauge keeps the body's square-ish bottom edge. */}
      {remaining !== null && fill.height > 0 && (
        <rect
          x={fill.x}
          y={fill.y}
          width={fill.width}
          height={fill.height}
          clip-path={`url(#${clipId})`}
          fill={fillColour(state)}
        />
      )}
    </svg>
  );
}

function fillColour(state: ThresholdState): string {
  switch (state) {
    case 'warn':
      return 'var(--wick-warn)';
    case 'crit':
      return 'var(--wick-crit)';
    case 'unknown':
      return 'var(--wick-track)';
    case 'ok':
      return 'var(--wick-accent)';
  }
}
