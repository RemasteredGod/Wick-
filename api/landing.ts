/**
 * The landing page.
 *
 * A function rather than a file in `public/` so it shares the renderer's shell
 * with the board — one palette, one layout, one place to change them. It holds
 * no data and touches no database, so the edge cache serves it essentially
 * forever and the function runs about once a day.
 */

import { renderLanding } from '../leaderboard/render';
import { sendHtml, type Req, type Res } from '../relay/http';

export default function handler(_req: Req, res: Res): void {
  // Nothing on this page changes between deployments, so it is cached hard.
  // A deploy invalidates the edge cache, which is the only time it should.
  sendHtml(res, 200, renderLanding(), 'public, s-maxage=86400, stale-while-revalidate=604800');
}
