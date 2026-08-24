/**
 * Toolbar icon rendering.
 *
 * The icon is the primary surface: a gauge whose fill is quota remaining and
 * whose colour is threshold state, so status is readable without clicking. It
 * is drawn to an `OffscreenCanvas` at 16, 32 and 48px and handed to
 * `chrome.action.setIcon` as ImageData.
 *
 * Redraws happen only when the displayed bucket changes — utilization rounded
 * to the nearest 5, or a colour-state transition. Redrawing on every poll costs
 * battery for a difference nobody can see.
 *
 * Status: M5. See the 16px legibility question in docs/design.md.
 */

/** Icon sizes Chrome asks for. */
export const ICON_SIZES = [16, 32, 48] as const;

/** Utilization is bucketed to this granularity before deciding to redraw. */
export const REDRAW_BUCKET_PERCENT = 5;
