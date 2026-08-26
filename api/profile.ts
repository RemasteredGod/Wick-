/**
 * One participant's public page, at `/u/<name>`.
 *
 * A seam: read the name out of the path, ask the store for its stats, hand the
 * card to the renderer. `buildCard` decides what a profile may show and
 * `renderProfile` draws it; both are tested without a network.
 *
 * **One read, not three.** The store answers all three periods and the streak
 * together. Asking a period at a time meant reloading and re-ranking every
 * participant three times for one page, and still could not report a streak,
 * because a `Standing` has already summarised the individual days away.
 *
 * Nothing here is per-viewer, and nothing may become so without giving up the
 * edge cache below.
 */

import { buildCard, nameFromPath } from '../leaderboard/profile.js';
import { renderMissingProfile, renderProfile } from '../leaderboard/render.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { sendHtml, type Req, type Res } from '../server/http.js';
import type { ProfileStats } from '../server/store.js';

/**
 * How long a profile may be served from the edge.
 *
 * Shorter than the board's minute, and deliberately with **no
 * `stale-while-revalidate`**. Leaving deletes the profile, and `PRIVACY.md`
 * says so plainly; a `stale-while-revalidate` window would keep serving the
 * page for its whole duration *after* the row was gone, so the board's
 * `s-maxage=60, stale-while-revalidate=300` would leave somebody's page up for
 * six minutes after they asked for it to go. A profile is one person's page and
 * gets little traffic, so there is nothing much to protect the origin from.
 */
const PROFILE_CACHE = 'public, s-maxage=30';

/**
 * How long a 404 may be served from the edge.
 *
 * Shorter still. The names on a fresh profile are assigned, so the common way
 * to reach a 404 is to look someone up a moment before they publish their first
 * day — and a cached miss would then outlive the thing that caused it.
 */
const MISSING_CACHE = 'public, s-maxage=10';

export default async function handler(req: Req, res: Res): Promise<void> {
  const name = readName(req);
  if (name === null) {
    sendHtml(res, 404, renderMissingProfile(), MISSING_CACHE);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  let stats: ProfileStats | null;
  try {
    const store = createSupabaseStore(configFromEnv(process.env));
    stats = await store.stats(name, today);
  } catch {
    // A page that cannot reach its database says so rather than rendering an
    // empty card, which would read as "this person has submitted nothing".
    sendHtml(res, 503, renderMissingProfile(), 'no-store');
    return;
  }

  // `null` covers a name nobody has taken, a name whose holder left, and a
  // holder who has published nothing yet. The page deliberately does not say
  // which: separating them would let anyone enumerate who had quit.
  if (stats === null) {
    sendHtml(res, 404, renderMissingProfile(), MISSING_CACHE);
    return;
  }

  const card = buildCard(name, stats.standings, stats.streak, stats.leaderTotal);
  sendHtml(res, 200, renderProfile(card, today), PROFILE_CACHE);
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
