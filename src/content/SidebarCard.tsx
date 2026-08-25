import { remainingFor } from '~/assets/mark';
import { thresholdState } from '~/core/normalise';
import { allowanceWindow, sessionWindow } from '~/core/windows';
import type { LimitWindow, Settings as SettingsValues } from '~/core/types';
import { Mark } from '~/popup/components/Mark';
import { UsageMeter } from '~/popup/components/UsageMeter';
import { togglePanel, usePanelOpen } from './panel';

interface SidebarCardProps {
  /** Every window the provider reported. The display settings decide which show. */
  windows: LimitWindow[];
  settings: SettingsValues;
  now: number;
}

/**
 * The card injected into claude.ai's sidebar.
 *
 * Artboard 01: two bars and no chrome. It opens the panel and renders none of
 * it — the panel is mounted in the main content frame, because a sidebar is a
 * scroll container and a panel positioned out of one is clipped by it. See
 * `UsagePanel` and docs/design.md deviation 4.
 *
 * The archive's first principle for this surface is "borrow, never brand" — no
 * logo, no coloured banner, nothing that announces itself in someone else's
 * navigation. Its third is "fail quiet". Both are why this renders inside a
 * shadow root and why nothing here reaches outside it.
 */
export function SidebarCard({ windows, settings, now }: SidebarCardProps) {
  const expanded = usePanelOpen();

  const session = sessionWindow(windows);
  const weekly = allowanceWindow(windows) ?? undefined;

  // The two windows the "Sidebar" settings group can switch off, identified by
  // what they are rather than by where they sit in the array. Anything beyond
  // them — a model-scoped weekly, an overage — has no toggle of its own and is
  // always shown.
  const shown = windows.filter((window) => {
    if (session !== null && window.key === session.key) return settings.display.session;
    if (weekly !== undefined && window.key === weekly.key) return settings.display.weekly;
    return true;
  });
  // The mark reflects the whole account, not just what is on screen: switching
  // a bar off is a preference about the panel, not about what is being spent.
  const remaining = remainingFor(windows.map((w) => w.utilization));
  const worstState = thresholdState(
    remaining === null ? null : 100 - remaining,
    weekly?.status ?? 'unknown',
  );

  return (
    <div class="wick-root">
      <button
        type="button"
        class="wick-card"
        aria-expanded={expanded}
        onClick={togglePanel}
      >
        <span class="wick-card__head">
          <span class="wick-card__brand">
            <Mark remaining={remaining} state={worstState} />
            <span class="wick-card__name">Wick</span>
          </span>
          <span class="wick-card__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </span>

        <span class="wick-card__meters">
          {shown.map((window) => (
            <UsageMeter key={window.key} window={window} now={now} compact />
          ))}
        </span>
      </button>

    </div>
  );
}
