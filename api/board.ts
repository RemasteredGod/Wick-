/**
 * The public leaderboard, server-rendered.
 *
 * A seam: read the period, ask the store, hand the standings to the renderer.
 * The ranking lives in leaderboard/ranking.ts and the markup in
 * leaderboard/render.ts, both of which are tested without a network.
 *
 * Successful boards are cached at the edge for at most sixty seconds. There is
 * deliberately no stale-while-revalidate window: a cached board can already
 * show a participant for that minute after Leave, and extending that stale copy
 * would make the deletion promise needlessly weaker.
 *
 * Nothing here is per-viewer, and nothing may become so without giving that up.
 */

import { renderBoard } from '../leaderboard/render.js';
import { BOARD_SIZE } from '../leaderboard/ranking.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { queryParam, sendHtml, sendText, type Req, type Res } from '../server/http.js';
import type { Period } from '../leaderboard/periods.js';
import type { Standing } from '../leaderboard/ranking.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method not allowed');
    return;
  }

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
      headOnly,
    );
    return;
  }

  sendHtml(res, 200, renderBoard({ period, standings, today }), 'public, s-maxage=60', headOnly);
}

/** `?p=month` or `?p=all`; anything else is the weekly board. */
function readPeriod(req: Req): Period {
  const value = queryParam(req, 'p');
  return value === 'month' || value === 'all' ? value : 'week';
}
