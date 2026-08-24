/**
 * Every DOM selector Wick uses against claude.ai, in one file.
 *
 * They live together because they are the most fragile thing in the codebase —
 * claude.ai's markup is a build artifact that can change without any release on
 * our side — and because "add support for a layout change" should be an edit to
 * one file rather than a hunt.
 *
 * **Unverified.** These are candidates read off screenshots, not confirmed
 * against the live page. Confirming them is part of M2. Nothing here is allowed
 * to be load-bearing: if every candidate misses, the card does not mount and
 * the page is untouched. Failing quiet is the rule — Wick is a guest on that
 * page.
 */

/**
 * Where the card docks, tried in order.
 *
 * Ordered most stable first: a test id survives a restyle, a structural tag
 * survives a class rename, and a text match survives almost anything but is the
 * least precise. The card mounts before the first match.
 */
export const SIDEBAR_ANCHORS = [
  '[data-testid="menu-sidebar"] nav',
  'nav[aria-label="Sidebar"]',
  'aside nav',
  'nav',
] as const;

/**
 * The heading the card sits above.
 *
 * The archive docks Wick immediately above Projects, so it never competes with
 * the chat list for attention. If this is not found the card still mounts, at
 * the end of the nav.
 */
export const PROJECTS_HEADING_TEXT = 'Projects';

/** Id of the host element Wick inserts. Also how it detects it is already mounted. */
export const HOST_ID = 'wick-sidebar-host';

/**
 * How long to keep watching for an anchor before giving up, in milliseconds.
 *
 * The sidebar is rendered after first paint, so the script cannot simply look
 * once. It also must not observe forever: a page that never grows the anchor is
 * a page where Wick does not belong.
 */
export const ANCHOR_TIMEOUT_MS = 15_000;

/** Find the first anchor present, or `null`. */
export function findAnchor(root: ParentNode = document): Element | null {
  for (const selector of SIDEBAR_ANCHORS) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/**
 * The element to insert before, so the card lands above Projects.
 *
 * Matched on text rather than structure because the heading's markup is
 * anonymous but its label is user-visible and therefore stable-ish.
 *
 * The word appears twice in the sidebar: once as a navigation row near the top,
 * and again as the heading of the project list further down. The archive docks
 * Wick above the second one, so that it sits between the navigation and the
 * lists rather than in the middle of the navigation. They are told apart by
 * interactivity — the row is a link or a button, the heading is not — with the
 * later match preferred when that test cannot separate them.
 */
export function findProjectsHeading(anchor: Element): Element | null {
  let fallback: Element | null = null;

  for (const element of anchor.querySelectorAll('*')) {
    if (element.children.length > 0) continue;
    if (element.textContent?.trim() !== PROJECTS_HEADING_TEXT) continue;

    const block = element.closest('div, section, li') ?? element;
    if (element.closest('a, button, [role="link"], [role="button"]') === null) return block;
    fallback = block;
  }

  return fallback;
}
