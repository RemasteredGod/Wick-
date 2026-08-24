import { thresholdState } from '~/core/normalise';
import type { LimitWindow } from '~/core/types';

interface UsageMeterProps {
  window: LimitWindow;
  /** Epoch milliseconds, injected so the reset countdown is testable. */
  now: number;
  /** The three-pixel variant used inside the injected sidebar card. */
  compact?: boolean;
}

/**
 * One limit window: label, percentage, bar, and when it resets.
 *
 * The bar fills with consumption, which is the opposite of the mark — the mark
 * empties as you spend. Both are deliberate; see src/assets/mark.ts.
 */
export function UsageMeter({ window, now, compact = false }: UsageMeterProps) {
  const state = thresholdState(window.utilization, window.status);
  const known = window.utilization !== null;

  return (
    <div class={compact ? 'wick-meter wick-meter--compact' : 'wick-meter'}>
      <div class="wick-meter__head">
        <span class="wick-meter__label">{compact ? window.shortLabel : window.label}</span>
        <span class={`wick-meter__value wick-state-${state}`}>
          {known ? `${Math.round(window.utilization ?? 0)}%` : 'Unknown'}
        </span>
      </div>

      <div class="wick-meter__track">
        <div
          class={`wick-meter__fill wick-fill-${state}`}
          style={{ width: `${known ? Math.min(100, window.utilization ?? 0) : 0}%` }}
        />
      </div>

      {!compact && <div class="wick-meter__reset">{resetLabel(window.resetsAt, now)}</div>}
    </div>
  );
}

/**
 * "Resets in 1 hr 42 min" for anything today, "Resets Thursday, 09:00" beyond
 * that.
 *
 * The archive uses both forms and the split it implies is a sensible one: a
 * countdown is what you want when the window turns over within the hour, and a
 * day name is what you want when it does not.
 */
export function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'Reset time unknown';

  const remaining = resetsAt - now;
  if (remaining <= 0) return 'Resetting now';

  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    if (hours === 0) return `Resets in ${minutes} min`;
    const rest = minutes % 60;
    return rest === 0 ? `Resets in ${hours} hr` : `Resets in ${hours} hr ${rest} min`;
  }

  const at = new Date(resetsAt);
  const day = at.toLocaleDateString(undefined, { weekday: 'long' });
  // 24-hour, following the archive's "Resets Thursday, 09:00" rather than the
  // locale default, which appends AM/PM under en-US and pushes the line wider
  // than the design allows for.
  const time = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `Resets ${day}, ${time}`;
}
