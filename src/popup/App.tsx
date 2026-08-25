import { useState } from 'preact/hooks';
import { remainingFor } from '~/assets/mark';
import { averageMessagesPerDay, messagesToday, peakHour } from '~/core/history';
import { thresholdState } from '~/core/normalise';
import { project } from '~/core/projection';
import { allowanceWindow } from '~/core/windows';
import type { CollectorStatus, LimitWindow } from '~/core/types';
import { GearIcon } from './components/GearIcon';
import { HistoryStrip } from './components/HistoryStrip';
import { Mark } from './components/Mark';
import { Projection } from './components/Projection';
import { Settings } from './components/Settings';
import { TelegramCard } from './components/TelegramCard';
import { UsageMeter } from './components/UsageMeter';
import {
  connectTelegram,
  disconnectTelegram,
  finishTelegram,
  testTelegram,
  useWickState,
} from './useWickState';

/**
 * The popup — artboard 02 of the design archive, at its own width.
 *
 * Reproduces the expanded panel: header, two meters, the forecast, three stats,
 * a week of history, and alert status. The panel's own frame (16px radius, 1px
 * border, drop shadow) is dropped here because the popup window already
 * provides one; the injected sidebar panel keeps it. Recorded in docs/design.md.
 *
 * Every number comes from `chrome.storage.local` by way of `useWickState`.
 * Presentation reads from the store and never fetches: the one message this
 * surface sends is a refresh request, and the one it sends on the user's behalf
 * is the connect code.
 *
 * The settings screen replaces this view rather than floating over it. A 400px
 * modal does not fit a 372px popup — docs/design.md deviation 3.
 */
export function App() {
  const { state, ready, update } = useWickState();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Read once per open rather than per render: a popup lives for seconds, and a
  // clock that ticked on every state change would make the reset line disagree
  // with itself while the user is reading it.
  const [now] = useState(() => Date.now());

  if (settingsOpen) {
    return (
      <Settings
        settings={state.settings}
        onChange={update}
        onConnect={connectTelegram}
        onFinish={finishTelegram}
        onTest={testTelegram}
        onDisconnect={disconnectTelegram}
        onClose={() => setSettingsOpen(false)}
        version={chrome.runtime.getManifest().version}
      />
    );
  }

  const windows = state.snapshot?.windows ?? [];
  // The allowance window is the one the forecast is about, and the one the
  // history strip plots. Chosen by what it means, not by where the provider
  // happened to list it — see src/core/windows.ts.
  const weekly = allowanceWindow(windows) ?? undefined;
  const remaining = remainingFor(windows.map((w) => w.utilization));
  const worstState = thresholdState(
    remaining === null ? null : 100 - remaining,
    weekly?.status ?? 'unknown',
  );

  const projection =
    weekly === undefined
      ? null
      : project({ window: weekly, history: state.history, now });

  return (
    <div class="wick-panel">
      <header class="wick-panel__header">
        <div class="wick-panel__brand">
          <span class="wick-mark-badge">
            <Mark remaining={remaining} state={worstState} />
          </span>
          <span class="wick-panel__title">Wick</span>
        </div>
        {/* The archive badges the plan here. Nothing in docs/protocol.md reports
            one, so rather than print a guess the badge is simply absent. */}
      </header>

      <div class="wick-panel__body">
        {windows.length === 0 ? (
          <p class="wick-empty">{emptyMessage(state.status, ready)}</p>
        ) : (
          windows.map((window: LimitWindow) => (
            <UsageMeter key={window.key} window={window} now={now} />
          ))
        )}

        {projection !== null && weekly !== undefined && (
          <Projection
            projection={projection}
            state={worstState}
            resetsAt={weekly.resetsAt}
            now={now}
          />
        )}

        <div class="wick-stats">
          <div class="wick-stat">
            <span class="wick-stat__label">Today</span>
            <span class="wick-stat__value">{count(messagesToday(state.history, now))}</span>
          </div>
          <div class="wick-stat">
            <span class="wick-stat__label">Avg / day</span>
            <span class="wick-stat__value">
              {count(averageMessagesPerDay(state.history, now))}
            </span>
          </div>
          <div class="wick-stat">
            <span class="wick-stat__label">Peak hr</span>
            <span class="wick-stat__value">{hour(peakHour(state.history))}</span>
          </div>
        </div>

        <HistoryStrip history={state.history} windowKey={weekly?.key ?? ''} now={now} />

        <div class="wick-rule" />

        <TelegramCard
          connected={state.settings.botToken !== null && state.settings.chatId !== null}
          threshold={state.settings.alertThreshold}
          alsoOnReset={state.settings.alertOnReset}
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
    </div>
  );
}

/**
 * Why there is nothing to show.
 *
 * Four different silences, and the user can act on three of them. Saying
 * "0%" for any of them would be a confident wrong number.
 */
function emptyMessage(status: CollectorStatus, ready: boolean): string {
  if (!ready) return 'Reading…';

  switch (status.kind) {
    case 'signed-out':
      return 'Sign in to claude.ai and Wick will pick your limits up on the next check.';
    case 'error':
      return `Could not read your limits: ${status.message}`;
    case 'never-run':
      return 'No reading yet. Open claude.ai and Wick will check within the minute.';
    case 'ok':
      // Collection worked and reported nothing — an account that meters nothing,
      // or a response whose shape has moved. Either way, not a zero.
      return 'Nothing to report. Your account did not return any limit windows.';
  }
}

/** A count, or an honest gap. Never a zero standing in for "we do not know". */
function count(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** An hour of the local day, as the archive writes it: `14:00`. */
function hour(value: number | null): string {
  return value === null ? '—' : `${String(value).padStart(2, '0')}:00`;
}
