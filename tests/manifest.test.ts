import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../src/manifest';
import { BOARD_ORIGIN, BOARD_ORIGIN_PATTERN } from '~/background/board';
import { ICON_PATHS } from './helpers/icon-png';

/**
 * `defineManifest` returns a union that also admits a promise and a factory,
 * because CRXJS supports both. Ours is a plain object, and the tests below read
 * its keys directly.
 */
const config = manifest as chrome.runtime.ManifestV3;

describe('extension manifest', () => {
  it('registers the fetch wrapper directly in the MAIN world', () => {
    expect(manifest).toMatchObject({
      content_scripts: [
        {
          matches: ['https://claude.ai/*'],
          js: ['src/content/inject.ts'],
          world: 'MAIN',
          run_at: 'document_start',
        },
        {
          matches: ['https://claude.ai/*'],
          js: ['src/content/index.ts'],
          run_at: 'document_idle',
        },
      ],
    });
  });

  /**
   * The bundler names output chunks after the entry file's basename, and the
   * generated service-worker loader is matched to a chunk by that name. Two
   * entries called `index.ts` therefore collide, and the loser's loader imports
   * the winner's chunk: the worker ends up running the content script, with no
   * alarms, no collector, no icon — and no error, because everything the
   * content script does on a page is wrapped in `safely`.
   *
   * Asserted here rather than left to the build, because the failure is silent
   * in both places it could be noticed.
   */
  it('gives every script entry a distinct file name', () => {
    const entries = [
      config.background?.service_worker,
      ...(config.content_scripts ?? []).flatMap((script) => script.js ?? []),
    ].filter((path): path is string => typeof path === 'string');

    const basenames = entries.map((path) => path.split('/').at(-1));
    expect(basenames).toEqual([...new Set(basenames)]);
  });

  it('does not expose a TypeScript module for DOM injection', () => {
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });

  it('references every packaged icon from the extension and action', () => {
    expect(config.icons).toEqual(ICON_PATHS);
    expect(config.action?.default_icon).toEqual(ICON_PATHS);
    expect(config.action?.default_title).toBe('Wick');

    for (const path of Object.values(ICON_PATHS)) {
      expect(existsSync(resolve(import.meta.dirname, '../public', path)), `${path} must exist`).toBe(
        true,
      );
    }
  });

  it('does not use static brand favicons as toolbar usage state', () => {
    const referenced = [
      ...Object.values(config.icons ?? {}),
      ...Object.values(config.action?.default_icon ?? {}),
    ];
    expect(referenced).not.toContain('favicon.svg');
    expect(referenced).not.toContain('favicon-16.png');
    expect(referenced).not.toContain('favicon-32.png');
  });

  it('preserves the install-time permission set', () => {
    expect(config.permissions).toEqual([
      'storage',
      'alarms',
      'cookies',
      'webRequest',
      'notifications',
    ]);
    expect(config).not.toHaveProperty('content_security_policy');
  });
});

describe('the optional board origin', () => {
  it('matches the origin the client actually fetches', () => {
    // `manifest.ts` cannot import from `~/background/board` — Vite's config
    // loader does not resolve the alias — so the pattern is written out twice.
    // A mismatch is not a permission error, it is an opaque network failure:
    // every board call is blocked and the popup reports "could not reach the
    // leaderboard", which reads as the server being down. This test is the only
    // thing keeping the two copies honest.
    expect(config.optional_host_permissions).toEqual([BOARD_ORIGIN_PATTERN]);
  });

  it('names the canonical host, not a redirecting apex', () => {
    // usewick.lol answers 308 to www. A 308 keeps the method and the body, but
    // the two are different origins and `fetch` strips `Authorization` across
    // an origin-crossing redirect — so a submission through the apex would
    // arrive unauthenticated and be refused as a 401 that looks like a bad
    // token. Never take the redirect.
    expect(BOARD_ORIGIN).toBe('https://www.usewick.lol');
  });

  it('is optional, and never part of the install prompt', () => {
    // The board is opt-in. A host permission in `host_permissions` is granted
    // at install, which would make every user grant it whether or not they ever
    // join.
    expect(config.host_permissions).toEqual(['https://claude.ai/*']);
    expect(config.host_permissions).not.toContain(BOARD_ORIGIN_PATTERN);
  });
});
