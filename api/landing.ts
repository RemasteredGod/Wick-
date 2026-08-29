/**
 * The landing page.
 *
 * A function rather than a file in `public/` so it shares the renderer's shell
 * with the board — one palette, one layout, one place to change them. It holds
 * no data and touches no database, so the edge cache serves it essentially
 * forever and the function runs about once a day.
 */

import { renderLanding } from '../leaderboard/render.js';
import { sendHtml, sendText, type Req, type Res } from '../server/http.js';

export default function handler(req: Req, res: Res): void {
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method not allowed');
    return;
  }

  // Nothing on this page changes between deployments, so it is cached hard.
  // A deploy invalidates the edge cache, which is the only time it should.
  sendHtml(
    res,
    200,
    renderLanding(),
    'public, s-maxage=86400, stale-while-revalidate=604800',
    headOnly,
  );
}
