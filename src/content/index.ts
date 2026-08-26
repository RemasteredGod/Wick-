/**
 * Content script: mounts the sidebar card, and bridges the MAIN world to the
 * service worker.
 *
 * Two jobs, both of them guest work on someone else's page:
 *
 * 1. Mount the card into claude.ai's sidebar, inside a shadow root so that
 *    nothing leaks in either direction.
 * 2. Bridge messages from the separately registered MAIN-world fetch wrapper
 *    to the service worker. An isolated-world script cannot see the page's
 *    `fetch`, and MV3's webRequest cannot read response bodies, so the wrapper
 *    runs in the page world and talks back through `postMessage`.
 *
 * The governing rule, from the design archive's own principles: **fail quiet.**
 * If the anchor is missing, if the markup has moved, if anything throws — Wick
 * renders nothing and the page is exactly as it was. Breaking claude.ai to
 * report on claude.ai is not a trade worth making.
 */

import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { project } from '~/core/projection';
import { allowanceWindow } from '~/core/windows';
import { useWickState } from '~/popup/useWickState';
import { SidebarCard } from './SidebarCard';
import { UsagePanel } from './UsagePanel';
import { initBridge } from './bridge';
import { setPanelAnchor } from './panel';
import {
  ANCHOR_TIMEOUT_MS,
  HOST_ID,
  PANEL_HOST_ID,
  findAnchor,
  findDockTarget,
  findPanelParent,
  findUserEmail,
} from './selectors';
import tokens from '~/styles/tokens.css?inline';
import components from '~/styles/components.css?inline';
import sidebar from './sidebar.css?inline';

/**
 * `tokens.css` declares its variables on `:root`, which inside a shadow root
 * resolves to the shadow host and not to `document`. Rewriting the selector on
 * the way in is what lets one token file serve both surfaces.
 */
const SHADOW_STYLES = [tokens.replaceAll(':root', ':host'), components, sidebar].join('\n');

/**
 * The two surfaces, wired to the store.
 *
 * Presentation reads from storage and never fetches — the same hook the popup
 * uses, because every surface shows the same numbers and there is no second
 * source for them to disagree from.
 *
 * Until the first read lands they render nothing rather than a row of zeros. An
 * empty sidebar for a few milliseconds is invisible; a card that says 0% and
 * then jumps is not.
 *
 * They are two roots in two places on the page, not one tree: the card belongs
 * in the sidebar and the panel cannot be, because the sidebar clips it. What
 * they share is one boolean, in `./panel`.
 */
function useSurfaceState() {
  const { state, ready, update } = useWickState();
  const [now] = useState(() => Date.now());

  const windows = ready ? (state.snapshot?.windows ?? []) : [];
  const weekly = allowanceWindow(windows) ?? undefined;
  const projection =
    weekly === undefined ? null : project({ window: weekly, history: state.history, now });

  return { state, windows, projection, update, now };
}

function Card() {
  const { state, windows, now } = useSurfaceState();

  if (windows.length === 0) return null;

  return h(SidebarCard, { windows, settings: state.settings, now });
}

function Panel() {
  const { state, windows, projection, update, now } = useSurfaceState();

  return h(UsagePanel, {
    windows,
    history: state.history,
    projection,
    settings: state.settings,
    onChange: update,
    now,
  });
}

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

  // Above the project list when it can be found, at the end of the sidebar when
  // it cannot. Both are inside the sidebar; neither can land on the page proper.
  const dock = findDockTarget(anchor);
  if (dock?.parentElement) {
    dock.parentElement.insertBefore(host, dock);
  } else {
    anchor.append(host);
  }

  // The panel measures its position against this element, from the other root.
  setPanelAnchor(host);

  render(h(Card, {}), root);
  mountPanel();
}

/**
 * Mount the panel's own root, in the main content frame.
 *
 * A second host rather than a second element in the sidebar's tree: the
 * sidebar scrolls, and anything positioned out of a scroll container is clipped
 * by it — which is what made the panel appear to open inside the navigation.
 *
 * The host itself is a zero-sized fixed box. It contributes no layout to
 * claude.ai's own flexbox, and the panel inside it positions against the
 * viewport. Guest rules: mounting a surface into someone's application must not
 * move their application.
 */
function mountPanel(): void {
  if (document.getElementById(PANEL_HOST_ID)) return;

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '0';
  host.style.height = '0';
  host.style.zIndex = '2147483000';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SHADOW_STYLES;
  shadow.append(style);

  const root = document.createElement('div');
  shadow.append(root);

  findPanelParent().append(host);
  render(h(Panel, {}), root);
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

// The bridge does not depend on the card: limits observed on the wire are worth
// forwarding whether or not the sidebar has an anchor to mount into.
safely(initBridge);

// Neither does the account. It used to be started from `mount`, which made
// knowing who is signed in conditional on the sidebar card having found an
// anchor and mounted — so a layout Wick cannot dock into, a mount that bailed
// because its host element already existed, or simply the fifteen-second anchor
// timeout all left the worker with no way to read the account and no way to ask
// for it. Joining the board then failed on a page that was showing the address
// the whole time.
safely(watchAccount);

safely(waitForAnchor);

/**
 * Tell the worker which Claude account is signed in, and notice when it changes.
 *
 * The board keys a public profile on the account, so this is what makes one
 * account one profile across every browser — and what stops a day being
 * published under the wrong profile after somebody switches accounts.
 *
 * Polled rather than observed. `MutationObserver` on a React app that re-renders
 * its sidebar constantly would fire hundreds of times a minute to answer a
 * question whose answer changes at most once a session, and every one of those
 * callbacks runs on claude.ai's own main thread. A read every few seconds costs
 * one `querySelector` and is bounded whatever the page does.
 *
 * **Sent only when it changes.** The worker writes to storage on receipt, and
 * every storage write wakes the icon renderer and the alert dispatcher; a
 * message per tick would wake them for news that is not news.
 *
 * Fail quiet, like everything else in this file. Wick is a guest on someone
 * else's page and not knowing the account is a state the board already handles.
 */
function watchAccount(): void {
  let last: string | null = null;

  // Answer the worker when it asks directly. Join is pressed in the popup, which
  // cannot read this page — so without this the worker's only source is the poll
  // below, and pressing Join in the first few seconds after an install reports
  // the board as unreachable when nothing is wrong with it.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: unknown } | null)?.type !== 'wick:read-account') return false;

    try {
      sendResponse({ ok: true, email: findUserEmail() });
    } catch {
      sendResponse({ ok: true, email: null });
    }
    // Answered synchronously; nothing to hold the channel open for.
    return false;
  });

  const check = () => {
    try {
      const email = findUserEmail();
      if (email === null || email === last) return;

      last = email;
      void chrome.runtime.sendMessage({ type: 'wick:account-email', email }).catch(() => undefined);
    } catch {
      // A worker that has been torn down and is still waking rejects the send.
      // The next tick tries again.
    }
  };

  check();
  setInterval(check, ACCOUNT_POLL_MS);
}

/**
 * How often to re-read the account from the sidebar.
 *
 * The user menu is rendered after first paint and the address can appear a
 * moment after the card mounts, so this is also the retry for "not there yet".
 * Five seconds is far below how often anyone switches accounts and far above
 * how often a `querySelector` costs anything.
 */
const ACCOUNT_POLL_MS = 5_000;
