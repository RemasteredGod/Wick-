/**
 * The account-to-profile flow, end to end through the store port.
 *
 * The pieces are tested separately elsewhere. What this file pins down is the
 * property the whole design exists for and that no single unit test can state:
 * **one Claude account is one public profile, and switching accounts switches
 * profiles.**
 *
 * Driven through `createMemoryStore` rather than the HTTP handlers, because the
 * handlers are a seam — read the body, call the store, render the answer — and
 * the behaviour worth guarding lives underneath them.
 */

import { describe, expect, it } from 'vitest';
import { readAccountEmail } from '../leaderboard/account';
import { buildCard } from '../leaderboard/profile';
import { renderBoard, renderProfile } from '../leaderboard/render';
import { createMemoryStore } from '../server/memory-store';

const TODAY = '2026-08-27';
const YESTERDAY = '2026-08-26';

/** What `api/enroll.ts` does before it reaches the store. */
function enrolling(raw: string): string {
  const email = readAccountEmail(raw);
  if (email === null) throw new Error(`refused: ${raw}`);
  return email;
}

function store() {
  let issued = 0;
  return createMemoryStore(() => `tok-${String(++issued)}`);
}

describe('one account, many browsers', () => {
  it('publishes to one profile from three browsers, without double counting', async () => {
    const board = store();

    // Laptop joins and publishes yesterday.
    const laptop = await board.enroll(enrolling('Ash@Example.com'), () => 'amber-ledger-0042');
    await board.saveDaily(laptop?.token ?? '', { day: YESTERDAY, messages: 30 });

    // Desktop joins later. Same account, differently cased in its sidebar.
    const desktop = await board.enroll(enrolling('ash@example.com'), () => 'never-assigned');
    expect(desktop?.name).toBe('amber-ledger-0042');

    // Phone, with stray whitespace around the address.
    const phone = await board.enroll(enrolling('  ASH@EXAMPLE.COM  '), () => 'never-assigned');
    expect(phone?.name).toBe('amber-ledger-0042');

    // All three report the same day. The day is counted once.
    for (const held of [laptop, desktop, phone]) {
      await board.saveDaily(held?.token ?? '', { day: TODAY, messages: 12 });
    }

    const standings = await board.board('all', TODAY, 10);
    expect(standings).toHaveLength(1);
    expect(standings[0]?.name).toBe('amber-ledger-0042');
    expect(standings[0]?.ranked).toBe(42);
    expect(standings[0]?.days).toBe(2);
  });

  it('shows the same public page whichever browser published', async () => {
    const board = store();
    const laptop = await board.enroll(enrolling('ash@example.com'), () => 'ash');
    const desktop = await board.enroll(enrolling('ash@example.com'), () => 'unused');

    await board.saveDaily(laptop?.token ?? '', { day: YESTERDAY, messages: 5 });
    await board.saveDaily(desktop?.token ?? '', { day: TODAY, messages: 7 });

    const stats = await board.stats('ash', TODAY);
    expect(stats?.standings.get('all')?.ranked).toBe(12);
    expect(stats?.streak).toBe(2);
  });
});

describe('switching accounts', () => {
  it('gives the second account its own profile, and leaves the first alone', async () => {
    const board = store();

    const work = await board.enroll(enrolling('work@example.com'), () => 'work-profile');
    await board.saveDaily(work?.token ?? '', { day: YESTERDAY, messages: 40 });

    const personal = await board.enroll(enrolling('personal@example.com'), () => 'personal-profile');
    await board.saveDaily(personal?.token ?? '', { day: TODAY, messages: 10 });

    const standings = await board.board('all', TODAY, 10);
    expect(standings.map((s) => s.name)).toEqual(['work-profile', 'personal-profile']);
    expect(standings[0]?.ranked).toBe(40);
    expect(standings[1]?.ranked).toBe(10);
  });

  it('returns to the original profile when the first account signs back in', async () => {
    // The extension re-enrols on every switch. Coming back must land on the
    // same public page, not create a third one.
    const board = store();

    const first = await board.enroll(enrolling('ash@example.com'), () => 'ash');
    await board.saveDaily(first?.token ?? '', { day: YESTERDAY, messages: 20 });

    await board.enroll(enrolling('other@example.com'), () => 'other');

    const back = await board.enroll(enrolling('ash@example.com'), () => 'would-be-third');
    expect(back?.name).toBe('ash');
    expect(back?.existing).toBe(true);

    await board.saveDaily(back?.token ?? '', { day: TODAY, messages: 5 });
    const stats = await board.stats('ash', TODAY);
    expect(stats?.standings.get('all')?.ranked).toBe(25);
  });
});

