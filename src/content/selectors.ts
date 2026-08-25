/**
 * Every DOM selector Wick uses against claude.ai, in one file.
 *
 * They live together because they are the most fragile thing in the codebase —
 * claude.ai's markup is a build artifact that can change without any release on
 * our side — and because "add support for a layout change" should be an edit to
 * one file rather than a hunt.
 *
 * **Observed 2026-08-24** against the rendered DOM of a signed-in claude.ai
 * session. The sidebar of that build is:
 *
 *     <aside class="dframe-sidebar" data-variant="web" aria-label="Sidebar">
 *       <div class="dframe-resize-handle">…</div>
 *       <div class="df-titlebar draggable h-11 shrink-0 …">   <!-- logo, /new -->
 *       …
 *       <div data-kind="home-projects" data-testid="sidebar-projects">
 *         <div data-row-key="project:…">…</div>
 *       </div>
 *     </aside>
 *
 * Two things in that are worth writing down, because both invalidate what this
 * file assumed before:
 *
 * 1. **The sidebar is an `aside`, and there is no `nav` inside it.** The whole
 *    navigation is `div`s. Selectors that required a `nav` matched nothing, and
 *    a bare `nav` fallback could only ever have matched something that is not
 *    the sidebar.
 * 2. **The project list carries a test id**, `sidebar-projects`, so the dock
 *    point no longer has to be found by reading text.
 *
 * The class names (`dframe-*`, `df-*`) and the Tailwind utility classes are
 * bundler output and will churn; the `aria-label` and the `data-testid` are the
 * parts worth leaning on. Everything here is still a candidate rather than a
 * guarantee, and nothing is allowed to be load-bearing: if every candidate
 * misses, the card does not mount and the page is untouched. Failing quiet is
 * the rule — Wick is a guest on that page.
 */

/**
 * Where the card docks, tried in order.
 *
 * Ordered most stable first: a test id survives a restyle, then a role plus an
 * accessible name, then a structural tag, and a class name last because it is
 * the thing a build regenerates.
 *
 * There is deliberately no bare `nav` at the end. A fallback that broad cannot
 * distinguish claude.ai's sidebar from any other navigation on the page, and
 * mounting the card somewhere wrong is worse than not mounting it at all —
 * "fail quiet" means rendering nothing, not rendering anywhere.
 */
export const SIDEBAR_ANCHORS = [
  '[data-testid="menu-sidebar"]',
  'aside[aria-label="Sidebar"]',
  'nav[aria-label="Sidebar"]',
  'aside.dframe-sidebar',
  'aside nav',
  'aside',
] as const;

/**
 * The project list, which is what the card docks above.
 *
 * A test id set by claude.ai's own tests: it survives restyles and class
 * renames, which is more than the surrounding markup does.
 */
export const PROJECTS_REGION = '[data-testid="sidebar-projects"]';

/** The same region by its semantic attribute, if the test id is ever dropped. */
export const PROJECTS_REGION_FALLBACK = '[data-kind="home-projects"]';

/**
 * The heading text, for builds that expose neither attribute.
 *
 * Last resort. Text survives almost any refactor but is the least precise thing
 * to match on, and it breaks the moment the interface is translated.
 */
export const PROJECTS_HEADING_TEXT = 'Projects';

/** Id of the host element Wick inserts. Also how it detects it is already mounted. */
export const HOST_ID = 'wick-sidebar-host';

/** Id of the second host, the one the expanded panel renders into. */
export const PANEL_HOST_ID = 'wick-panel-host';

/**
 * The main content frame — everything to the right of the sidebar.
 *
 * Observed 2026-08-25: the new-chat screen puts its composer at
 * `#static-composer`, with `#static-composer-input` inside it, and the whole
 * conversation area sits in the region these select. Ordered by how much of a
 * promise each one is: the `main` landmark is a semantic commitment, the ids are
 * claude.ai's own handles for the composer, and the last is the structural
 * fallback — whatever follows the sidebar.
 */
export const MAIN_ANCHORS = [
  'main',
  '[role="main"]',
  '#static-composer',
  'aside[aria-label="Sidebar"] + *',
] as const;

/**
 * Where the panel's host goes.
 *
 * The sidebar is the one place it cannot go: it is a scroll container, and a
 * panel positioned out of one is clipped by it, which is what made the panel
 * look as though it opened inside the navigation.
 *
 * The panel positions itself against the viewport, so the parent must not be
 * inside a transformed subtree — `transform`, `filter`, `perspective` and
 * `contain` all make a fixed element position against that ancestor instead,
 * which would put the panel somewhere nobody asked for. When the main frame is
 * inside one, `document.body` is used instead: the panel looks identical either
 * way, and being in the right place matters more than being in the right node.
 */
