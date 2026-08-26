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

import { renderBoard } from '../leaderboard/render';
import { BOARD_SIZE } from '../leaderboard/ranking';
import { configFromEnv, createSupabaseStore } from '../relay/supabase-store';
import type { Period } from '../leaderboard/periods';

export const config = { runtime: 'nodejs' };

export default async function handler(request: Request): Promise<Response> {
  const period = readPeriod(request);
  const today = new Date().toISOString().slice(0, 10);

  let standings;
  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    standings = await store.board(period, today, BOARD_SIZE);
  } catch {
    // A board that cannot reach its database says so rather than rendering an
    // empty table, which would read as "nobody has submitted anything".
    return new Response(
      renderBoard({ period, standings: [], today }).replace(
        'No submissions',
        'The board is temporarily unavailable. No submissions',
      ),
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  return new Response(renderBoard({ period, standings, today }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      // The page is self-contained: no scripts, no external assets, no fonts.
      // Saying so costs nothing and closes the injection surface entirely.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** `?p=month` or `?p=all`; anything else is the weekly board. */
function readPeriod(request: Request): Period {
  const value = new URL(request.url).searchParams.get('p');
  return value === 'month' || value === 'all' ? value : 'week';
}
