/**
 * Threshold alerts, as local notifications.
 *
 * Three message types, at most one per event — a threshold crossing, a window
 * rolling over, and a weekly summary. That ceiling is the feature: a tracker
 * that spams is a tracker you mute, and an alert channel the user has muted is
 * worth less than no alert channel at all.
 *
 * The ceiling is enforced by `AlertRecord.cycleKey` rather than by comparing
 * consecutive snapshots. A service worker is torn down between events, so
 * "was it below the threshold last time?" is a question this module frequently
 * cannot answer — but "has a message already gone out for this window's current
 * cycle?" is answerable from storage every time.
 *
 * **One channel, and it needs no network.** Alerts are `chrome.notifications`
 * and nothing else. There was a Telegram path here; it is gone, along with the
 * optional host permission it needed. Everything below composes a string and
 * hands it to Chrome, so an alert cannot fail for a reason the user has to
 * diagnose.
 *
 * Nothing in this file may throw into the service worker.
 */

import { field, localDateKey } from '~/core/normalise';
import { project } from '~/core/projection';
import { allowanceWindow } from '~/core/windows';
import type {
  AlertKind,
  AlertRecord,
  DailyRollup,
  LimitStatus,
  LimitWindow,
  Projection,
  Settings,
  WindowRole,
} from '~/core/types';
import {
  KEYS,
  readAccountId,
  readAlerts,
  readHistory,
  readSettings,
  recordAlert,
} from './store';

/** Packaged unknown-state mark for local notifications. */
const NOTIFICATION_ICON = 'icons/128.png';

/** Days of history a weekly summary looks back over. */
const SUMMARY_DAYS = 7;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Subscribe to snapshot changes.
 *
 * One registration. Every alert is a reaction to a snapshot the collector
 * wrote, so this module never has to be called by anything — it watches the
 * store, which is the same seam the icon renderer uses.
 */
export function initAlerts(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const change = changes[KEYS.snapshot];
    if (change === undefined) return;

    // Deliberately not awaited, and its rejection is deliberately swallowed: an
    // error escaping a storage listener takes the worker down with it, and a
    // missed alert is a smaller failure than a dead collector.
    void evaluateSnapshotChange(change.oldValue, change.newValue, Date.now());
  });
}

/**
 * Decide what a snapshot change is worth telling the user, and tell them.
 *
 * Exported so the decision can be tested without going through storage and a
 * timer. `before` and `after` are whatever was in storage — arbitrary values,
 * possibly written by an older version, possibly nonsense.
 */
export async function evaluateSnapshotChange(
  before: unknown,
  after: unknown,
  now: number,
): Promise<void> {
  try {
    const next = readWindows(after);
    if (next.length === 0) return;

    const previous = readWindows(before);
    const settings = await readSettings();
    // The signed-in account's own record. An alert about this week's pace must
    // not be computed from another organisation's week.
    const history = await readHistory(await readAccountId());

    const pending = [
      ...thresholdAlerts(next, settings, history, now),
      ...rolloverAlerts(previous, next, settings, history, now),
    ];
    if (pending.length === 0) return;

    const sent = (await readAlerts()).filter(isAlertRecord);
    const seen = new Set(sent.map(identity));

    for (const alert of pending) {
      if (seen.has(identity(alert))) continue;
      seen.add(identity(alert));
      await dispatch(alert, now);
    }
  } catch {
    // See initAlerts. Every path into this module is a browser event, and none
    // of them has anywhere to report a failure to.
  }
}

/* ---- What to send -------------------------------------------------------- */

interface PendingAlert {
  kind: AlertKind;
  windowKey: string;
  cycleKey: string;
  /** The whole message, exactly as it lands in the notification. */
  text: string;
}

/** `kind` and `cycleKey` together are the de-duplication key. */
function identity(alert: { kind: AlertKind; cycleKey: string }): string {
  return `${alert.kind}|${alert.cycleKey}`;
}

/**
 * Identify a window's current cycle.
 *
 * A cycle is bounded by the reset that ends it, so the reset time *is* the
 * cycle identifier — when the window rolls over, `resetsAt` moves and the key
 * changes, which is precisely when a second message becomes legitimate.
 *
 * When the provider did not tell us the reset time there is no cycle to key on,
 * and the fallback is the local date: at worst one message per window per day,
 * which is a defensible ceiling for a window whose shape we cannot see.
 */
