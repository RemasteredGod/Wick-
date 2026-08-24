/**
 * Content script: mounts the sidebar card, and bridges the MAIN world to the
 * service worker.
 *
 * Two jobs, both of them guest work on someone else's page:
 *
 * 1. Mount the card into claude.ai's sidebar, inside a shadow root so that
 *    nothing leaks in either direction.
 * 2. Inject the MAIN-world fetch wrapper and relay what it observes to the
 *    service worker. An isolated-world script cannot see the page's `fetch`,
 *    and MV3's webRequest cannot read response bodies, so the wrapper has to
 *    run in the page and talk back through `postMessage`.
 *
 * The governing rule, from the design archive's own principles: **fail quiet.**
 * If the anchor is missing, if the markup has moved, if anything throws — Wick
 * renders nothing and the page is exactly as it was. Breaking claude.ai to
 * report on claude.ai is not a trade worth making.
 *
 * Status: M1 mounts the card with placeholder data. The bridge is M3.
 */

import { h, render } from 'preact';
import { SidebarCard } from './SidebarCard';
import { ANCHOR_TIMEOUT_MS, HOST_ID, findAnchor, findProjectsHeading } from './selectors';
import {
  PLACEHOLDER_PLAN,
  PLACEHOLDER_TELEGRAM,
  placeholderHistory,
  placeholderProjection,
  placeholderWindows,
} from '~/popup/placeholder';
import tokens from '~/styles/tokens.css?inline';
import components from '~/styles/components.css?inline';
import sidebar from './sidebar.css?inline';

/**
 * `tokens.css` declares its variables on `:root`, which inside a shadow root
 * resolves to the shadow host and not to `document`. Rewriting the selector on
 * the way in is what lets one token file serve both surfaces.
 */
const SHADOW_STYLES = [tokens.replaceAll(':root', ':host'), components, sidebar].join('\n');

function mount(anchor: Element): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // The sidebar is a flow of navigation rows; the card is one more of them.
  host.style.padding = '0 12px';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SHADOW_STYLES;
  shadow.append(style);

  const root = document.createElement('div');
  shadow.append(root);

  const projects = findProjectsHeading(anchor);
  if (projects?.parentElement) {
    projects.parentElement.insertBefore(host, projects);
  } else {
    anchor.append(host);
  }

  const now = Date.now();
  render(
    h(SidebarCard, {
      windows: placeholderWindows(now),
      history: placeholderHistory(now),
      projection: placeholderProjection(now),
      plan: PLACEHOLDER_PLAN,
      telegram: PLACEHOLDER_TELEGRAM,
      now,
    }),
    root,
  );
}

/**
 * Wait for the sidebar to exist.
 *
 * claude.ai renders its navigation after first paint, so looking once at
 * `document_idle` finds nothing. The observer gives up after a timeout rather
 * than watching the whole session: a page that never grows an anchor is a page
 * Wick does not belong on, and an observer left running on every mutation is
 * rude.
 */
function waitForAnchor(): void {
  const immediate = findAnchor();
  if (immediate) {
    mount(immediate);
    return;
  }

  const observer = new MutationObserver(() => {
    const anchor = findAnchor();
    if (!anchor) return;
    observer.disconnect();
    clearTimeout(timer);
    safely(() => mount(anchor));
  });

  const timer = setTimeout(() => observer.disconnect(), ANCHOR_TIMEOUT_MS);
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Run `work`, and swallow whatever it throws. Guest rules. */
function safely(work: () => void): void {
  try {
    work();
  } catch {
    // Intentionally silent. A failure here must not surface on claude.ai, and
    // there is nothing the user could do about it.
  }
}

safely(waitForAnchor);
