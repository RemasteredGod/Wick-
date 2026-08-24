import { useState } from 'preact/hooks';
import { remainingFor } from '~/assets/mark';
import { thresholdState } from '~/core/normalise';
import type {
  DailyRollup,
  LimitWindow,
  Projection as ProjectionResult,
  Settings as SettingsValues,
} from '~/core/types';
import { GearIcon } from '~/popup/components/GearIcon';
import { HistoryStrip } from '~/popup/components/HistoryStrip';
import { Mark } from '~/popup/components/Mark';
import { Projection } from '~/popup/components/Projection';
import { Settings } from '~/popup/components/Settings';
import { TelegramCard } from '~/popup/components/TelegramCard';
import { UsageMeter } from '~/popup/components/UsageMeter';

interface SidebarCardProps {
  /** Every window the provider reported. The display settings decide which show. */
  windows: LimitWindow[];
  history: DailyRollup[];
  /** `null` when there is no window to project from. */
  projection: ProjectionResult | null;
  settings: SettingsValues;
  onChange(patch: Partial<SettingsValues>): void;
  /**
   * Revoke the relay token. There is deliberately no `onConnect` counterpart:
   * connecting needs `chrome.permissions.request`, and a content script has no
   * access to `chrome.permissions` and no way to get one. The settings screen
   * says so rather than offering a field that cannot work.
   */
  onDisconnect?: () => void;
  now: number;
}

/**
 * The card injected into claude.ai's sidebar, and the panel it opens.
 *
 * Artboards 01 and the in-situ mockup. Collapsed it is two bars and no chrome;
 * expanded it is the same panel the popup shows, anchored beside the card.
 *
 * The archive's first principle for this surface is "borrow, never brand" — no
 * logo, no coloured banner, nothing that announces itself in someone else's
 * navigation. Its third is "fail quiet". Both are why this renders inside a
 * shadow root and why nothing here reaches outside it.
 *
 * Unlike the popup, this surface keeps the archive's settings *modal* — it has
 * the room the 372px popup does not. docs/design.md deviation 3.
 */
export function SidebarCard({
  windows,
  history,
  projection,
  settings,
  onChange,
  onDisconnect,
  now,
}: SidebarCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Session first, weekly second, in the provider's own order — the two the
  // "Sidebar" settings group can switch off. Anything beyond them (an Opus
  // window, an overage) has no toggle of its own and is always shown.
  const shown = windows.filter((_, index) => {
    if (index === 0) return settings.display.session;
    if (index === 1) return settings.display.weekly;
    return true;
  });

  const weekly = windows[1] ?? windows[0];
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
        onClick={() => setExpanded((open) => !open)}
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

      {expanded && (
        <div class="wick-panel wick-panel--floating" role="dialog" aria-label="Wick usage">
          <header class="wick-panel__header">
            <div class="wick-panel__brand">
              <Mark remaining={remaining} state={worstState} />
              <span class="wick-panel__title">Wick</span>
            </div>
            <div class="wick-panel__header-actions">
              <button
                type="button"
                class="wick-panel__close"
                aria-label="Close"
                onClick={() => setExpanded(false)}
              >
                ×
              </button>
            </div>
          </header>

          <div class="wick-panel__body">
            {shown.map((window) => (
              <UsageMeter key={window.key} window={window} now={now} />
            ))}

            {settings.display.forecast && projection !== null && weekly !== undefined && (
              <Projection
                projection={projection}
                state={worstState}
                resetsAt={weekly.resetsAt}
                now={now}
              />
            )}

            {settings.display.sparkline && (
              <HistoryStrip
                history={history}
                windowKey={weekly?.key ?? ''}
                now={now}
                compact
              />
            )}

            <div class="wick-rule" />

            <TelegramCard
              connected={settings.relayToken !== null}
              threshold={settings.alertThreshold}
              alsoOnReset={settings.alertOnReset}
            />
          </div>

          <footer class="wick-panel__footer">
            <button type="button" class="wick-button wick-button--grow">
              View history
            </button>
            <button
              type="button"
              class="wick-button wick-button--icon"
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <GearIcon />
            </button>
          </footer>

          {settingsOpen && (
            <div class="wick-modal" role="dialog" aria-label="Wick settings">
              <Settings
                settings={settings}
                onChange={onChange}
                {...(onDisconnect === undefined ? {} : { onDisconnect })}
                onClose={() => setSettingsOpen(false)}
                version={chrome.runtime.getManifest().version}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
