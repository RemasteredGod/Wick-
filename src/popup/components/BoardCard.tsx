import type { BoardSyncState } from '~/core/types';

interface BoardCardProps {
  /** Whether this installation has enrolled and holds a participant token. */
  enrolled: boolean;
  /** The assigned name it submits under, when enrolled. */
  name: string | null;
  /** Messages counted today, or null when nothing has been recorded yet. */
  today: number | null;
  /** Local publication progress written by the worker. */
  syncState: BoardSyncState;
}

/**
 * Leaderboard status, and what it publishes.
 *
 * Takes the place of the Telegram alert card. The card that stood here
 * described a channel Wick no longer has: alerts are local notifications now,
 * they need no setup, and a status line for a thing that always works is a line
 * that says nothing.
 *
 * **What leaves the machine is named on the card.** A daily message count, under
 * an assigned name the board holds against the Claude account's email — no
 * percentages, no window keys, no times of day. The user should be able to read
 * what is published without opening the privacy policy, so it is written here
 * rather than linked to. The address itself is on the settings screen, where
 * there is room to say what it is for.
 *
 * Display only. The Join and Leave controls live on the settings screen, where
 * the permission prompt can be raised from a real click.
 */
export function BoardCard({ enrolled, name, today, syncState }: BoardCardProps) {
  return (
    <div class="wick-board">
      <div class="wick-board__head">
        <span class="wick-board__title">Leaderboard</span>
        <span class={`wick-board__status${enrolled ? '' : ' wick-board__status--off'}`}>
          <span class="wick-board__dot" />
          {enrolled ? (name ?? 'Joined') : 'Not joined'}
        </span>
      </div>

      <div class="wick-board__note">
        {enrolled
          ? formatBoardSyncCopy(syncState, today)
          : 'Optional. Wick tracks fine without it.'}
      </div>
    </div>
  );
}

export function formatBoardSyncCopy(state: BoardSyncState, today: number | null): string {
  switch (state.kind) {
    case 'waiting-for-day-close': {
      const waiting = 'Waiting for today to close before publishing.';
      return today === null ? waiting : `${today} messages today. ${waiting}`;
    }
    case 'syncing':
      return 'Syncing completed days.';
    case 'retry-pending':
      return 'Completed days are waiting to sync. Wick will retry.';
    case 'accepted-through':
      return `Accepted through ${displayDay(state.day)}. Today's count waits until the day closes.`;
  }
}

/** Format a stored local date without routing it through a UTC conversion. */
function displayDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return day;

  const month = Number(match[2]);
  const monthName = MONTHS[month - 1];
  if (monthName === undefined) return day;
  return `${Number(match[3])} ${monthName} ${match[1]}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
