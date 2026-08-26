/**
 * The landing page.
 *
 * A function rather than a file in `public/` so it shares the renderer's shell
 * with the board — one palette, one layout, one place to change them. It holds
 * no data and touches no database, so the edge cache serves it essentially
 * forever and the function runs about once a day.
 */

import { renderLanding } from '../leaderboard/render';

export const config = { runtime: 'nodejs' };

export default function handler(): Response {
  return new Response(renderLanding(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Nothing on this page changes between deployments, so it is cached hard.
      // A deploy invalidates the edge cache, which is the only time it should.
      'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
