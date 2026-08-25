import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const settingsPath = new URL('../src/popup/components/Settings.tsx', import.meta.url);
const panelPath = new URL('../src/popup/App.tsx', import.meta.url);
const sidebarPath = new URL('../src/content/SidebarCard.tsx', import.meta.url);

describe('leaderboard link', () => {
  it('appears once under Project in settings and not in the usage surfaces', async () => {
    const [settings, panel, sidebar] = await Promise.all([
      readFile(settingsPath, 'utf8'),
      readFile(panelPath, 'utf8'),
      readFile(sidebarPath, 'utf8'),
    ]);

    expect(settings).toContain("const LEADERBOARD_URL = 'https://usewick.lol'");
    expect(settings).toContain('href={LEADERBOARD_URL}');
    expect(settings.indexOf('href={LEADERBOARD_URL}')).toBeGreaterThan(
      settings.indexOf('wick-settings__eyebrow">Project'),
    );
    expect(settings.match(/href=\{LEADERBOARD_URL\}/g)).toHaveLength(1);
    expect(panel).not.toContain('https://usewick.lol');
    expect(sidebar).not.toContain('https://usewick.lol');
  });
});
