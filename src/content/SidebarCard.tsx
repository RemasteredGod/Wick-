import { useState } from 'preact/hooks';
import { remainingFor } from '~/assets/mark';
import { thresholdState } from '~/core/normalise';
import type { LimitWindow, Projection as ProjectionResult, DailyRollup } from '~/core/types';
import { GearIcon } from '~/popup/components/GearIcon';
import { HistoryStrip } from '~/popup/components/HistoryStrip';
import { Mark } from '~/popup/components/Mark';
import { Projection } from '~/popup/components/Projection';
import { TelegramCard } from '~/popup/components/TelegramCard';
import { UsageMeter } from '~/popup/components/UsageMeter';

interface SidebarCardProps {
  windows: LimitWindow[];
  history: DailyRollup[];
  projection: ProjectionResult;
  plan: string;
  telegram: { connected: boolean; threshold: number; alsoOnReset: boolean };
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
 */
export function SidebarCard({
  windows,
  history,
  projection,
  plan,
  telegram,
  now,
}: SidebarCardProps) {
  const [expanded, setExpanded] = useState(false);

  const weekly = windows[1];
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
          {windows.map((window) => (
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
              <span class="wick-badge">{plan}</span>
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
            {windows.map((window) => (
              <UsageMeter key={window.key} window={window} now={now} />
            ))}

            <Projection
              projection={projection}
              state={worstState}
              resetsAt={weekly?.resetsAt ?? null}
              now={now}
            />

            <HistoryStrip history={history} windowKey="7d" now={now} compact />

            <div class="wick-rule" />

            <TelegramCard
              connected={telegram.connected}
              threshold={telegram.threshold}
              alsoOnReset={telegram.alsoOnReset}
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
            >
              <GearIcon />
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
