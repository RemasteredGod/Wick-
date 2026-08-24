/**
 * The only module that performs network I/O or reads cookies.
 *
 * It owns the provider, turns readings into normalised events, and hands them
 * to the store. It knows about claude.ai only through `src/providers/`; it
 * knows nothing about Wick's interface.
 *
 * Status: M3. The provider's network methods throw until M2 has verified
 * docs/protocol.md against live traffic.
 */

import { claudeProvider } from '~/providers/claude';
import type { UsageProvider } from '~/providers/types';

/** Providers Wick collects from. One, for now — see docs/decisions/. */
export const providers: UsageProvider[] = [claudeProvider];
