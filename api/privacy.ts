/**
 * `/privacy` — the address published as Wick's privacy policy.
 *
 * A redirect rather than a second rendered page, deliberately. `PRIVACY.md` is
 * the policy; an HTML copy of it here would be a second text that has to be
 * edited in the same commit forever, and the copy that quietly goes stale is
 * the one users and Web Store reviewers actually read. What the store listing
 * needs is a stable address on Wick's own domain, which is what this supplies
 * — pointing at the one canonical document instead of duplicating it.
 *
 * It holds no data and touches no database, so the edge cache serves it for as
 * long as the landing page.
 */

import { sendRedirect, sendText, type Req, type Res } from '../server/http.js';

/**
 * The canonical policy text.
 *
 * The repository, not a raw file URL: the rendered page carries the licence,
 * the history, and the rest of the source a reader may want to check the policy
 * against, and `PRIVACY.md` says in as many words that the code is the truth
 * where the two disagree.
 */
const CANONICAL_POLICY = 'https://github.com/RemasteredGod/Wick-/blob/master/PRIVACY.md';

export default function handler(req: Req, res: Res): void {
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method not allowed');
    return;
  }

  sendRedirect(res, CANONICAL_POLICY, 'public, s-maxage=86400, stale-while-revalidate=604800', headOnly);
}
