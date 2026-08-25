import { describe, expect, it } from 'vitest';
import manifest from '../src/manifest';

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
});