export function cycleKeyFor(window: LimitWindow, now: number): string {
  return window.resetsAt === null
    ? `${window.key}@day:${localDateKey(now)}`
    : `${window.key}@${window.resetsAt}`;
}

/**
 * The threshold crossing, evaluated against the weekly window only.
 *
 * `Settings.alertThreshold` is documented as a weekly percentage, and the
 * archive's message says "Weekly usage 80%". The session window turns over
 * every few hours; a warning about it would fire several times a day and mean
 * nothing by the end of the week.
 */
function thresholdAlerts(
  windows: LimitWindow[],
  settings: Settings,
  history: DailyRollup[],
  now: number,
): PendingAlert[] {
  const weekly = weeklyWindow(windows);
  if (weekly === null) return [];

  const utilization = weekly.utilization;
  // Status outranks the number at the boundary: a window that is refusing sends
  // is worth a message even if it reports 97%. See AGENTS.md.
  const crossed =
    weekly.status === 'exceeded' ||
    (utilization !== null && utilization >= settings.alertThreshold);
  if (!crossed) return [];

  const projection = projectSafely(weekly, history, now);

  return [
    {
      kind: 'threshold',
      windowKey: weekly.key,
      cycleKey: cycleKeyFor(weekly, now),
      text: thresholdMessage(weekly, projection, now),
    },
  ];
}

/**
 * Windows that rolled over between the two snapshots.
 *
 * A rollover is a reset time moving forward. Utilization dropping is not the
 * test — a stream reading can arrive out of order and drag a number backwards
 * without any window having reset.
 */
function rolloverAlerts(
  previous: LimitWindow[],
  next: LimitWindow[],
  settings: Settings,
  history: DailyRollup[],
  now: number,
): PendingAlert[] {
  if (!settings.alertOnReset) return [];

  const weekly = weeklyWindow(next);
  const out: PendingAlert[] = [];

  for (const window of next) {
    const before = previous.find((candidate) => candidate.key === window.key);
    if (before === undefined) continue;
    if (before.resetsAt === null || window.resetsAt === null) continue;
    if (window.resetsAt <= before.resetsAt) continue;

    // The weekly rollover is the moment the summary is worth reading, so it
    // carries the summary instead of the bare "window reset" line. Same event,
    // one message, as the archive shows it.
    const isWeekly = weekly !== null && weekly.key === window.key;

    out.push({
      kind: isWeekly ? 'weekly-summary' : 'window-reset',
      windowKey: window.key,
      cycleKey: cycleKeyFor(window, now),
      text: isWeekly ? weeklySummaryMessage(history, now) : resetMessage(window),
    });
  }

  return out;
}

/**
 * Which window the threshold applies to.
 *
 * The shared selector, so the alert is about the same window the panel is
 * forecasting — two different answers to "which one is the weekly" is a bug
 * report waiting to happen. It prefers the role the provider assigned and falls
 * back to the structural test this used to do alone: the active window that
 * resets furthest out is the weekly one for any provider that meters this way.
 *
 * Re-exported rather than inlined at the call sites because it is part of this
 * module's tested surface.
 */
export function weeklyWindow(windows: LimitWindow[]): LimitWindow | null {
  return allowanceWindow(windows);
}

/* ---- Copy ---------------------------------------------------------------- *
 * Terse and factual, following artboard 04. The headline is a sentence; the
 * detail line is lower case, the way the archive sets it in mono.             */

/** "Weekly usage 80% — 4 days to reset." plus the pace line, when there is one. */
export function thresholdMessage(
  window: LimitWindow,
  projection: Projection,
  now: number,
): string {
  const headline = `${window.shortLabel} ${usagePhrase(window)}${resetClause(window.resetsAt, now)}.`;
  const detail = paceLine(projection, now);
  return detail === '' ? headline : `${headline}\n${detail}`;
}

/** "Session window reset. 0% used." */
export function resetMessage(window: LimitWindow): string {
  const utilization = window.utilization;
  if (utilization === null) return `${window.shortLabel} window reset.`;
  return `${window.shortLabel} window reset. ${Math.round(utilization)}% used.`;
}

