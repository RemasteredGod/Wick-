/**
 * Toolbar icon rendering.
 *
 * The icon is the primary surface: a gauge whose fill is quota remaining and
 * whose colour is threshold state, so status is readable without clicking.
 */

/** Icon sizes Chrome asks for. */
export const ICON_SIZES = [16, 32, 48] as const;

/** Utilization is bucketed to this granularity before deciding to redraw. */
export const REDRAW_BUCKET_PERCENT = 5;

/** Subscribe to snapshot changes and keep the toolbar icon in step. */
export function initIcon(): void {
  // M5.
}
