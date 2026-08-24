/**
 * Shared vocabulary for every layer.
 *
 * Nothing here names a provider, an endpoint, or a wire field. Providers
 * translate their own shapes into these types at the boundary; everything
 * downstream — store, projection, interface — speaks only this dialect. That is
 * what makes adding a second provider a new file rather than a refactor.
 */

/**
 * How a limit window is behaving, as reported by the provider.
 *
 * This is deliberately separate from the percentage. A window can sit below
 * 100% and still be refusing sends, and when the two disagree the status is the
 * one that matches what the user is experiencing. See docs/protocol.md.
 */
export type LimitStatus =
  /** Accepting requests normally. */
  | 'ok'
  /** Accepting requests, but the provider has flagged it as near its bound. */
  | 'approaching'
  /** Bound. Sends are being refused regardless of what the number says. */
  | 'exceeded'
  /** The provider did not tell us. Never treat this as 'ok'. */
  | 'unknown';

/**
 * A single limit window — a five-hour session, a weekly allowance, whatever the
 * provider meters.
 */
export interface LimitWindow {
  /**
   * Provider-defined identifier, opaque to everything outside src/providers/.
   * Stable across polls, because history is keyed on it.
   */
  key: string;
  /** Display name, supplied by the provider. Sentence case. */
  label: string;
  /**
   * Shorter name for the collapsed sidebar card, where the archive drops the
   * qualifier — "Session" rather than "Session · 5 hr". Supplied by the
   * provider rather than derived by trimming, because only the provider knows
   * which part of its own label is the qualifier.
   */
  shortLabel: string;
  /**
   * Percentage of the window consumed, 0–100.
   *
   * `null` means the provider did not report it. Render that as "unknown" —
   * never as zero. A confident wrong number is worse than an honest gap.
   */
  utilization: number | null;
  status: LimitStatus;
  /** Epoch milliseconds, normalised from whatever the provider sent. */
  resetsAt: number | null;
  /** Whether this window is currently metering anything. */
  active: boolean;
}

/** Where a reading came from. Lower trust than `usage` never overwrites it. */
export type SnapshotSource =
  /** The authoritative usage endpoint. Wins unconditionally. */
  | 'usage'
  /** The tail of a completion stream. Optimistic, 1–2 seconds early. */
  | 'stream'
  /** A refusal response. Sometimes the last reading available for a window. */
  | 'rejection';

/** The latest known state, as displayed. One per provider. */
export interface Snapshot {
  providerId: string;
  windows: LimitWindow[];
  /** Epoch milliseconds when this reading was taken. */
  fetchedAt: number;
  source: SnapshotSource;
}

/**
 * One day of history. Append-only, and impossible to reconstruct after the
 * fact — which is why Wick writes these from its first release, before
 * anything reads them.
 */
export interface DailyRollup {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /**
   * Highest utilization observed in each window that day, keyed by
   * `LimitWindow.key`. Peak rather than final, because a window that reset
   * mid-day would otherwise erase its own evidence.
   */
  windows: Record<string, number>;
  /** Messages sent that day, counted from completion events. */
  messageCount: number;
}

/**
 * How much weight to put on a projection.
 *
 * Confidence is reported rather than hidden, because the honest answer early on
 * is "not enough history yet", and saying so is better than guessing
 * authoritatively.
 */
export type ProjectionConfidence = 'none' | 'low' | 'medium' | 'high';

/** The output of the projection engine. The product, in three fields. */
export interface Projection {
  /**
   * Epoch milliseconds at which the window is expected to be exhausted, or
   * `null` if it is not expected to be exhausted before it resets — or if
   * there is not enough evidence to say.
   */
  exhaustionEstimate: number | null;
  confidence: ProjectionConfidence;
  /** Percentage points consumed per day at the current pace. `null` if unknown. */
  pace: number | null;
  /**
   * Why the confidence is what it is, in a few words. Shown to the user when
   * confidence is low, so "we don't know" comes with a reason.
   */
  reason: string;
}

/**
 * Display state for a window.
 *
 * Drives colour, and nothing else drives colour. The warn and crit colours are
 * reserved for this — if they show up decoratively, the warning stops meaning
 * anything.
 */
export type ThresholdState = 'ok' | 'warn' | 'crit' | 'unknown';

/**
 * Boundaries between threshold states, in percent.
 *
 * The design archive does not specify these; it shows one warn instance at 82%,
 * which is consistent with the band below. See docs/design.md.
 */
export const THRESHOLDS = {
  /** At or above this, a window is warning. */
  warn: 70,
  /** Above this, a window is critical. */
  crit: 90,
} as const;
