/**
 * The Claude provider.
 *
 * This is the only file in the codebase that knows claude.ai exists — its
 * URLs, its cookie names, its window keys, its wire field names. Everything
 * here is written against docs/protocol.md, which is Wick's own specification
 * of observed network behaviour, independently written. See the clean-room rule
 * in AGENTS.md.
 *
 * **Nothing here has been confirmed against live traffic.** The usage endpoint
 * path in particular is a hypothesis, which is why `fetchUsage` probes a short
 * list of candidates instead of asserting one, and why every parse returns
 * "nothing" rather than throwing. A wrong guess must degrade the display; it
 * must never break the poll loop. See docs/verifying-the-protocol.md for how to
 * replace the guesses with observations.
 */

import {
  field,
  normaliseResetsAt,
  normaliseStatus,
  normaliseUtilization,
  parseMaybeJson,
} from '~/core/normalise';
import type { LimitWindow } from '~/core/types';
import type { UsageProvider, UsageResult } from './types';

const ORIGIN = 'https://claude.ai';

/** Cookie carrying the organisation the user is actually working in. */
const ACTIVE_ORG_COOKIE = 'lastActiveOrg';

/**
 * Candidate usage endpoints, in the order they are tried. `{org}` is replaced
 * with the URL-encoded organisation ID.
 *
 * The first is the hypothesis recorded in docs/protocol.md; the rest are the
 * names the same API would plausibly use for the same resource, ordered by how
 * closely they match the vocabulary the endpoint's own response uses
 * (`limits[]`). None is confirmed. Probing costs one extra request on a cold
 * worker and nothing afterwards, which is cheaper than being confidently wrong.
 *
 * When DevTools shows the real path, put it first and delete the rest.
 */
export const USAGE_PATH_CANDIDATES = [
  '/api/organizations/{org}/usage',
  '/api/organizations/{org}/usage_limits',
  '/api/organizations/{org}/limits',
  '/api/organizations/{org}/rate_limits',
] as const;

/**
 * The candidate that last answered with a usable body.
 *
 * Module-level, so it survives only as long as the service worker does — MV3
 * tears the worker down when idle and the memo goes with it. That is
 * acceptable: the cost of forgetting is one or two extra 404s on the next cold
 * poll, and persisting it would mean a stale path outliving a deploy.
 */
let confirmedUsagePath: string | null = null;

/** Forget the probed path. For tests, and for a deliberate re-probe. */
export function resetUsagePathMemo(): void {
  confirmedUsagePath = null;
}

/**
 * URLs whose completion means the cached reading may be stale.
 * docs/protocol.md §"Cache invalidation triggers". Watched headers-only.
 */
export const INVALIDATION_PATTERNS = [
  `${ORIGIN}/api/account_profile*`,
  `${ORIGIN}/api/account/settings*`,
  `${ORIGIN}/api/settings/billing*`,
];

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

/**
 * Spellings of the same window, folded onto one key.
 *
 * claude.ai already calls the five-hour window two things in one payload —
 * `windows` keys it `5h` while `representativeClaim` says `five_hour` — and the
 * usage endpoint's key field is unconfirmed, so it may say a third. Daily
 * rollups are keyed on `LimitWindow.key` and are append-only, so two spellings
 * of one window means two half-histories that can never be merged. Folding here
 * is cheap insurance; an unrecognised key is passed through untouched.
 */
const KEY_ALIASES: Record<string, string> = {
  five_hour: '5h',
  five_hourly: '5h',
  '5_hour': '5h',
  session: '5h',
  seven_day: '7d',
  weekly: '7d',
  seven_day_opus: '7d_oi',
  seven_day_oi: '7d_oi',
  '7d_opus': '7d_oi',
  opus: '7d_oi',
};

/** Windows shown by default, in display order. Others are tracked but secondary. */
export const PRIMARY_WINDOWS = ['5h', '7d'] as const;

