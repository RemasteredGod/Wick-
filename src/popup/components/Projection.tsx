import type { Projection as ProjectionResult, ThresholdState } from '~/core/types';

interface ProjectionProps {
  projection: ProjectionResult;
  /** State of the window being projected. Escalates the callout past 90%. */
  state: ThresholdState;
  /** When the window resets, so the sentence can say how much is left over. */
  resetsAt: number | null;
  now: number;
}

/**
 * The forecast sentence.
 *
 * This is the product. The meters, the stats and the sparkline are all evidence
 * for this one line, which is why it sits above them and why it is the only
 * thing on the panel with its own frame.
 *
 * When there is not enough history it says so plainly, in neutral colours. An
 * honest "not yet" is worth more than a guess, and dressing uncertainty in warn
 * colours would train the user to ignore the real thing.
 */
export function Projection({ projection, state, resetsAt, now }: ProjectionProps) {
  if (projection.exhaustionEstimate === null) {
    return (
      <div class="wick-projection wick-projection--unknown">
        No pace estimate yet. <strong>{projection.reason}.</strong>
      </div>
    );
  }

  const variant = state === 'crit' ? ' wick-projection--crit' : '';

  return (
    <div class={`wick-projection${variant}`}>
      At your current pace you run out{' '}
      <strong>{describeMoment(projection.exhaustionEstimate, now)}</strong>
      {describeMargin(projection.exhaustionEstimate, resetsAt)}
    </div>
  );
}

/** "Tuesday evening", "tomorrow morning", "this evening". */
export function describeMoment(at: number, now: number): string {
  const moment = new Date(at);
  const partOfDay = partOfDayFor(moment.getHours());

  const days = calendarDaysBetween(now, at);
  if (days === 0) return `this ${partOfDay}`;
  if (days === 1) return `tomorrow ${partOfDay}`;
  if (days < 7) return `${moment.toLocaleDateString(undefined, { weekday: 'long' })} ${partOfDay}`;

  return `${moment.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}, ${partOfDay}`;
}

/** " — two days before reset", when running out early is the point. */
function describeMargin(exhaustionAt: number, resetsAt: number | null) {
  if (resetsAt === null || resetsAt <= exhaustionAt) return '.';

  const days = calendarDaysBetween(exhaustionAt, resetsAt);
  if (days === 0) return '.';
  return ` — ${days === 1 ? 'a day' : `${spell(days)} days`} before reset.`;
}

function partOfDayFor(hour: number): string {
  if (hour < 5) return 'overnight';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'tonight';
}

/**
 * Whole calendar days between two moments, local time.
 *
 * Calendar days rather than 24-hour spans, because "tomorrow" means the next
 * date on the wall, not 24 hours from now — at 11pm those are different
 * answers and only one of them is what the user means.
 */
function calendarDaysBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

function spell(n: number): string {
  return NUMBERS[n] ?? String(n);
}
