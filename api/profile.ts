/**
 * One participant's public page, at `/u/<name>`.
 *
 * A seam: read the name out of the path, ask the store for its stats, hand the
 * card to the renderer. `buildCard` decides what a profile may show and
 * `renderProfile` draws it; both are tested without a network.
 *
 * Profile responses are not cached. Leave promises that the public profile is
 * deleted, so neither a successful page nor a cached miss may outlive the
 * store state that produced it.
 */

import { buildCard, nameFromPath } from '../leaderboard/profile.js';
import { renderMissingProfile, renderProfile } from '../leaderboard/render.js';
import { configFromEnv, createSupabaseStore } from '../server/supabase-store.js';
import { sendHtml, sendText, type Req, type Res } from '../server/http.js';
import type { ProfileStats } from '../server/store.js';

const PROFILE_CACHE = 'no-store';

export default async function handler(req: Req, res: Res): Promise<void> {
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const name = readName(req);
  if (name === null) {
    sendHtml(res, 404, renderMissingProfile(), PROFILE_CACHE, headOnly);
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
    sendHtml(res, 503, renderMissingProfile(), PROFILE_CACHE, headOnly);
    return;
  }

  // `null` covers a name nobody has taken, a name whose holder left, and a
  // holder who has published nothing yet. The page deliberately does not say
  // which: separating them would let anyone enumerate who had quit.
  if (stats === null) {
    sendHtml(res, 404, renderMissingProfile(), PROFILE_CACHE, headOnly);
    return;
  }

  const card = buildCard(name, stats.standings, stats.streak, stats.leaderTotal);
  sendHtml(res, 200, renderProfile(card, today), PROFILE_CACHE, headOnly);
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
