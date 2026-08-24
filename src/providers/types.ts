import type { LimitWindow } from '~/core/types';

/**
 * The outcome of one authoritative fetch.
 *
 * Richer than `LimitWindow[]` because "nothing came back" has three different
 * meanings and the collector shows a different thing for each: the user is
 * signed out, the provider is unreachable or has moved its endpoint, or the
 * account genuinely meters nothing. An empty array cannot say which, and
 * guessing produces either a phantom error or a silent wrong reading.
 *
 * No variant is an exception. A provider whose endpoint has moved must degrade
 * into `unavailable`, not throw — the poll loop has to survive being wrong.
 */
export type UsageResult =
  | {
      kind: 'ok';
      windows: LimitWindow[];
      /** Which candidate path answered. Diagnostic only; never displayed. */
      path: string;
    }
  /** The provider refused the credentials. Not an error the user can fix here. */
  | { kind: 'signed-out' }
  /** Reached nothing usable. `message` is short enough to show. */
  | { kind: 'unavailable'; message: string };

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
   * The same fetch, with the reason it failed preserved.
   *
   * Optional so that `fetchUsage` stays the whole contract for a provider that
   * has nothing interesting to say about failure. A provider that implements
   * both must keep them consistent — `fetchUsage` is the lossy view of this.
   */
  fetchUsageResult?(orgId: string): Promise<UsageResult>;

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
   * Extract limit state from a refused send.
   *
   * Separate from `parseStreamEvent` because a refusal is not a stream event
   * and does not share its shape. On plans where a bound window stops producing
   * streams at all, this is the last reading available for that window, so it
   * is worth parsing even though it arrives only on failure.
   */
  parseRefusal?(body: unknown): LimitWindow[] | null;

  /**
   * URL match patterns whose completion means cached state is stale — a plan
   * change, a billing change. Observed headers-only; no body is ever read.
   *
   * Here rather than in the collector because they are provider URLs, and
   * nothing outside this directory may name one.
   */
  invalidationPatterns?: string[];

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
