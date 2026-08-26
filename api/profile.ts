/**
 * One participant's public page, at `/u/<name>`.
 *
 * A seam: read the name out of the path, ask the store for a standing in each
 * period, hand the card to the renderer. `buildCard` decides what a profile may
 * show and `renderProfile` draws it; both are tested without a network.
 *
 * **Three queries, one page, cached at the edge.** The card needs a rank in each
 * of the three periods and there is no single query that answers all three, so
 * the cost is paid once a minute per name rather than once per viewer.
 *
 * Nothing here is per-viewer, and nothing may become so without giving that up.
 */

import { buildCard, nameFromPath } from '../leaderboard/profile.js';
import { renderMissingProfile, renderProfile } from '../leaderboard/render.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { sendHtml, type Req, type Res } from '../server/http.js';
import type { Period } from '../leaderboard/periods.js';
import type { Standing } from '../leaderboard/ranking.js';

const PERIODS = ['week', 'month', 'all'] as const;

export default async function handler(req: Req, res: Res): Promise<void> {
  const name = readName(req);
  if (name === null) {
    sendHtml(res, 404, renderMissingProfile(), 'public, s-maxage=60');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  let standings: Map<Period, Standing | null>;
  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    const results = await Promise.all(
      PERIODS.map(async (period) => [period, await store.standing(name, period, today)] as const),
    );
    standings = new Map(results);
  } catch {
    // A page that cannot reach its database says so rather than rendering an
    // empty card, which would read as "this person has submitted nothing".
    sendHtml(res, 503, renderMissingProfile(), 'no-store');
    return;
  }

  // Every period empty means the name is not on the board — either it was never
  // taken, or its holder left. The 404 deliberately does not say which.
  if ([...standings.values()].every((standing) => standing === null)) {
    sendHtml(res, 404, renderMissingProfile(), 'public, s-maxage=60');
    return;
  }

  // The streak needs the day-by-day rows, which a standing does not carry.
  // Reported as zero rather than queried for separately: one more full-table
  // read per profile view is not worth a number nobody has asked for yet.
  const card = buildCard(name, standings, 0);

  sendHtml(res, 200, renderProfile(card, today), 'public, s-maxage=60, stale-while-revalidate=300');
}

/**
 * The name in the request path.
 *
 * `nameFromPath` does the validating — it lowercases, decodes, and refuses
 * anything outside the stored alphabet — so a path that reaches the store has
 * already been narrowed to something a name could be.
 */
function readName(req: Req): string | null {
  try {
    return nameFromPath(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
}