describe('leaving', () => {
  it('takes the account off the board from any of its browsers', async () => {
    const board = store();
    const laptop = await board.enroll(enrolling('ash@example.com'), () => 'ash');
    const desktop = await board.enroll(enrolling('ash@example.com'), () => 'unused');
    await board.saveDaily(laptop?.token ?? '', { day: TODAY, messages: 30 });

    // Pressed on the desktop; the laptop's binding must go too.
    await board.forget(desktop?.token ?? '');

    expect(await board.board('all', TODAY, 10)).toEqual([]);
    expect(await board.stats('ash', TODAY)).toBeNull();
    expect(await board.profile(laptop?.token ?? '')).toBeNull();

    // And the laptop cannot resurrect the profile by publishing.
    await board.saveDaily(laptop?.token ?? '', { day: TODAY, messages: 99 });
    expect(await board.board('all', TODAY, 10)).toEqual([]);
  });

  it('lets the account join again afterwards, as a new profile', async () => {
    const board = store();
    const first = await board.enroll(enrolling('ash@example.com'), () => 'ash');
    await board.forget(first?.token ?? '');

    const again = await board.enroll(enrolling('ash@example.com'), () => 'ash');
    expect(again?.existing).toBe(false);
    expect(again?.name).toBe('ash');
  });
});

describe('what reaches a public page', () => {
  /** Visible copy plus attribute values, minus the stylesheet. */
  function served(html: string): string {
    return html.replace(/<style[\s\S]*?<\/style>/g, ' ');
  }

  it('never renders an account address, on the board or on a profile', async () => {
    // The email is the primary key and is in the database by design. It must
    // not be on a page. This is the assertion that keeps "never shown on a
    // public page" in PRIVACY.md true.
    const board = store();
    const email = 'someone.identifiable@their-employer.example.com';
    const enrolment = await board.enroll(enrolling(email), () => 'amber-ledger-0042');
    await board.saveDaily(enrolment?.token ?? '', { day: YESTERDAY, messages: 30 });
    await board.saveDaily(enrolment?.token ?? '', { day: TODAY, messages: 12 });

    const standings = await board.board('all', TODAY, 100);
    const boardHtml = served(renderBoard({ period: 'all', standings, today: TODAY }));

    const stats = await board.stats('amber-ledger-0042', TODAY);
    const card = buildCard('amber-ledger-0042', stats?.standings ?? new Map(), stats?.streak ?? 0);
    const profileHtml = served(renderProfile(card, TODAY));

    for (const [label, html] of [['board', boardHtml], ['profile', profileHtml]] as const) {
      expect(html, label).not.toContain(email);
      expect(html, label).not.toContain('their-employer');
      expect(html, label).not.toContain('someone.identifiable');
      // Nothing address-shaped at all, once the stylesheet's @media is gone.
      expect(html.replace(/@media/g, ''), label).not.toContain('@');
      // And the name is there, so this is not passing by rendering nothing.
      expect(html, label).toContain('amber-ledger-0042');
    }
  });

  it('does not leak the token either', async () => {
    const board = store();
    const enrolment = await board.enroll(enrolling('ash@example.com'), () => 'ash');
    await board.saveDaily(enrolment?.token ?? '', { day: TODAY, messages: 5 });

    const standings = await board.board('all', TODAY, 100);
    expect(served(renderBoard({ period: 'all', standings, today: TODAY }))).not.toContain(
      enrolment?.token ?? 'unreachable',
    );
  });
});
