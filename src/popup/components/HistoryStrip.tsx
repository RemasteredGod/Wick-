import type { DailyRollup } from '~/core/types';

interface HistoryStripProps {
  /** Rollups, oldest first. Gaps are expected and are shown as gaps. */
  history: DailyRollup[];
  /** Which window's peaks to plot. */
  windowKey: string;
  now: number;
  /** Days to show. The archive draws seven. */
  days?: number;
  /** The shorter strip used in the injected panel. */
  compact?: boolean;
}

/**
 * Seven days of peak usage, most recent on the right.
 *
 * Today is drawn in the accent, yesterday a step brighter than the rest. Days
 * with no record are outlined rather than filled — a day the user did not open
 * Claude is missing evidence, and drawing it as a zero-height bar would claim
 * knowledge Wick does not have.
 */
export function HistoryStrip({
  history,
  windowKey,
  now,
  days = 7,
  compact = false,
}: HistoryStripProps) {
  const byDate = new Map(history.map((day) => [day.date, day]));
  const columns = lastDays(now, days).map((date, index) => ({
    date,
    peak: byDate.get(date)?.windows[windowKey] ?? null,
    isToday: index === days - 1,
    isRecent: index === days - 2,
  }));

  return (
    <div class="wick-history">
      <div
        class="wick-history__bars"
        style={compact ? { height: 'var(--wick-history-height-sm)' } : undefined}
      >
        {columns.map((column) => (
          <div
            key={column.date}
            class={barClass(column)}
            style={{ height: `${column.peak ?? 0}%` }}
            title={`${column.date}: ${column.peak === null ? 'no record' : `${Math.round(column.peak)}%`}`}
          />
        ))}
      </div>

      {!compact && (
        <div class="wick-history__labels">
          {columns.map((column) => (
            <span key={column.date}>{column.isToday ? 'TODAY' : shortDay(column.date)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function barClass(column: { peak: number | null; isToday: boolean; isRecent: boolean }): string {
  if (column.peak === null) return 'wick-history__bar wick-history__bar--empty';
  if (column.isToday) return 'wick-history__bar wick-history__bar--today';
  if (column.isRecent) return 'wick-history__bar wick-history__bar--recent';
  return 'wick-history__bar';
}

/** The last `count` local calendar dates ending today, oldest first. */
export function lastDays(now: number, count: number): string[] {
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${d.getFullYear()}-${month}-${day}`);
  }
  return out;
}

function shortDay(date: string): string {
  // Parsed as local midnight rather than through Date.parse, which reads a bare
  // YYYY-MM-DD as UTC and shifts the label by a day west of Greenwich.
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return at.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase();
}
