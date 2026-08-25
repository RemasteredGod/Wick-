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
 * What a window *is*, independent of what the provider calls it or where it
 * appeared in a response.
 *
 * Presentation needs to pick "the window the forecast is about" and alerts need
 * to pick "the one the threshold applies to". Both used to do it by array index,
 * which is a promise claude.ai never made: it can reorder its own response, and
 * a plan with model-scoped weeklies has more than two entries. The provider
 * classifies once, at the boundary, and everything downstream selects by meaning.
 */
export type WindowRole =
  /** The short rolling window — claude.ai's five hours. */
  | 'session'
  /** The account-wide weekly allowance. At most one of these. */
  | 'weekly'
  /** A weekly allowance scoped to one model. There can be several. */
  | 'weekly-model'
  /** Metered usage beyond the plan. */
  | 'overage'
  /** Something new the provider started reporting. Tracked, never featured. */
  | 'other';

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
  /** What this window means. Assigned by the provider; see `WindowRole`. */
  role: WindowRole;
  /**
   * Which model or feature the window is scoped to, when `role` is
   * `'weekly-model'`. Display only — the scope is already folded into `key`,
   * because two windows that share a key share a history and a projection.
   */
  scope?: string;
  /**
   * Where this particular window's numbers came from, and when.
   *
   * Stamped by the store as it merges, never set by a provider: a provider
   * reports what it read, and only the store knows which reading it was. They
   * are per-window rather than per-snapshot because a snapshot can hold a fresh
   * authoritative weekly beside a session window last seen on a stream — and
   * merging honestly means being able to say which is which.
   */
  source?: SnapshotSource;
  /** Epoch milliseconds when this window was observed. Stamped by the store. */
  observedAt?: number;
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
  /**
   * Which account these numbers belong to — claude.ai's organisation id.
   *
   * Without it, switching organisations shows one account's limits under the
   * other's name until the next poll lands, and there is no way for the store to
   * know that a merge would be mixing two accounts' readings. `null` means the
   * reading predates account tagging, or the provider could not identify one.
   */
  accountId: string | null;
  windows: LimitWindow[];
  /** Epoch milliseconds when this reading was taken. */
  fetchedAt: number;
  /**
   * The source of the most recent reading folded into this snapshot. Individual
   * windows carry their own, which is the one to trust when they differ.
   */
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
   * The account this day belongs to. Absent on rollups written before Wick
   * tracked accounts, which are shown to whoever is signed in — there was only
   * ever one account writing them.
   *
   * A rollup is identified by date *and* account: two organisations used on the
   * same day are two rows, because merging them would invent a day neither
   * account had.
   */
  accountId?: string;
  /**
   * Highest utilization observed in each window that day, keyed by
   * `LimitWindow.key`. Peak rather than final, because a window that reset
   * mid-day would otherwise erase its own evidence.
   */
  windows: Record<string, number>;
  /** Messages sent that day, counted from completion events. */
  messageCount: number;
  /**
   * Messages per hour of the local day, 24 entries, index 0 = midnight.
   *
   * Kept because "peak hr" is on the panel and there is no other source for it
   * — docs/protocol.md §"What the protocol does not give you" rules out
   * anything finer. Costs 24 small integers a day.
   */
  hourlyMessages: number[];
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

/** Which day-parts and windows the user wants shown. Archive artboard 03. */
export interface DisplayOptions {
  session: boolean;
  weekly: boolean;
  forecast: boolean;
  sparkline: boolean;
}

/**
 * User settings.
 *
 * `botToken` is a Telegram bot token, and it is here deliberately.
 * `chrome.storage.local` is plain JSON on disk, so this is not a vault — but
 * the bot it governs was created by this user and talks to nobody but them,
 * they revoke it themselves in @BotFather, and anyone able to read this file
 * can already read the claude.ai session cookies beside it.
 * See docs/decisions/0009-per-user-bot-tokens.md, which supersedes ADR 0002 for
 * alerts and explains why that record's reasoning did not survive the move to
 * per-user bots.
 */
export interface Settings {
  /** Weekly percentage at which an alert fires. Archive offers 50/80/90/95. */
  alertThreshold: number;
  /** Also send a message when a window rolls over. */
  alertOnReset: boolean;
  display: DisplayOptions;
  /** The user's own bot token, or null when alerts are not set up. */
  botToken: string | null;
  /** The chat alerts go to. Discovered, never typed — see background/telegram.ts. */
  chatId: number | null;
  /** Human label for where alerts land, for display only. */
  chatLabel: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  alertThreshold: 80,
  alertOnReset: true,
  display: { session: true, weekly: true, forecast: true, sparkline: true },
  botToken: null,
  chatId: null,
  chatLabel: null,
};

/** Thresholds the settings screen offers. From artboard 03. */
export const ALERT_THRESHOLD_CHOICES = [50, 80, 90, 95] as const;

/** How collection last went. Presentation shows this instead of inventing numbers. */
export type CollectorStatus =
  | { kind: 'never-run' }
  /** No organisation cookie. The user is signed out of claude.ai. */
  | { kind: 'signed-out' }
  | { kind: 'ok'; at: number }
  | { kind: 'error'; message: string; at: number };

/** Everything presentation reads. Assembled by the store, never fetched. */
export interface WickState {
  snapshot: Snapshot | null;
  history: DailyRollup[];
  settings: Settings;
  status: CollectorStatus;
}

/** Why an alert was sent. */
export type AlertKind = 'threshold' | 'window-reset' | 'weekly-summary';

/**
 * An alert that has already gone out.
 *
 * `cycleKey` is what stops Wick sending the same warning every poll: it
 * identifies the *cycle* of a window (its reset time), so crossing 80% once
 * sends one message, and the next one cannot fire until the window has rolled
 * over. A tracker that spams is a tracker you mute.
 */
export interface AlertRecord {
  kind: AlertKind;
  windowKey: string;
  cycleKey: string;
  at: number;
}
