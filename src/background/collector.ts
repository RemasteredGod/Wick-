/**
 * The only module that performs network I/O or reads cookies.
 *
 * It owns the providers, turns readings into normalised snapshots, and writes
 * them to the store. It knows about claude.ai only through `src/providers/`;
 * it knows nothing about Wick's interface.
 */

import { claudeProvider } from '~/providers/claude';
import type { UsageProvider } from '~/providers/types';

/** Providers Wick collects from. One, for now — see docs/decisions/. */
export const providers: UsageProvider[] = [claudeProvider];

/** Register every listener the collector needs. Called once, synchronously. */
export function initCollector(): void {
  // M3.
}

/** Poll every provider now and write what comes back. */
export async function poll(_reason: string): Promise<void> {
  // M3.
}
