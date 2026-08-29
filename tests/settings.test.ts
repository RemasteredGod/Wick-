import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEYS, readSettings } from '~/background/store';
import { DEFAULT_SETTINGS, type BoardSyncState } from '~/core/types';
import { createLatestLoadGate } from '~/popup/useWickState';
import { formatBoardSyncCopy } from '~/popup/components/BoardCard';
import { installChromeMock, uninstallChromeMock, type FakeChrome } from './helpers/chrome-mock';

const settingsPath = new URL('../src/popup/components/Settings.tsx', import.meta.url);
const panelPath = new URL('../src/popup/App.tsx', import.meta.url);
const sidebarPath = new URL('../src/content/SidebarCard.tsx', import.meta.url);

let fake: FakeChrome;

beforeEach(() => {
  fake = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('leaderboard link', () => {
  it('appears once under Leaderboard in settings and not in the usage surfaces', async () => {
    const [settings, panel, sidebar] = await Promise.all([
      readFile(settingsPath, 'utf8'),
      readFile(panelPath, 'utf8'),
      readFile(sidebarPath, 'utf8'),
    ]);

    expect(settings).toContain("const LEADERBOARD_URL = 'https://usewick.lol'");
    expect(settings).toContain('href={LEADERBOARD_URL}');
    expect(settings.indexOf('href={LEADERBOARD_URL}')).toBeGreaterThan(
      settings.indexOf('wick-settings__eyebrow">Leaderboard'),
    );
    expect(settings.indexOf('href={LEADERBOARD_URL}')).toBeLessThan(
      settings.indexOf('wick-settings__eyebrow">Project'),
    );
    expect(settings.match(/href=\{LEADERBOARD_URL\}/g)).toHaveLength(1);
    expect(panel).not.toContain('https://usewick.lol');
    expect(sidebar).not.toContain('https://usewick.lol');
  });
});

describe('website-only sponsorship', () => {
  it('keeps sponsor copy and the Ko-fi URL out of extension surfaces', async () => {
    const surfaces = await Promise.all([
      readFile(settingsPath, 'utf8'),
      readFile(panelPath, 'utf8'),
      readFile(sidebarPath, 'utf8'),
    ]);

    for (const surface of surfaces) {
      expect(surface.toLowerCase()).not.toContain('ko-fi');
      expect(surface).not.toContain('Sponsor this project');
    }
  });
});

describe('popup storage refresh ordering', () => {
  it('does not let a delayed Leave read overwrite a newer Join read', async () => {
    const gate = createLatestLoadGate();
    const committed: string[] = [];
    let finishLeave: ((value: string) => void) | undefined;
    let finishJoin: ((value: string) => void) | undefined;
    const leaveRead = new Promise<string>((resolve) => {
      finishLeave = resolve;
    });
    const joinRead = new Promise<string>((resolve) => {
      finishJoin = resolve;
    });

    const apply = async (read: Promise<string>) => {
      const request = gate.begin();
      const value = await read;
      if (gate.accepts(request)) committed.push(value);
    };

    const leaving = apply(leaveRead);
    const joining = apply(joinRead);
    finishJoin?.('joined-with-fresh-token');
    await joining;
    finishLeave?.('not-joined');
    await leaving;

    expect(committed).toEqual(['joined-with-fresh-token']);
  });
});

describe('leaderboard settings migration', () => {
  it('hydrates legacy settings that have no boardSyncState', async () => {
    const legacy = {
      alertThreshold: 95,
      alertOnReset: false,
      display: { session: false },
      boardToken: 'legacy-token',
      boardName: 'legacy-name',
      boardEmail: 'ash@example.com',
      boardSubmittedThrough: '2026-08-23',
    };
    fake.store.set(KEYS.settings, legacy);

    const hydrated = await readSettings();

    expect(hydrated.boardSyncState).toEqual(DEFAULT_SETTINGS.boardSyncState);
    expect(hydrated.display).toEqual({
      ...DEFAULT_SETTINGS.display,
      session: false,
    });
    expect(hydrated.boardToken).toBe('legacy-token');
  });
});

describe('leaderboard synchronization copy', () => {
  it.each<[BoardSyncState, number | null, string]>([
    [
      { kind: 'waiting-for-day-close' },
      null,
      'Waiting for today to close before publishing.',
    ],
    [
      { kind: 'waiting-for-day-close' },
      12,
      '12 messages today. Waiting for today to close before publishing.',
    ],
    [{ kind: 'syncing' }, null, 'Syncing completed days.'],
    [
      { kind: 'retry-pending' },
      null,
      'Completed days are waiting to sync. Wick will retry.',
    ],
    [
      { kind: 'accepted-through', day: '2026-08-24' },
      null,
      "Accepted through 24 Aug 2026. Today's count waits until the day closes.",
    ],
  ])('formats %# from production state', (state, today, expected) => {
    expect(formatBoardSyncCopy(state, today)).toBe(expected);
  });

  it('preserves an unrecognised stored date rather than inventing one', () => {
    expect(formatBoardSyncCopy({ kind: 'accepted-through', day: 'not-a-day' }, null)).toBe(
      "Accepted through not-a-day. Today's count waits until the day closes.",
    );
  });
});
