import type { LimitWindow } from '~/core/types';

/**
 * The contract every provider implements.
 *
 * v1 ships one provider. The interface exists anyway, because the difference
 * between "add Gemini" being one new file and being a refactor is decided now,
 * not later — once collector code starts reaching for claude.ai field names
 * directly, the boundary is gone and no amount of intent brings it back.
 *
 * Everything Claude-specific — endpoint paths, cookie names, wire field names,
 * window keys like the five-hour session — lives behind this interface. Nothing
 * outside src/providers/ may reference any of it.
 */
export interface UsageProvider {
  /** Stable identifier, used as a storage key. Never displayed. */
  id: string;
  /** Name shown in the interface. Sentence case. */
  displayName: string;
  /**
   * Host match patterns this provider owns. The manifest's own patterns are
   * declared separately and must stay in sync — the manifest is what Chrome
   * enforces, this is what the collector uses to decide whether a tab is
   * relevant.
   */
  matchPatterns: string[];

  /**
   * Fetch the authoritative current state.
   *
   * Resolves to an empty array when the provider has nothing to report — a
   * signed-out user, say. Rejects only on genuine transport failure; a
   * malformed response should come back as windows with `null` utilization and
   * `'unknown'` status rather than an exception, because a shape change must
   * degrade the display and not break the poll loop.
   */
  fetchUsage(orgId: string): Promise<LimitWindow[]>;

  /**
   * Extract limit state from one event observed on the wire.
   *
   * Returns `null` for every event that does not carry limit state, which is
   * almost all of them. Must never throw: it runs against a stream of
   * undocumented shapes.
   *
   * What this produces is optimistic — it lands a second or two before an
   * authoritative fetch would. When the fetch arrives it wins unconditionally.
   */
  parseStreamEvent(event: unknown): LimitWindow[] | null;

  /**
   * Identify the account whose limits should be shown.
   *
   * Separate from `fetchUsage` because how you learn the account differs
   * sharply between providers — a cookie here, a request header or an in-page
   * value elsewhere — while fetching, once you know it, does not.
   *
   * Resolves to `null` when no account can be identified, which usually means
   * the user is signed out.
   */
  resolveAccountId(): Promise<string | null>;
}

/** Thrown by provider methods that are declared but not yet built. */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplemented';
  }
}
