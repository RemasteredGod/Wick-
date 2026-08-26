/**
 * The public leaderboard, server-rendered.
 *
 * A seam: read the period, ask the store, hand the standings to the renderer.
 * The ranking lives in leaderboard/ranking.ts and the markup in
 * leaderboard/render.ts, both of which are tested without a network.
 *
 * **Cached at the edge for sixty seconds.** A viral moment then costs one
 * database query a minute rather than one per viewer, which is the difference
 * between this being free to run and not. `stale-while-revalidate` means the
 * minute-old copy is served while the next one is fetched, so nobody waits.
 *
 * Nothing here is per-viewer, and nothing may become so without giving that up.
 */

import { renderBoard } from '../leaderboard/render.js';
import { BOARD_SIZE } from '../leaderboard/ranking.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { queryParam, sendHtml, type Req, type Res } from '../server/http.js';
import type { Period } from '../leaderboard/periods.js';
import type { Standing } from '../leaderboard/ranking.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  const period = readPeriod(req);
  const today = new Date().toISOString().slice(0, 10);

  let standings: Standing[];
  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    standings = await store.board(period, today, BOARD_SIZE);
  } catch {
    // A board that cannot reach its database says so rather than rendering an
    // empty table, which would read as "nobody has submitted anything".
    sendHtml(
      res,
      503,
      renderBoard({ period, standings: [], today }).replace(
        'No submissions',
        'The board is temporarily unavailable. No submissions',
      ),
      'no-store',
    );
    return;
  }

  sendHtml(
    res,
    200,
    renderBoard({ period, standings, today }),
    'public, s-maxage=60, stale-while-revalidate=300',
  );
}

/** `?p=month` or `?p=all`; anything else is the weekly board. */
function readPeriod(req: Req): Period {
  const value = queryParam(req, 'p');
  return value === 'month' || value === 'all' ? value : 'week';
}
