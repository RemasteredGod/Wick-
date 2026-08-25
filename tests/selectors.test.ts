/**
 * Where the sidebar card docks.
 *
 * These are the most fragile lines in the extension — claude.ai's markup is
 * build output — so what is asserted here is the part that is ours to get
 * right: the *order* candidates are tried in, and the promise that a miss is a
 * miss rather than a mount in the wrong place.
 *
 * There is no DOM in this environment (vite.config.ts keeps the test
 * environment at `node`, and jsdom is not a dependency). `findAnchor` and
 * `findDockTarget` only ever call `querySelector`, so a recording stub is
 * enough to assert both, and the alternative — a DOM dependency for two
 * functions — is not a trade this repository makes.
 */

import { describe, expect, it } from 'vitest';
import {
  PROJECTS_REGION,
  PROJECTS_REGION_FALLBACK,
  SIDEBAR_ANCHORS,
  findAnchor,
  findDockTarget,
} from '~/content/selectors';

/**
 * A stand-in for the page, present only where the real DOM would be.
 *
 * `matches` maps a selector to the element it should find; everything else
 * misses. `asked` records the order, which is the thing under test.
 */
function stubRoot(matches: Record<string, string> = {}) {
  const asked: string[] = [];
  const root = {
    asked,
    querySelector(selector: string): unknown {
      asked.push(selector);
      return matches[selector] ?? null;
    },
  };
  return root;
}

/** The stub satisfies the one method these functions use. */
function asRoot(stub: ReturnType<typeof stubRoot>): ParentNode & Element {
  return stub as unknown as ParentNode & Element;
}

describe('findAnchor', () => {
  it('finds the sidebar by its accessible name', () => {
    const root = stubRoot({ 'aside[aria-label="Sidebar"]': 'sidebar' });
    expect(findAnchor(asRoot(root))).toBe('sidebar');
  });

  it('prefers a test id over the accessible name', () => {
    const root = stubRoot({
      '[data-testid="menu-sidebar"]': 'by-testid',
      'aside[aria-label="Sidebar"]': 'by-label',
    });
    expect(findAnchor(asRoot(root))).toBe('by-testid');
  });

  it('prefers the accessible name over a generated class name', () => {
    const root = stubRoot({
      'aside[aria-label="Sidebar"]': 'by-label',
      'aside.dframe-sidebar': 'by-class',
    });
    expect(findAnchor(asRoot(root))).toBe('by-label');
  });

  it('returns null when nothing matches, having tried every candidate', () => {
    const root = stubRoot();
    expect(findAnchor(asRoot(root))).toBeNull();
    expect(root.asked).toEqual([...SIDEBAR_ANCHORS]);
  });

  it('never falls back to a bare nav', () => {
    // A `nav` anywhere on the page is not evidence of claude.ai's sidebar, and
    // mounting the card into the wrong container is worse than not mounting.
    expect(SIDEBAR_ANCHORS).not.toContain('nav');
  });
});

describe('findDockTarget', () => {
  /**
   * Only the selector choice is asserted here. Where the card actually *lands*
   * depends on walking the tree — parents, siblings, `contains` — and the
   * recording stub above fakes `querySelector` and nothing else. Faking the
   * rest would be asserting against my own imitation of a DOM rather than
   * against a DOM.
   *
   * That placement is checked in a real browser instead, against five shapes
   * the projects section can take (heading as a sibling, heading inside a
   * wrapper, heading outside one, no heading, and projects as the only list).
   * See the note in src/content/selectors.ts.
   */
  it('looks for the project list by test id before anything else', () => {
    expect(PROJECTS_REGION).toBe('[data-testid="sidebar-projects"]');
    expect(PROJECTS_REGION_FALLBACK).toBe('[data-kind="home-projects"]');
  });

  it('falls back to the text heading when the list cannot be found at all', () => {
    const anchor = {
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    expect(findDockTarget(asRoot(anchor as unknown as ReturnType<typeof stubRoot>))).toBeNull();
  });
});
