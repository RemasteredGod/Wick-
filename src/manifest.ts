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
 * The Telegram relay's origin, as a match pattern.
 *
 * Spelled out rather than imported from `src/background/relay.ts`: this file is
 * evaluated by Vite's config loader, which does not resolve the `~` alias that
 * the background modules import through. It must stay identical to
 * `RELAY_ORIGIN_PATTERN` there — a mismatch fails as an opaque network error,
 * not as a permission error.
 */
const RELAY_MATCH = 'https://relay.wick.tools/*';

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

  // Optional, and requested from the Connect button rather than at install.
  //
  // `optional_host_permissions` is a manifest key, not a permission string: it
  // adds nothing to the install-time prompt, so a user who never sets up
  // Telegram is never asked for it and can revoke it in Chrome's own UI if they
  // do. Every relay call is blocked until it is granted, which is the intended
  // default. See docs/decisions/0003-telegram-relay-design.md.
  optional_host_permissions: [RELAY_MATCH],

  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Wick',
  },

  background:
    TARGET === 'chrome'
      ? { service_worker: 'src/background/index.ts', type: 'module' }
      : { scripts: ['src/background/index.ts'], type: 'module' },

  content_scripts: [
    {
      matches: [CLAUDE_MATCH],
      js: ['src/content/index.ts'],
      // The sidebar card mounts into a nav that React renders after first
      // paint, so the script waits for its anchor rather than racing it.
      run_at: 'document_idle',
    },
  ],

  // The MAIN-world fetch wrapper. Reachable only from claude.ai — a page on any
  // other origin cannot pull it in.
  web_accessible_resources: [
    {
      resources: ['src/content/inject.ts'],
      matches: [CLAUDE_MATCH],
    },
  ],
});
