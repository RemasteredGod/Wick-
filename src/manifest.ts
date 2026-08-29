import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

/**
 * Wick supports Chrome in v1. Firefox is a later diff, not a rewrite, so every
 * key that differs between the two is selected through this constant rather
 * than sprinkled through the object below. Adding Firefox should mean setting
 * TARGET and filling in the other branch of each ternary.
 */
const TARGET: 'chrome' | 'firefox' = 'chrome';

/** Every claude.ai URL Wick is allowed to touch. Deliberately the only one. */
const CLAUDE_MATCH = 'https://claude.ai/*';

/**
 * The leaderboard origin, as a match pattern.
 *
 * Spelled out rather than imported from `src/background/board.ts`: this file is
 * evaluated by Vite's config loader, which does not resolve the `~` alias that
 * the background modules import through. It must stay identical to
 * `BOARD_ORIGIN_PATTERN` there — a mismatch fails as an opaque network error,
 * not as a permission error.
 *
 * One fixed host, unlike the `api.telegram.org` grant it replaces: the board is
 * a single deployment Wick owns, so the pattern names it exactly. `www` rather
 * than the apex, because the apex redirects and a cross-origin redirect drops
 * the `Authorization` header — see the note in `board.ts`.
 */
const BOARD_MATCH = 'https://www.usewick.lol/*';

/** Static unknown-state mark used until the live toolbar gauge paints. */
const ICONS = {
  '16': 'icons/16.png',
  '32': 'icons/32.png',
  '48': 'icons/48.png',
  '128': 'icons/128.png',
} as const;

export default defineManifest({
  manifest_version: 3,
  name: 'Wick',
  version: pkg.version,
  description: pkg.description,

  // Every extra permission is a Web Store review delay and a user-trust cost.
  // Do not add one without saying so explicitly. See AGENTS.md.
  //
  //   storage       — the local snapshot and the append-only daily history
  //   alarms        — scheduled polling, backed off when no claude.ai tab is open
  //   cookies       — reading lastActiveOrg to identify the user's active org
  //   webRequest    — headers-only observation of account/billing changes, to
  //                   invalidate cached state. MV3 cannot read response bodies
  //                   and Wick does not try; the completion stream is read in
  //                   the MAIN world instead.
  //   notifications — threshold alerts
  permissions: ['storage', 'alarms', 'cookies', 'webRequest', 'notifications'],

  // Never <all_urls>.
  host_permissions: [CLAUDE_MATCH],

  // Optional, and requested from the Join button rather than at install.
  //
  // `optional_host_permissions` is a manifest key, not a permission string: it
  // adds nothing to the install-time prompt, so a user who never joins the
  // leaderboard is never asked for it and can revoke it in Chrome's own UI if
  // they do. Every board call is blocked until it is granted, which is the
  // intended default — the board is opt-in and the extension is complete
  // without it.
  optional_host_permissions: [BOARD_MATCH],

  icons: ICONS,

  action: {
    default_icon: ICONS,
    default_popup: 'src/popup/index.html',
    default_title: 'Wick',
  },

  // Named `service-worker.ts`, not `index.ts`, and that is load-bearing: the
  // bundler names output chunks after the entry's basename, so two entries
  // called `index.ts` collide and one loader ends up importing the other's
  // chunk. When that happened, the worker loaded the content script — no
  // alarms, no collector, no icon, and no error to say so. See
  // tests/manifest.test.ts.
  background:
    TARGET === 'chrome'
      ? { service_worker: 'src/background/service-worker.ts', type: 'module' }
      : { scripts: ['src/background/service-worker.ts'], type: 'module' },

  content_scripts: [
    {
      matches: [CLAUDE_MATCH],
      js: ['src/content/inject.ts'],
      // Register through MV3 instead of appending a web-accessible `.ts` module.
      // Chrome compiles this entry to JavaScript and executes it in the page's
      // world without depending on the response MIME type of an extension URL.
      world: 'MAIN',
      run_at: 'document_start',
    },
    {
      matches: [CLAUDE_MATCH],
      js: ['src/content/index.ts'],
      // The sidebar card mounts into a nav that React renders after first
      // paint, so the script waits for its anchor rather than racing it.
      run_at: 'document_idle',
    },
  ],
});
