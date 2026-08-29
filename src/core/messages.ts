/**
 * Every message crossing Wick's page/runtime boundaries.
 *
 * A public source tag is routing metadata, never authentication. Page messages
 * are structurally bounded here and remain untrusted after validation; sender
 * provenance is checked separately at every runtime listener.
 */

import type { LimitWindow, WickState } from './types';

/* ---- MAIN world → content script ---------------------------------------- */

export const INJECT_SOURCE = 'wick-inject' as const;

export type InjectMessage =
  | { source: typeof INJECT_SOURCE; kind: 'limits'; event: unknown; at: number }
  | { source: typeof INJECT_SOURCE; kind: 'message-sent'; at: number; id: string }
  | { source: typeof INJECT_SOURCE; kind: 'refused'; body: string; at: number };

const MAX_CLOCK_SKEW_PAST_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_FUTURE_MS = 60_000;
const MAX_ID_LENGTH = 128;
const MAX_REFUSAL_LENGTH = 64 * 1024;
const MAX_EMAIL_LENGTH = 320;
const MAX_WINDOWS = 32;
const MAX_TEXT_LENGTH = 256;
const MAX_EVENT_DEPTH = 8;
const MAX_EVENT_NODES = 512;

/** Narrow page data without granting it authority to mutate durable state. */
export function isInjectMessage(value: unknown): value is InjectMessage {
  if (!isRecord(value) || value.source !== INJECT_SOURCE || !plausibleNow(value.at)) return false;

  switch (value.kind) {
    case 'message-sent':
      return exactKeys(value, ['source', 'kind', 'at', 'id']) && boundedId(value.id);
    case 'refused':
      return (
        exactKeys(value, ['source', 'kind', 'body', 'at']) &&
        typeof value.body === 'string' &&
        value.body.length > 0 &&
        value.body.length <= MAX_REFUSAL_LENGTH
      );
    case 'limits':
      return (
        exactKeys(value, ['source', 'kind', 'event', 'at']) &&
        isRecord(value.event) &&
        boundedCloneable(value.event)
      );
    default:
      return false;
  }
}

/* ---- Content script / popup → service worker ---------------------------- */

export type RuntimeMessage =
  | {
      type: 'wick:stream-limits';
      windows: LimitWindow[];
      at: number;
      source: 'stream' | 'rejection';
    }
  | { type: 'wick:message-sent'; at: number; id: string }
  | { type: 'wick:refresh' }
  | { type: 'wick:tab-open' }
  | { type: 'wick:get-state' }
  | { type: 'wick:board-enroll' }
  | { type: 'wick:board-leave' }
  | { type: 'wick:account-email'; email: string | null }
  | { type: 'wick:read-account' };

export type BoardOutcome = 'ok' | 'no-account' | 'unavailable' | 'not-permitted';

export type RuntimeResponse =
  | { ok: true; state: WickState }
  | { ok: true; outcome: BoardOutcome }
  | { ok: true; email: string | null }
  | { ok: true }
  | { ok: false; error: string };

/** Exact per-kind runtime validation; recognizing a type string is not enough. */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'wick:refresh':
    case 'wick:tab-open':
    case 'wick:get-state':
    case 'wick:board-enroll':
    case 'wick:board-leave':
    case 'wick:read-account':
      return exactKeys(value, ['type']);

    case 'wick:account-email':
      return (
        exactKeys(value, ['type', 'email']) &&
        (value.email === null || boundedEmailObservation(value.email))
      );

    case 'wick:message-sent':
      return (
        exactKeys(value, ['type', 'at', 'id']) &&
        plausibleNow(value.at) &&
        boundedId(value.id)
      );

    case 'wick:stream-limits':
      return (
        exactKeys(value, ['type', 'windows', 'at', 'source']) &&
        plausibleNow(value.at) &&
        (value.source === 'stream' || value.source === 'rejection') &&
        Array.isArray(value.windows) &&
        value.windows.length > 0 &&
        value.windows.length <= MAX_WINDOWS &&
        value.windows.every(isRuntimeLimitWindow)
      );

    default:
      return false;
  }
}

/**
 * A main-frame isolated content script on a configured provider host.
 *
 * `sender.id` rejects other extensions; URL, tab and frame checks prevent an
 * extension page or an unexpected subframe from borrowing a content action.
 */
export function isProviderContentSender(
  sender: chrome.runtime.MessageSender,
  matchPatterns: readonly string[],
): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.frameId !== 0 || sender.tab === undefined || !Number.isInteger(sender.tab.id)) {
    return false;
  }
  if (typeof sender.url !== 'string') return false;
  return matchPatterns.some((pattern) => matchesPattern(pattern, sender.url as string));
}

/** A Wick-owned extension page such as the popup, never a host-page content script. */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  if (typeof sender.url !== 'string') return false;
  return sender.url.startsWith(chrome.runtime.getURL(''));
}

function isRuntimeLimitWindow(value: unknown): value is LimitWindow {
  if (!isRecord(value)) return false;
  const allowed = [
    'key',
    'label',
    'shortLabel',
    'utilization',
    'status',
    'resetsAt',
    'active',
    'role',
    'scope',
  ];
  if (!onlyKeys(value, allowed)) return false;
  if (!requiredKeys(value, allowed.slice(0, 8))) return false;

  return (
    boundedText(value.key, 1, 128) &&
    boundedText(value.label, 1, MAX_TEXT_LENGTH) &&
    boundedText(value.shortLabel, 1, MAX_TEXT_LENGTH) &&
    (value.utilization === null || finiteRange(value.utilization, 0, 100)) &&
    ['ok', 'approaching', 'exceeded', 'unknown'].includes(String(value.status)) &&
    (value.resetsAt === null || plausibleAbsoluteTimestamp(value.resetsAt)) &&
    typeof value.active === 'boolean' &&
    ['session', 'weekly', 'weekly-model', 'overage', 'other'].includes(String(value.role)) &&
    (value.scope === undefined || boundedText(value.scope, 1, MAX_TEXT_LENGTH))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && requiredKeys(value, keys);
}

function requiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function plausibleNow(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  const now = Date.now();
  return value >= now - MAX_CLOCK_SKEW_PAST_MS && value <= now + MAX_CLOCK_SKEW_FUTURE_MS;
}

function plausibleAbsoluteTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= Date.UTC(2020, 0, 1) &&
    value <= Date.UTC(2100, 0, 1)
  );
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function boundedId(value: unknown): value is string {
  return boundedText(value, 1, MAX_ID_LENGTH) && /^[A-Za-z0-9._:-]+$/.test(value);
}

function boundedEmailObservation(value: unknown): value is string {
  if (!boundedText(value, 1, MAX_EMAIL_LENGTH)) return false;
  if (/[\u0000-\u0020\u007f]/.test(value)) return false;

  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
}

/** Bound an untrusted structured-clone tree before provider parsing sees it. */
function boundedCloneable(root: unknown): boolean {
  let nodes = 0;
  let textUnits = 0;
  const addText = (value: string): boolean => {
    textUnits += value.length;
    return textUnits <= MAX_REFUSAL_LENGTH;
  };
  const visit = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_EVENT_NODES || depth > MAX_EVENT_DEPTH) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return addText(value);
    if (Array.isArray(value)) {
      return value.length <= MAX_WINDOWS && value.every((item) => visit(item, depth + 1));
    }
    if (!isRecord(value) || Object.keys(value).length > 64) return false;
    return Object.entries(value).every(
      ([key, item]) =>
        key.length <= MAX_TEXT_LENGTH && addText(key) && visit(item, depth + 1),
    );
  };
  return visit(root, 0);
}

function matchesPattern(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}