export function findPanelParent(root: Document = document): HTMLElement {
  for (const selector of MAIN_ANCHORS) {
    const found = root.querySelector(selector);
    if (found instanceof HTMLElement && !inPositionedSubtree(found)) return found;
  }
  return root.body;
}

/** Whether any ancestor would capture a fixed child's positioning. */
function inPositionedSubtree(element: Element): boolean {
  try {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.transform !== 'none') return true;
      if (style.filter !== 'none') return true;
      if (style.perspective !== 'none') return true;
      if (style.contain.includes('paint') || style.contain.includes('layout')) return true;
      if (style.willChange.includes('transform') || style.willChange.includes('filter')) {
        return true;
      }
    }
    return false;
  } catch {
    // A page that will not report styles gets the safe parent.
    return true;
  }
}

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
 * Interactive things, and list rows. What tells a list apart from a label.
 */
const ROW_SELECTOR = 'a, button, [role="link"], [role="button"], [data-row-key]';

/**
 * Longest run of text a block can hold and still be a section label.
 *
 * "Projects" is eight characters; a heading with a count beside it is barely
 * more. Anything longer is content, and Wick should not be inserted above it.
 */
const SECTION_LABEL_MAX_CHARS = 40;

/**
 * How far to climb looking for the edge of the projects section.
 *
 * A bound rather than a belief: the wrapper depth is claude.ai's business and
 * can change, but a card that climbed to the top of the sidebar because the
 * test was too permissive would be a worse bug than one that docked too low.
 */
const MAX_CLIMB = 5;

/**
 * The element to insert before, so the card lands above the projects section.
 *
 * Note *section*, not list. `[data-testid="sidebar-projects"]` is the list of
 * project rows; the heading that names it sits outside — as a previous sibling,
 * or one level up. Inserting before the list therefore dropped the card between
 * the heading and the rows, so it read as the first thing *in* Projects rather
 * than as its own row above them.
 *
 * So: find the list, climb to the outermost block that holds it and nothing
 * else of its own, and then step back over the heading if the heading is a
 * sibling of that block. Both moves are guarded — the climb stops the moment a
 * parent brings in other rows (the chat list, the navigation), because carrying
 * on would put Wick above those too.
 *
 * If nothing matches the card still mounts, at the end of the sidebar.
 *
 * The placement this produces is checked in a browser rather than in a unit
 * test — the logic is tree-walking, and the test environment has no DOM. Five
 * shapes were exercised against the built extension: heading as a sibling of
 * the list, heading and list wrapped in a section, heading outside a wrapper,
 * no heading at all, and projects as the only list in the sidebar. All five put
 * the card above the heading and below the chat list.
 */
export function findDockTarget(anchor: Element): Element | null {
  const region =
    anchor.querySelector(PROJECTS_REGION) ?? anchor.querySelector(PROJECTS_REGION_FALLBACK);

  if (region === null) return findProjectsHeading(anchor);

  const section = outermostSection(region, anchor);
  const heading = section.previousElementSibling;

  return heading !== null && isSectionLabel(heading, region) ? heading : section;
}

/** Climb from the list to the block that *is* the projects section. */
function outermostSection(region: Element, anchor: Element): Element {
  let node: Element = region;

  for (let depth = 0; depth < MAX_CLIMB; depth += 1) {
    const parent = node.parentElement;
    if (parent === null || parent === anchor) return node;
    if (!wrapsOnly(parent, region)) return node;
    node = parent;
  }

  return node;
}

/**
 * Whether `parent` contains the project rows and no other list.
 *
 * The test is rows, not text: a parent that also holds the chat list or the
 * navigation is the sidebar's own layout, and inserting above it would move
 * Wick out of the position the design puts it in.
 */
function wrapsOnly(parent: Element, region: Element): boolean {
  for (const row of parent.querySelectorAll(ROW_SELECTOR)) {
    if (!region.contains(row)) return false;
  }
  return true;
}

/** Whether `element` is the label naming the section, rather than content. */
function isSectionLabel(element: Element, region: Element): boolean {
  if (region.contains(element)) return false;
  // A label is not interactive and holds no rows. This is also what keeps the
  // titlebar out: it carries the home link.
  if (element.querySelector(ROW_SELECTOR) !== null) return false;
  if (element.matches(ROW_SELECTOR)) return false;

  const text = element.textContent?.trim() ?? '';
  return text.length > 0 && text.length <= SECTION_LABEL_MAX_CHARS;
}

/**
 * The projects heading, found by its text.
 *
 * Matched on text rather than structure because in older markup the heading was
 * anonymous while its label was user-visible and therefore stable-ish.
 *
 * The word can appear twice in the sidebar: once as a navigation row near the
 * top, and again as the heading of the project list further down. The later one
 * is the one to dock above, so that the card sits between the navigation and
 * the lists rather than in the middle of the navigation. They are told apart by
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