/** "Weekly reset. Last week: 196 messages, peak Wednesday." */
export function weeklySummaryMessage(history: DailyRollup[], now: number): string {
  const week = summariseWeek(history, now);

  if (week.messages === 0) return 'Weekly reset. No messages recorded last week.';
  const count = `${week.messages} ${week.messages === 1 ? 'message' : 'messages'}`;
  if (week.peakDay === null) return `Weekly reset. Last week: ${count}.`;
  return `Weekly reset. Last week: ${count}, peak ${week.peakDay}.`;
}

function usagePhrase(window: LimitWindow): string {
  if (window.utilization === null) {
    // The provider said the window is bound but not by how much. "Unknown" is
    // the honest word everywhere else in Wick; here the status carries it.
    return window.status === 'exceeded' ? 'limit reached' : 'usage unknown';
  }
  return `usage ${Math.round(window.utilization)}%`;
}

function resetClause(resetsAt: number | null, now: number): string {
  const phrase = untilReset(resetsAt, now);
  return phrase === null ? '' : ` — ${phrase}`;
}

/** "4 days to reset", "6 hr to reset". `null` when the provider did not say. */
function untilReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;

  const remaining = resetsAt - now;
  if (remaining <= 0) return 'resetting now';
  if (remaining < HOUR_MS) return 'under an hour to reset';

  if (remaining < DAY_MS) {
    const hours = Math.floor(remaining / HOUR_MS);
    return `${hours} hr to reset`;
  }

  const days = Math.round(remaining / DAY_MS);
  return `${days} ${days === 1 ? 'day' : 'days'} to reset`;
}

/**
 * "pace 28/day · runs out Tue ~19:00".
 *
 * Either half may be missing and the line degrades to the other, or to nothing.
 * A projection with no exhaustion estimate is the normal state for a new
 * install — there is no forecast, so the clause is omitted rather than filled
 * with a guess.
 */
function paceLine(projection: Projection, now: number): string {
  const parts: string[] = [];

  const pace = projection.pace;
  if (typeof pace === 'number' && Number.isFinite(pace) && pace > 0) {
    parts.push(`pace ${Math.round(pace)}/day`);
  }

  const at = projection.exhaustionEstimate;
  if (typeof at === 'number' && Number.isFinite(at) && at > now) {
    parts.push(`runs out ${whenPhrase(at, now)}`);
  }

  return parts.join(' · ');
}

/** "Tue ~19:00", "today ~19:00". 24-hour, as everywhere else in Wick. */
function whenPhrase(at: number, now: number): string {
  const moment = new Date(at);
  const time = moment.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const days = calendarDaysBetween(now, at);
  if (days === 0) return `today ~${time}`;
  if (days === 1) return `tomorrow ~${time}`;
  if (days < 7) return `${moment.toLocaleDateString(undefined, { weekday: 'short' })} ~${time}`;

  return `${moment.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ~${time}`;
}

function calendarDaysBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

interface WeekSummary {
  messages: number;
  /** Weekday name of the busiest day, or `null` when nothing was logged. */
  peakDay: string | null;
}

/**
 * Messages over the last seven local days, and which day was busiest.
 *
 * Computed here rather than through `src/core/history.ts` because those helpers
 * are still stubs; when they land this should move to them so the panel and the
 * summary cannot disagree about what "last week" means.
 */
function summariseWeek(history: DailyRollup[], now: number): WeekSummary {
  const wanted = new Set<string>();
  for (let offset = 0; offset < SUMMARY_DAYS; offset += 1) {
    wanted.add(localDateKey(now - offset * DAY_MS));
  }

  let messages = 0;
  let peakDate: string | null = null;
  let peakCount = 0;

  for (const day of history) {
    if (typeof day.date !== 'string' || !wanted.has(day.date)) continue;

    const count = finiteOrNull(day.messageCount) ?? 0;
    messages += count;
    if (count > peakCount) {
      peakCount = count;
      peakDate = day.date;
    }
  }

  return {
    messages,
    peakDay: peakDate === null ? null : weekdayName(peakDate),
  };
}

