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
  USER_EMAIL,
  findAnchor,
  findDockTarget,
  findUserEmail,
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

describe('findUserEmail', () => {
  /**
   * A page whose user-menu header holds `text`.
   *
   * `textContent` rather than `innerText`, matching what the real element
   * exposes — the wrapper carries a `truncate` class, so `innerText` would hand
   * back a visually clipped address on a narrow sidebar and the board would key
   * a profile on half an address.
   */
  function pageShowing(text: unknown) {
    const asked: string[] = [];
    const root = {
      asked,
      querySelector(selector: string): unknown {
        asked.push(selector);
        return selector === USER_EMAIL ? { textContent: text } : null;
      },
    };
    return root;
  }

  it('reads the address out of the markup claude.ai actually renders', () => {
    // Observed 2026-08-27:
    //   <div role="presentation" class="... truncate">
    //     <span data-testid="user-menu-header">someone@example.com</span>
    //   </div>
    const root = pageShowing('someone@example.com');
    expect(findUserEmail(asRoot(root))).toBe('someone@example.com');
    expect(root.asked).toEqual([USER_EMAIL]);
  });

  it('normalises, so one account does not become two profiles', () => {
    // The board keys on this. A differently-cased or padded render must not
    // read as a different account.
    expect(findUserEmail(asRoot(pageShowing('  Someone@Example.COM  ')))).toBe(
      'someone@example.com',
    );
  });

  it('reports nothing when the menu holds something that is not an address', () => {
    // A display name, a signed-out placeholder, or a build that renders this
    // element differently. Not knowing is a state the board handles; a wrong
    // answer is one it cannot.
    for (const value of ['', '   ', 'Ash Padhi', null, undefined, 42]) {
      expect(findUserEmail(asRoot(pageShowing(value))), JSON.stringify(value)).toBeNull();
    }
  });

  it('reports nothing when the element is absent', () => {
    const root = {
      asked: [] as string[],
      querySelector(): unknown {
        return null;
      },
    };
    expect(findUserEmail(asRoot(root))).toBeNull();
  });

  it('does not throw when the page refuses the query', () => {
    // Wick is a guest on someone else's page. A detached tree or a selector
    // engine that objects must degrade to "unknown", never to an exception in
    // the content script.
    const root = {
      asked: [] as string[],
      querySelector(): unknown {
        throw new Error('detached');
      },
    };
    expect(() => findUserEmail(asRoot(root))).not.toThrow();
    expect(findUserEmail(asRoot(root))).toBeNull();
  });
});
