/**
 * Profile addresses, and the card a profile renders to.
 *
 * ADR 0008 fixes the shape at `/u/<name>` rather than the `/profile=<name>`
 * first proposed: an `=` inside a path is legal but reads as a malformed query
 * string, breaks naive link detection in the chat clients this is meant to be
 * pasted into, and leaves nowhere to hang a sub-resource like the share image.
 *
 * The card carries the ADR 0006 metrics and nothing else. No plan tier, no
 * message count, no social graph — each of those was drawn in a design
 * revision and each is a new personal field with no route into the schema.
 * Adding one is an ADR, not a property on this interface.
 *
 * Pure. Renders data structures, not markup.
 */

import type { Counters } from './submission';
import type { Period } from './periods';
import type { Standing } from './ranking';

/** The path prefix profiles live under. Kept in step with `RESERVED` in names.ts. */
export const PROFILE_PREFIX = '/u/';

/**
 * The label every profile and every share image must carry.
 *
 * Exported as a constant because it is a requirement rather than copy. ADR 0008
 * is explicit: a card pasted into a group chat arrives with no page around it,
 * so if this is not rendered *into* the image, the image is a claim the project
 * cannot stand behind.
 */
export const SELF_REPORTED_LABEL = 'Self-reported. Not verified.';

/** A profile's address, relative. Callers prepend the origin. */
export function profilePath(name: string): string {
  return `${PROFILE_PREFIX}${encodeURIComponent(name)}`;
}

/** The share image for a profile, so the card can be linked as an asset. */
export function shareImagePath(name: string): string {
  return `${profilePath(name)}/card.png`;
}

/**
 * Read a name back out of a path.
 *
 * Returns `null` for anything that is not a profile path, including the prefix
 * with nothing after it and a path with further segments — `/u/ash/card.png` is
 * the image, not the profile, and conflating them would serve the wrong thing.
 */
export function nameFromPath(path: string): string | null {
  if (!path.startsWith(PROFILE_PREFIX)) return null;

  const rest = path.slice(PROFILE_PREFIX.length);
  if (rest === '' || rest.includes('/')) return null;

  try {
    const name = decodeURIComponent(rest);
    return name === '' ? null : name;
  } catch {
    // A malformed percent-escape is not a name.
    return null;
  }
}

/** One board's line on a card. */
export interface CardStanding {
  period: Period;
  rank: number;
  ranked: number;
}

/**
 * Everything a profile page and its share image may show.
 *
 * `cacheRead` sits inside `counters` and is never folded into `ranked` — see
 * ranking.ts. It is on the card so the figure is legible, not so it can be
 * added up by whoever reads it.
 */
export interface ProfileCard {
  name: string;
  standings: CardStanding[];
  counters: Counters;
  sessions: number;
  streak: number;
  lastDay: string | null;
  /** Always present, always rendered. Not a caller's choice. */
  label: typeof SELF_REPORTED_LABEL;
}

/**
 * Build a card from standings already computed per period.
 *
 * Periods with no standing are omitted rather than shown as rank zero: a
 * participant who submitted nothing this week has no weekly rank, and printing
 * one would invent a fact.
 */
export function buildCard(
  name: string,
  standings: ReadonlyMap<Period, Standing | null>,
  streak: number,
): ProfileCard {
  const lines: CardStanding[] = [];
  let counters: Counters = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let sessions = 0;
  let lastDay: string | null = null;

  for (const period of ['week', 'month', 'all'] as const) {
    const standing = standings.get(period);
    if (standing === undefined || standing === null) continue;

    lines.push({ period, rank: standing.rank, ranked: standing.ranked });

    // The all-time standing is the whole record, so its totals are the card's.
    if (period === 'all') {
      counters = standing.counters;
      sessions = standing.sessions;
      lastDay = standing.lastDay;
    }
  }

  return { name, standings: lines, counters, sessions, streak, lastDay, label: SELF_REPORTED_LABEL };
}
