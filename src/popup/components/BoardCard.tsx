interface BoardCardProps {
  /** Whether this installation has enrolled and holds a participant token. */
  enrolled: boolean;
  /** The assigned name it submits under, when enrolled. */
  name: string | null;
  /** Messages counted today, or null when nothing has been recorded yet. */
  today: number | null;
}

/**
 * Leaderboard status, and what it publishes.
 *
 * Takes the place of the Telegram alert card. The card that stood here
 * described a channel Wick no longer has: alerts are local notifications now,
 * they need no setup, and a status line for a thing that always works is a line
 * that says nothing.
 *
 * **What leaves the machine is named on the card.** A daily message count and
 * an assigned name — no percentages, no window keys, no account id, no times of
 * day. The user should be able to read what is published without opening the
 * privacy policy, so it is written here rather than linked to.
 *
 * Display only. The Join and Leave controls live on the settings screen, where
 * the permission prompt can be raised from a real click.
 */
export function BoardCard({ enrolled, name, today }: BoardCardProps) {
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
          ? `Publishing your daily message count${today === null ? '' : ` — ${today} today`}.`
          : 'Optional. Wick tracks fine without it.'}
      </div>
    </div>
  );
}
