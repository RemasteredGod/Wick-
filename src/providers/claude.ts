/**
 * The Claude provider.
 *
 * This is the only file in the codebase that knows claude.ai exists — its
 * URLs, its cookie names, its window keys, its wire field names. Everything
 * here is written against docs/protocol.md, which is Wick's own specification
 * of observed network behaviour, independently written. See the clean-room rule
 * in AGENTS.md.
 *
 * **Status: M1 scaffold.** The constants and window mapping below are the
 * protocol document expressed as code. The two network-facing methods throw
 * until M2 has verified the protocol against live traffic — a collector built
 * on unverified guesses would be debugging two problems at once.
 */

import { normaliseResetsAt, normaliseStatus, normaliseUtilization, field } from '~/core/normalise';
import type { LimitWindow } from '~/core/types';
import { NotImplemented, type UsageProvider } from './types';

const ORIGIN = 'https://claude.ai';

/** Cookie carrying the organisation the user is actually working in. */
const ACTIVE_ORG_COOKIE = 'lastActiveOrg';

/**
 * Usage endpoint. **Unverified** — the path is a hypothesis until M2 confirms
 * it in DevTools.
 */
function usageUrl(orgId: string): string {
  return `${ORIGIN}/api/organizations/${encodeURIComponent(orgId)}/usage`;
}

/**
 * Window keys as they appear in the `message_limit` event, mapped to the labels
 * the design uses.
 *
 * Keys are opaque outside this file. The labels are here rather than in the
 * interface because only the provider knows that "5h" means a five-hour session
 * window; the popup should not have to.
 */
const WINDOW_LABELS: Record<string, { label: string; short: string }> = {
  '5h': { label: 'Session · 5 hr', short: 'Session' },
  '7d': { label: 'Weekly', short: 'Weekly' },
  '7d_oi': { label: 'Weekly · Opus', short: 'Opus' },
  overage: { label: 'Overage', short: 'Overage' },
};

/** Windows shown by default, in display order. Others are tracked but secondary. */
export const PRIMARY_WINDOWS = ['5h', '7d'] as const;

function labelsFor(key: string): { label: string; short: string } {
  return WINDOW_LABELS[key] ?? { label: key, short: key };
}

/**
 * Build a `LimitWindow` from one entry of the usage endpoint's `limits[]`.
 *
 * The usage endpoint reports `percent` as an integer and `resets_at` as an ISO
 * string, unlike the stream. Anything missing becomes `null` or `'unknown'`
 * rather than a zero.
 */
export function windowFromLimitEntry(entry: unknown): LimitWindow | null {
  const key = field(entry, 'kind') ?? field(entry, 'group') ?? field(entry, 'scope');
  if (typeof key !== 'string' || key === '') return null;

  const labels = labelsFor(key);

  return {
    key,
    label: labels.label,
    shortLabel: labels.short,
    utilization: normaliseUtilization(field(entry, 'percent'), 'percent'),
    status: normaliseStatus(field(entry, 'severity')),
    resetsAt: normaliseResetsAt(field(entry, 'resets_at')),
    active: field(entry, 'is_active') !== false,
  };
}

/**
 * Build a `LimitWindow` from one entry of `message_limit.windows`.
 *
 * The stream reports `utilization` as a 0–1 float and `resets_at` as unix
 * seconds — both different from the usage endpoint, which is why normalisation
 * is centralised rather than done inline.
 *
 * `utilization` is not trustworthy at the boundary: a window that has actually
 * bound can still report below 1.0 while `status` says otherwise. The status is
 * carried through unmodified so `thresholdState` can let it win.
 */
export function windowFromStreamEntry(key: string, entry: unknown): LimitWindow {
  const labels = labelsFor(key);

  return {
    key,
    label: labels.label,
    shortLabel: labels.short,
    utilization: normaliseUtilization(field(entry, 'utilization'), 'fraction'),
    status: normaliseStatus(field(entry, 'status')),
    resetsAt: normaliseResetsAt(field(entry, 'resets_at')),
    active: field(entry, 'status') !== undefined,
  };
}

/**
 * Pull limit windows out of a parsed stream event, if it carries any.
 *
 * Almost every event on a completion stream is content and returns `null`.
 */
export function limitWindowsFromEvent(event: unknown): LimitWindow[] | null {
  if (field(event, 'type') !== 'message_limit') return null;

  const limit = field(event, 'message_limit');
  const windows = field(limit, 'windows');
  if (typeof windows !== 'object' || windows === null) return null;

  const out: LimitWindow[] = [];
  for (const [key, value] of Object.entries(windows as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    out.push(windowFromStreamEntry(key, value));
  }

  return out.length > 0 ? out : null;
}

export const claudeProvider: UsageProvider = {
  id: 'claude',
  displayName: 'Claude',
  matchPatterns: [`${ORIGIN}/*`],

  async resolveAccountId(): Promise<string | null> {
    // Read from the cookie rather than enumerating an organisations endpoint:
    // a user in several orgs should see the one they are actually using, not
    // every org as a separate phantom account.
    const cookie = await chrome.cookies.get({ url: ORIGIN, name: ACTIVE_ORG_COOKIE });
    const value = cookie?.value?.trim();
    return value ? decodeURIComponent(value) : null;
  },

  async fetchUsage(orgId: string): Promise<LimitWindow[]> {
    // M3. The endpoint path above is unverified; M2 confirms it first.
    void usageUrl(orgId);
    throw new NotImplemented('claudeProvider.fetchUsage');
  },

  parseStreamEvent(event: unknown): LimitWindow[] | null {
    return limitWindowsFromEvent(event);
  },
};
