/**
 * Building one profile's stats out of a loaded participant list.
 *
 * Shared by both adapters, because there is nothing storage-specific in it:
 * given everyone's rows, the answer is the same whether they came from Postgres
 * or from a Map. Keeping it here rather than duplicating it is what stops the
 * in-memory store from quietly disagreeing with the deployed one, which would
 * make every test written against the fake a test of the wrong thing.
 *
 * Not in `leaderboard/` because it is shaped by the store's port — it returns a
 * `ProfileStats`, which is a storage concern. The ranking it delegates to is
 * pure and lives there.
 */

import { place, streak as runOfDays, summarise } from '../leaderboard/ranking.js';
import type { Day, Period } from '../leaderboard/periods.js';
import type { Participant, Standing } from '../leaderboard/ranking.js';
import type { ProfileStats } from './store.js';

const PERIODS = ['week', 'month', 'all'] as const;

/**
 * The three standings and the streak for one name.
 *
 * `null` when nobody holds the name — and deliberately also `null` when the
 * holder has published nothing, so the two are indistinguishable from outside.
 * A page that separated "never existed", "left", and "joined but silent" would
 * let anyone enumerate which names are taken and who had quit.
 *
 * Ranks are computed against **everyone**, not against the published top slice,
 * so a participant far below the hundredth row still gets a real number.
 */
export function statsFrom(
  participants: readonly Participant[],
  name: string,
  today: Day,
): ProfileStats | null {
  const standings = new Map<Period, Standing | null>();
  let ranked = false;
  let leaderTotal = 0;

  for (const period of PERIODS) {
    const all = place(
      participants
        .map((participant) => summarise(participant, period, today))
        // A zero is not a standing: it would occupy a rank somebody else
        // earned. Same rule the board applies, and it has to be the same rule,
        // or a profile would claim a rank the board does not show.
        .filter((standing) => standing.ranked > 0),
    );

    // All-time is the board a profile's share is measured against: a week's
    // leader changes constantly, and a bar that moved for reasons nothing on
    // the page explains is a bar nobody can read.
    if (period === 'all') leaderTotal = all[0]?.ranked ?? 0;

    const found = all.find((standing) => standing.name === name) ?? null;
    if (found !== null) ranked = true;
    standings.set(period, found);
  }

  if (!ranked) return null;

  const participant = participants.find((candidate) => candidate.name === name);
  return {
    standings,
    streak: participant === undefined ? 0 : runOfDays(participant),
    leaderTotal,
  };
}
