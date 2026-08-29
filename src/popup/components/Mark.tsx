import { useId } from 'preact/hooks';
import {
  EMBER_PATH,
  MARK_IDENTITY,
  MARK_SIZES,
  fillRect,
  layout,
  type MarkSize,
} from '~/assets/mark';
import type { ThresholdState } from '~/core/types';

interface MarkProps {
  /** Quota remaining, or null when no percentage is known. */
  remaining: number | null;
  /** Existing status precedence drives the fill/dash colour. */
  state: ThresholdState;
  size?: MarkSize;
}

/** The canonical v3 upright mark, without changing its existing layout box. */
export function Mark({ remaining, state, size = 'inline' }: MarkProps) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const clipId = `wick-mark-body-${id}`;
  const gradientId = `wick-mark-ember-${id}`;
  const { viewBox, body } = layout();
  const footprint = MARK_SIZES[size];
  const fill = fillRect(body, remaining ?? 0);
  const unknownDashHeight = body.height * 0.1;

  return (
    <svg
      class="wick-mark"
      width={footprint.width}
      height={footprint.height}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      role="img"
      aria-label={remaining === null ? 'Usage unknown' : `${Math.round(remaining)}% remaining`}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1={MARK_IDENTITY.gradient.x1}
          y1={MARK_IDENTITY.gradient.y1}
          x2={MARK_IDENTITY.gradient.x2}
          y2={MARK_IDENTITY.gradient.y2}
        >
          <stop offset="0" stop-color={MARK_IDENTITY.gradient.start} />
          <stop offset="1" stop-color={MARK_IDENTITY.gradient.end} />
        </linearGradient>
        <clipPath id={clipId}>
          <rect
            x={body.x}
            y={body.y}
            width={body.width}
            height={body.height}
            rx={body.radius}
          />
        </clipPath>
      </defs>

      <path
        d={EMBER_PATH}
        fill={remaining === null ? 'var(--wick-mark-track)' : `url(#${gradientId})`}
      />
      <rect
        x={body.x}
        y={body.y}
        width={body.width}
        height={body.height}
        rx={body.radius}
        fill="var(--wick-mark-track)"
      />

      {remaining === null ? (
        <rect
          x={body.x}
          y={body.y + (body.height - unknownDashHeight) / 2}
          width={body.width}
          height={unknownDashHeight}
          clip-path={`url(#${clipId})`}
          fill={state === 'unknown' ? 'var(--wick-text-dim)' : fillColour(state)}
        />
      ) : (
        fill.height > 0 && (
          <rect
            x={fill.x}
            y={fill.y}
            width={fill.width}
            height={fill.height}
            clip-path={`url(#${clipId})`}
            fill={fillColour(state)}
          />
        )
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
      return 'var(--wick-text-dim)';
    case 'ok':
      return 'var(--wick-accent)';
  }
}
