/**
 * The panel's shared open state, and where it opens.
 *
 * The card and the panel are two Preact roots in two places on the page — the
 * sidebar clips anything positioned out of it, so the panel cannot live there.
 * What they share is one boolean and one measurement, and both are plain
 * functions, so both are testable without a DOM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPanelOpen,
  panelAnchor,
  resetPanelState,
  setPanelAnchor,
  setPanelOpen,
  subscribePanel,
  togglePanel,
} from '~/content/panel';
import { positionBeside } from '~/content/UsagePanel';

afterEach(() => {
  resetPanelState();
});

describe('shared open state', () => {
  it('starts closed', () => {
    expect(isPanelOpen()).toBe(false);
  });

  it('toggles', () => {
    togglePanel();
    expect(isPanelOpen()).toBe(true);
    togglePanel();
    expect(isPanelOpen()).toBe(false);
  });

  it('tells both roots when it changes', () => {
    const card = vi.fn();
    const panel = vi.fn();
    subscribePanel(card);
    subscribePanel(panel);

    setPanelOpen(true);

    // The card draws its chevron from this and the panel draws its existence
    // from it. One of them missing the change is a chevron pointing the wrong
    // way at an open panel.
    expect(card).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the state does not actually change', () => {
    const listener = vi.fn();
    subscribePanel(listener);

    setPanelOpen(false);

    expect(listener).not.toHaveBeenCalled();
  });

  it('lets a listener unsubscribe while being notified', () => {
    const listener = vi.fn(() => unsubscribe());
    const unsubscribe = subscribePanel(listener);

    expect(() => setPanelOpen(true)).not.toThrow();
  });

  it('remembers the card the panel opens beside', () => {
    const card = { id: 'card' } as unknown as HTMLElement;
    setPanelAnchor(card);
    expect(panelAnchor()).toBe(card);
  });
});

/* ---- Placement ----------------------------------------------------------- */

/** A card at a given box, as `getBoundingClientRect` would report it. */
function cardAt(box: { top: number; right: number; width?: number; height?: number }) {
  return {
    getBoundingClientRect: () => ({
      top: box.top,
      right: box.right,
      width: box.width ?? 260,
      height: box.height ?? 64,
    }),
  } as unknown as HTMLElement;
}

const VIEWPORT = { width: 1440, height: 900 };

describe('positionBeside', () => {
  it('opens a gap to the right of the card, level with its top', () => {
    const position = positionBeside(cardAt({ top: 200, right: 290 }), VIEWPORT);

    expect(position).toMatchObject({ left: 302, top: 200 });
  });

  it('measures the sidebar rather than assuming its width', () => {
    // The archive's left:302px is a coordinate on a canvas. A user who has
    // dragged their sidebar wider gets the panel beside it, not over it.
    const wide = positionBeside(cardAt({ top: 100, right: 420 }), VIEWPORT);

    expect(wide?.left).toBe(432);
  });

  it('keeps the panel on screen in a narrow window', () => {
    const narrow = positionBeside(cardAt({ top: 100, right: 700 }), { width: 820, height: 900 });

    expect(narrow?.left).toBeLessThanOrEqual(820 - 280 - 12);
    expect(narrow?.maxWidth).toBeGreaterThanOrEqual(280);
  });

  it('does not push the panel off the bottom when the card sits low', () => {
    const low = positionBeside(cardAt({ top: 870, right: 290 }), VIEWPORT);

    expect(low?.top).toBeLessThanOrEqual(900 - 240);
    expect(low?.maxHeight).toBeGreaterThanOrEqual(240);
  });

  it('never places the panel above the top edge', () => {
    const high = positionBeside(cardAt({ top: -40, right: 290 }), VIEWPORT);

    expect(high?.top).toBe(12);
  });

  it('falls back to the edge when the card has no box to measure', () => {
    // A collapsed or hidden sidebar. Opening at 0,0 would put the panel under
    // the navigation, which is the bug this whole arrangement exists to fix.
    const hidden = positionBeside(cardAt({ top: 0, right: 0, width: 0, height: 0 }), VIEWPORT);

    expect(hidden).toMatchObject({ top: 12, left: 12 });
  });

  it('has nothing to say when there is no card at all', () => {
    expect(positionBeside(null, VIEWPORT)).toBeNull();
  });
});
