import { thresholdState } from '~/core/normalise';
import { remainingFor } from '~/assets/mark';
import { GearIcon } from './components/GearIcon';
import { HistoryStrip } from './components/HistoryStrip';
import { Mark } from './components/Mark';
import { Projection } from './components/Projection';
import { TelegramCard } from './components/TelegramCard';
import { UsageMeter } from './components/UsageMeter';
import {
  PLACEHOLDER_PLAN,
  PLACEHOLDER_STATS,
  PLACEHOLDER_TELEGRAM,
  placeholderHistory,
  placeholderProjection,
  placeholderWindows,
} from './placeholder';

/**
 * The popup — artboard 02 of the design archive, at its own width.
 *
 * Reproduces the expanded panel: header, two meters, the forecast, three stats,
 * a week of history, and alert status. The panel's own frame (16px radius, 1px
 * border, drop shadow) is dropped here because the popup window already
 * provides one; the injected sidebar panel keeps it. Recorded in docs/design.md.
 *
 * **Every number below is a placeholder.** Presentation reads from the store
 * and never fetches; the store is wired up in M3.
 */
export function App() {
  // Read once per open rather than per render: a popup lives for seconds, and a
  // clock that ticks mid-render would make the reset line disagree with itself.
  const now = Date.now();

  const windows = placeholderWindows(now);
  const history = placeholderHistory(now);
  const projection = placeholderProjection(now);

  const weekly = windows[1];
  const remaining = remainingFor(windows.map((w) => w.utilization));
  const worstState = thresholdState(
    remaining === null ? null : 100 - remaining,
    weekly?.status ?? 'unknown',
  );

  return (
    <div class="wick-panel">
      <header class="wick-panel__header">
        <div class="wick-panel__brand">
          <span class="wick-mark-badge">
            <Mark remaining={remaining} state={worstState} />
          </span>
          <span class="wick-panel__title">Wick</span>
        </div>
        <span class="wick-badge">{PLACEHOLDER_PLAN}</span>
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

        <div class="wick-stats">
          <div class="wick-stat">
            <span class="wick-stat__label">Today</span>
            <span class="wick-stat__value">{PLACEHOLDER_STATS.today}</span>
          </div>
          <div class="wick-stat">
            <span class="wick-stat__label">Avg / day</span>
            <span class="wick-stat__value">{PLACEHOLDER_STATS.averagePerDay}</span>
          </div>
          <div class="wick-stat">
            <span class="wick-stat__label">Peak hr</span>
            <span class="wick-stat__value">{PLACEHOLDER_STATS.peakHour}</span>
          </div>
        </div>

        <HistoryStrip history={history} windowKey="7d" now={now} />

        <div class="wick-rule" />

        <TelegramCard
          connected={PLACEHOLDER_TELEGRAM.connected}
          threshold={PLACEHOLDER_TELEGRAM.threshold}
          alsoOnReset={PLACEHOLDER_TELEGRAM.alsoOnReset}
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
  );
}

