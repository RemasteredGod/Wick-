/**
 * Whether the expanded panel is open, shared between two render roots.
 *
 * The card lives in claude.ai's sidebar and the panel it opens lives in the main
 * content frame, because the sidebar is a scroll container and anything
 * positioned out of it gets clipped — which is what made the panel appear to
 * open *inside* the navigation. Two places in the page means two Preact roots,
 * and two roots need one piece of shared state.
 *
 * A portal would keep it one tree, but `createPortal` lives in `preact/compat`,
 * and pulling in a compatibility layer to move one boolean across the page is
 * not a trade this project makes — bundle size is a feature. So: a module-level
 * flag, a set of subscribers, and a hook. Twenty lines, no dependency.
 *
 * Module state is the right lifetime here. It lasts exactly as long as the page,
 * which is exactly as long as both roots do.
 */

import { useEffect, useState } from 'preact/hooks';

let open = false;

/** The card in the sidebar. The panel measures its position against this. */
let anchor: HTMLElement | null = null;

const listeners = new Set<() => void>();

function announce(): void {
  // Copied, so a subscriber that unsubscribes while being notified cannot
  // mutate the set being iterated.
  for (const listener of [...listeners]) listener();
}

/** Record the card's host element, so the panel knows where to open beside. */
export function setPanelAnchor(element: HTMLElement | null): void {
  anchor = element;
}

export function panelAnchor(): HTMLElement | null {
  return anchor;
}

export function isPanelOpen(): boolean {
  return open;
}

export function setPanelOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  announce();
}

export function togglePanel(): void {
  setPanelOpen(!open);
}

/** Subscribe to open/close. Returns the unsubscribe. */
export function subscribePanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Read the open state in a component, in either root. */
export function usePanelOpen(): boolean {
  const [value, setValue] = useState(open);

  useEffect(() => {
    const sync = () => setValue(isPanelOpen());
    const unsubscribe = subscribePanel(sync);
    // The flag may have changed between the initial render and this effect.
    sync();
    return unsubscribe;
  }, []);

  return value;
}

/** Forget everything. For tests; the page does this by navigating away. */
export function resetPanelState(): void {
  open = false;
  anchor = null;
  listeners.clear();
}