/** Fold a wire key onto the one Wick keys history with. */
export function canonicalKey(key: string): string {
  const trimmed = key.trim();
  return KEY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

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
  const raw = field(entry, 'kind') ?? field(entry, 'group') ?? field(entry, 'scope');
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const key = canonicalKey(raw);
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
  const canonical = canonicalKey(key);
  const labels = labelsFor(canonical);

  return {
    key: canonical,
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

/* ---- The completion stream ----------------------------------------------- */

/**
 * The two requests that carry a completion stream, per docs/protocol.md.
 * Anchored at the end of the path so a conversation ID in front of it — or a
 * query string behind it — makes no difference.
 */
const COMPLETION_PATH = /\/(retry_)?completion\/?$/;

/**
 * Whether a URL is one Wick wants to watch the body of.
 *
 * Exported because the MAIN-world wrapper has to make this decision inside the
 * page, and it may not know a claude.ai URL of its own — that knowledge lives
 * here or nowhere.
 */
export function isCompletionUrl(url: string): boolean {
  try {
    const parsed = new URL(url, ORIGIN);
    return parsed.origin === ORIGIN && COMPLETION_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/* ---- Server-sent events -------------------------------------------------- */

/** One record off a `text/event-stream`. */
export interface SseEvent {
  /** The `event:` field, or `null` when the record did not name one. */
  name: string | null;
  /** The `data:` field, JSON-parsed where possible, otherwise the raw string. */
  data: unknown;
  /** The `data:` field exactly as it arrived, joined across continuation lines. */
  raw: string;
}

/** The result of framing one chunk: whole records, plus an unfinished tail. */
export interface SseChunk {
  events: SseEvent[];
  /**
   * Bytes after the last complete record. The caller prepends this to the next
   * chunk — a record is routinely split across a network boundary, and a parser
   * that assumes otherwise loses exactly the tail event Wick is here for.
   */
  leftover: string;
}

/**
 * Frame one chunk of a `text/event-stream` into records.
 *
 * Pure, total, and deliberately length-agnostic: docs/protocol.md records that
 * claude.ai right-pads each record's JSON with a variable run of spaces before
 * the closing brace, so record lengths mean nothing and no logic here may count
 * bytes. Framing is by blank line only, which is what the padding does not
 * disturb.
 *
 * A stream that ends without a trailing blank line leaves its last record in
 * `leftover`; call once more with `leftover + '\n\n'` to flush it.
 */
export function parseSseChunk(chunk: string): SseChunk {
  // Normalised so the separator scan has one case to handle. The leftover is
  // returned normalised too; feeding it back in is idempotent.
  const text = chunk.replace(/\r\n?/g, '\n');

  const events: SseEvent[] = [];
  const lines: string[] = [];
  let cursor = 0;
  let recordStart = 0;

  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor);
    // No terminator yet: everything from the current record onward is leftover.
    if (newline === -1) break;

    const line = text.slice(cursor, newline);
    cursor = newline + 1;

    // A whitespace-only line ends the record. Tolerating stray spaces here
    // costs nothing and the padding hazard makes an exactly-empty line a
    // riskier assumption than it looks.
    if (line.trim() === '') {
      const event = recordFromLines(lines);
      if (event) events.push(event);
      lines.length = 0;
      recordStart = cursor;
      continue;
    }

    lines.push(line);
  }

  return { events, leftover: text.slice(recordStart) };
}

function recordFromLines(lines: string[]): SseEvent | null {
  let name: string | null = null;
  const data: string[] = [];

  for (const line of lines) {
    // `:` opens a comment; claude.ai sends them as keep-alives.
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const fieldName = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? '' : line.slice(colon + 1);
    // One optional space after the colon belongs to the framing, not the value.
    const value = rest.startsWith(' ') ? rest.slice(1) : rest;

    if (fieldName === 'event') name = value.trim();
    else if (fieldName === 'data') data.push(value);
  }

  // A record with no data carries nothing Wick can use.
  if (data.length === 0) return null;

  const raw = data.join('\n');
  // Depth 1: the stream is singly encoded. Refusals are the double-encoded ones.
  return { name, data: parseMaybeJson(raw, 1), raw };
}

/* ---- Refusals ------------------------------------------------------------ */

/** Fields a refusal has been seen to hide its limit report inside. */
const REFUSAL_ENVELOPES = ['error', 'detail', 'body', 'data'];
const REFUSAL_MESSAGE_FIELDS = ['message', 'detail', 'error_message', 'body', 'data'];

/**
 * Pull limit windows out of a refused send.
 *
 * docs/protocol.md §"Rejection responses": the report sits one level deeper
 * than on the stream and is double-encoded as a JSON string inside a message
 * field, so the useful payload is one `JSON.parse` past where it looks. Which
 * field holds it is not confirmed, so this looks in every envelope it plausibly
 * uses rather than asserting one and silently finding nothing.
 *
 * Returns `null` when there is nothing to read, which includes every refusal
 * that was not about a limit.
 */
export function limitWindowsFromRefusal(body: unknown): LimitWindow[] | null {
  const root = parseMaybeJson(body);

  const containers: unknown[] = [root];
  for (const key of REFUSAL_ENVELOPES) {
    const nested = field(root, key);
    if (nested !== undefined) containers.push(parseMaybeJson(nested));
  }

  for (const container of containers) {
    const direct = limitWindowsFromAnyShape(container);
    if (direct) return direct;

    for (const key of REFUSAL_MESSAGE_FIELDS) {
      const decoded = parseMaybeJson(field(container, key));
      const windows = limitWindowsFromAnyShape(decoded);
      if (windows) return windows;
    }
  }

  return null;
}

/**
 * Read limit state out of whichever of the three known shapes a value is in.
 *
 * The same facts reach Wick as a `message_limit` event, as a bare `windows`
 * map, and as a `limits[]` array, and a refusal has been seen to carry any of
 * them. Trying all three here keeps that uncertainty in one place.
 */
function limitWindowsFromAnyShape(value: unknown): LimitWindow[] | null {
  const asEvent = limitWindowsFromEvent(value);
  if (asEvent) return asEvent;

  const nested = field(value, 'message_limit');
  if (nested !== undefined) {
    const windows = windowsFromMap(field(nested, 'windows'));
    if (windows) return windows;
  }

  const direct = windowsFromMap(field(value, 'windows'));
  if (direct) return direct;

  const limits = field(value, 'limits');
  if (Array.isArray(limits)) {
    const out = limits.map(windowFromLimitEntry).filter((w): w is LimitWindow => w !== null);
    if (out.length > 0) return out;
  }

  return null;
}

function windowsFromMap(value: unknown): LimitWindow[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const out: LimitWindow[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    out.push(windowFromStreamEntry(key, entry));
  }
  return out.length > 0 ? out : null;
}

/* ---- The usage fetch ----------------------------------------------------- */

/**
 * Read `limits[]` out of a usage response.
 *
 * `null` means "this response is not the usage endpoint" — which is how the
 * probe tells a wrong path that happens to return 200 from the right one. An
 * account that genuinely meters nothing returns an empty array, not `null`, and
 * those two must not be confused.
 */
function windowsFromUsageBody(body: unknown): LimitWindow[] | null {
  const raw = Array.isArray(body)
    ? body
    : (field(body, 'limits') ?? field(field(body, 'usage'), 'limits'));
  if (!Array.isArray(raw)) return null;

  return raw.map(windowFromLimitEntry).filter((w): w is LimitWindow => w !== null);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Candidates to try this call, memoised winner first. */
function orderedCandidates(): string[] {
  const all = [...USAGE_PATH_CANDIDATES];
  if (confirmedUsagePath === null) return all;
  return [confirmedUsagePath, ...all.filter((path) => path !== confirmedUsagePath)];
}

/**
 * Fetch current limit state, probing until something answers.
 *
 * Rules of the probe, all of them chosen so a wrong guess degrades:
 * - only 2xx counts as a hit, and only if the body actually contains `limits[]`;
 * - 404 means the path is wrong — try the next one;
 * - 401/403 means the credentials are the problem, not the path — stop, because
 *   probing further would just be four more rejections;
 * - everything failing is `unavailable`, never a throw.
 */
export async function fetchUsageResult(orgId: string): Promise<UsageResult> {
  const org = encodeURIComponent(orgId);
  let lastFailure: string | null = null;

  for (const template of orderedCandidates()) {
    const url = `${ORIGIN}${template.replace('{org}', org)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        // The session cookie is the whole authentication story here.
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      lastFailure = errorMessage(error);
      continue;
    }

    if (response.status === 401 || response.status === 403) return { kind: 'signed-out' };

    if (!response.ok) {
      lastFailure = `HTTP ${response.status}`;
      continue;
    }

    const windows = windowsFromUsageBody(await readJson(response));
    if (windows === null) {
      // A 200 from a path that is not the usage endpoint. Common enough — SPA
      // routers answer almost anything with an HTML shell.
      lastFailure = 'unrecognised response shape';
      continue;
    }

    confirmedUsagePath = template;
    return { kind: 'ok', windows, path: template };
  }

  return { kind: 'unavailable', message: lastFailure ?? 'no usage endpoint answered' };
}

export const claudeProvider: UsageProvider = {
  id: 'claude',
  displayName: 'Claude',
  matchPatterns: [`${ORIGIN}/*`],
  invalidationPatterns: INVALIDATION_PATTERNS,

  async resolveAccountId(): Promise<string | null> {
    // Read from the cookie rather than enumerating an organisations endpoint:
    // a user in several orgs should see the one they are actually using, not
    // every org as a separate phantom account.
    const cookie = await chrome.cookies.get({ url: ORIGIN, name: ACTIVE_ORG_COOKIE });
    const value = cookie?.value?.trim();
    return value ? decodeURIComponent(value) : null;
  },

  fetchUsageResult,

  async fetchUsage(orgId: string): Promise<LimitWindow[]> {
    // The lossy view of `fetchUsageResult`, for callers that only want numbers.
    const result = await fetchUsageResult(orgId);
    return result.kind === 'ok' ? result.windows : [];
  },

  parseStreamEvent(event: unknown): LimitWindow[] | null {
    return limitWindowsFromEvent(event);
  },

  parseRefusal(body: unknown): LimitWindow[] | null {
    return limitWindowsFromRefusal(body);
  },
};