/**
 * Weekday for a `YYYY-MM-DD` rollup date.
 *
 * Split and rebuilt rather than passed to `new Date(string)`, which parses a
 * bare date as UTC midnight — that lands on the previous day for anyone west of
 * Greenwich and would name the wrong weekday.
 */
function weekdayName(date: string): string | null {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'long' });
}

/* ---- Dispatch ------------------------------------------------------------ */

/**
 * Record, then notify.
 *
 * Recorded *first* on purpose. The record is what makes "at most one message
 * per event" true, and a worker that dies between notifying and recording would
 * otherwise raise the same warning again on the next snapshot. Recording an
 * alert that then fails to appear costs one missed message; the other order
 * costs a loop.
 */
async function dispatch(alert: PendingAlert, now: number): Promise<void> {
  const record: AlertRecord = {
    kind: alert.kind,
    windowKey: alert.windowKey,
    cycleKey: alert.cycleKey,
    at: now,
  };

  try {
    await recordAlert(record);
  } catch {
    // Storage refusing to write is not a reason to skip the notification, but
    // it does mean this alert may repeat. Losing the message as well would be
    // strictly worse.
  }

  await notify(alert.text);
}

/** The local notification, always carrying the packaged 128px Wick mark. */
async function notify(text: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: 'basic',
      title: 'Wick',
      message: text,
      iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    });
  } catch {
    // Notifications may be blocked at the OS level. Nothing to do about it.
  }
}

/* ---- Guards -------------------------------------------------------------- *
 * Everything below takes `unknown`. A snapshot written by an older version, or
 * by a provider whose wire shape drifted, must degrade to "no alert" rather
 * than throwing.                                                              */

/** Pull usable windows out of whatever was in storage. Never throws. */
function readWindows(value: unknown): LimitWindow[] {
  const windows = field(value, 'windows');
  if (!Array.isArray(windows)) return [];

  const out: LimitWindow[] = [];
  for (const entry of windows) {
    const window = asWindow(entry);
    if (window !== null) out.push(window);
  }
  return out;
}

function asWindow(value: unknown): LimitWindow | null {
  const key = field(value, 'key');
  if (typeof key !== 'string' || key === '') return null;

  const label = field(value, 'label');
  const shortLabel = field(value, 'shortLabel');

  return {
    key,
    label: typeof label === 'string' ? label : key,
    shortLabel: typeof shortLabel === 'string' ? shortLabel : key,
    utilization: finiteOrNull(field(value, 'utilization')),
    status: asStatus(field(value, 'status')),
    resetsAt: finiteOrNull(field(value, 'resetsAt')),
    // Absent means present: a window a provider forgot to flag should still be
    // considered, and the alternative is ignoring it forever.
    active: field(value, 'active') !== false,
    // A window stored before roles existed has none. `'other'` keeps it out of
    // the forecast and the threshold alert, and `weeklyWindow` falls back to
    // picking structurally, which is what it did for all of them before.
    role: asRole(field(value, 'role')),
  };
}

const ROLES = ['session', 'weekly', 'weekly-model', 'overage', 'other'] as const;

function asRole(value: unknown): WindowRole {
  return (ROLES as readonly string[]).includes(value as string) ? (value as WindowRole) : 'other';
}

function asStatus(value: unknown): LimitStatus {
  // Never defaults to 'ok'. An unrecognised status means Wick does not know.
  return value === 'ok' || value === 'approaching' || value === 'exceeded' ? value : 'unknown';
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isAlertRecord(value: unknown): value is AlertRecord {
  return typeof field(value, 'kind') === 'string' && typeof field(value, 'cycleKey') === 'string';
}

/**
 * Run the projection without letting it take the alert with it.
 *
 * `src/core/projection.ts` is under active development and this module calls it
 * through its published signature only. A projection that throws, or that comes
 * back in a shape this file does not recognise, degrades to "no forecast" —
 * the alert still goes out, without the pace line.
 */
function projectSafely(window: LimitWindow, history: DailyRollup[], now: number): Projection {
  const none: Projection = {
    exhaustionEstimate: null,
    confidence: 'none',
    pace: null,
    reason: 'No forecast available',
  };

  try {
    return project({ window, history, now }) ?? none;
  } catch {
    return none;
  }
}
