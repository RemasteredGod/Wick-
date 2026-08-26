import { useState } from 'preact/hooks';
import type { BoardOutcome as BoundaryOutcome } from '~/core/messages';
import { ALERT_THRESHOLD_CHOICES, type DisplayOptions, type Settings } from '~/core/types';

/**
 * Where the Project links point.
 *
 * Both the repository URL and the Ko-fi handle are the project's own. The
 * handle is displayed as well as linked (the archive's row shows it under the
 * label, ext:222), so it is written once here rather than twice in the markup.
 */
const REPO_URL = 'https://github.com/RemasteredGod/Wick-';
const ISSUES_URL = `${REPO_URL}/issues`;
const LEADERBOARD_URL = 'https://usewick.lol';
const KOFI_HANDLE = 'ko-fi.com/remasteredgod';
const KOFI_URL = `https://${KOFI_HANDLE}`;

/**
 * How a leaderboard action ended. The view renders it; the worker decides it.
 *
 * Defined at the boundary rather than here, so the two ends cannot disagree
 * about what the possible answers are.
 */
export type BoardOutcome = BoundaryOutcome;

/** Labels for the display toggles, in the archive's order (ext:339). */
const DISPLAY_OPTIONS: ReadonlyArray<{ key: keyof DisplayOptions; label: string }> = [
  { key: 'session', label: 'Session bar' },
  { key: 'weekly', label: 'Weekly bar' },
  { key: 'forecast', label: 'Pace forecast' },
  { key: 'sparkline', label: '7-day sparkline' },
];

interface SettingsProps {
  settings: Settings;
  /** Applied immediately. There is no Save button; see the note below. */
  onChange(patch: Partial<Settings>): void;
  /**
   * Join the leaderboard. Presentation never fetches — the view collects the
   * click, and the worker asks the board for a token and a name and writes
   * settings. Absent means the flow is not wired up on this surface, and the
   * button is disabled rather than pretending to work.
   */
  onJoin?: () => Promise<BoardOutcome>;
  /** Leave: delete the published rows, then forget the token locally. */
  onLeave?: () => Promise<BoardOutcome>;
  /** Leave the settings view. */
  onClose?: () => void;
  /** Shown in the footer, as the archive shows `v0.1.0`. */
  version?: string;
}

/**
 * The settings screen — artboard 03, as a full-popup view.
 *
 * Four groups, one screen, no tabs: Leaderboard, Alert me at, Sidebar, Project.
 * Two deliberate departures from the artboard, both already recorded:
 *
 * 1. **A view, not a modal.** A 400px card does not fit a 380px popup.
 *    the design notes deviation 3.
 * 2. **No Telegram group at all.** The archive's first group takes a bot token
 *    and a chat ID. Alerts are local notifications now — they need no
 *    credential, no host permission and no setup, so there is nothing to
 *    configure and a group saying so would be a group that says nothing. The
 *    leaderboard takes its place because it is the one thing on this screen
 *    that sends anything anywhere.
 *
 * The archive's Save button also goes. Every control here writes through
 * `onChange` as it is touched, so a Save button would only offer the chance to
 * lose a change by closing the popup — and a popup closes when you look away
 * from it.
 *
 * This component holds no state except whether a request is in flight and the
 * result of the last one. It reads no storage and performs no I/O.
 */
export function Settings({
  settings,
  onChange,
  onJoin,
  onLeave,
  onClose,
  version,
}: SettingsProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Enrolled means a participant token is held. There is no half state. */
  const enrolled = settings.boardToken !== null;

  async function run(attempt: () => Promise<BoardOutcome>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await attempt();
    setBusy(false);
    setProblem(outcome === 'ok' ? null : PROBLEM_COPY[outcome]);
  }

  function toggleDisplay(key: keyof DisplayOptions): void {
    onChange({ display: { ...settings.display, [key]: !settings.display[key] } });
  }

  return (
    <div class="wick-settings">
      <header class="wick-settings__header">
        <span class="wick-settings__title">Settings</span>
        {onClose !== undefined && (
          <button
            type="button"
            class="wick-settings__close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close settings"
          >
            <CloseIcon />
          </button>
        )}
      </header>

      <div class="wick-settings__body">
        {/* ---- Leaderboard ---- */}
        <section class="wick-settings__group">
          <h2 class="wick-settings__eyebrow">Leaderboard</h2>

          <div class="wick-settings__field">
            <div class="wick-settings__status-row">
              <span class={`wick-board__status${enrolled ? '' : ' wick-board__status--off'}`}>
                <span class="wick-board__dot" />
                {enrolled ? (settings.boardName ?? 'Joined') : 'Not joined'}
              </span>

              {onJoin !== undefined && onLeave !== undefined && (
                <button
                  type="button"
                  class={`wick-button wick-settings__inline-button${
                    enrolled ? '' : ' wick-settings__primary'
                  }`}
                  disabled={busy}
                  onClick={() => void run(enrolled ? onLeave : onJoin)}
                >
                  {busy ? (enrolled ? 'Leaving' : 'Joining') : enrolled ? 'Leave' : 'Join'}
                </button>
              )}
            </div>

            {onJoin === undefined ? (
              <p class="wick-settings__note">
                Join from the Wick popup in your toolbar. Reaching the board needs a permission
                prompt, and only the popup can raise one.
              </p>
            ) : enrolled ? (
              <>
                <p class="wick-settings__note">
                  Wick publishes one number a day: how many messages you sent. Not what you sent,
                  not when, not which model, not how much of your limit you used.
                </p>
                <p class="wick-settings__note">
                  You are <strong>{settings.boardName ?? 'unnamed'}</strong> on the board, for{' '}
                  <strong>{settings.boardEmail ?? 'this account'}</strong>. The board keeps that
                  address as your profile's key, which is what makes this the same profile in every
                  browser you sign into. It is never shown on a public page. Sign into a different
                  Claude account and you get a different profile.
                </p>
                <p class="wick-settings__note">
                  Nothing checks that the address is yours, so treat the board as self-reported fun
                  rather than a record: somebody who knows it could publish under your name.
                </p>
                <p class="wick-settings__note">
                  Leaving deletes your profile, your address, and every day you published — in
                  every browser, not just this one.
                </p>
              </>
            ) : (
              <p class="wick-settings__note">
                Optional, and off. Publishes a daily message count under an assigned name, keyed on
                your Claude account's email so it is one profile across your browsers. Nothing
                leaves this machine until you press Join.
              </p>
            )}

            <div class="wick-settings__links">
              <a
                class="wick-settings__link"
                href={LEADERBOARD_URL}
                target="_blank"
                rel="noreferrer"
              >
                View leaderboard
              </a>
            </div>

            {problem !== null && (
              <p class="wick-settings__note wick-settings__note--problem">{problem}</p>
            )}
          </div>
        </section>

        {/* ---- Alert me at ---- */}
        <section class="wick-settings__group">
          <h2 class="wick-settings__eyebrow">Alert me at</h2>

          <div class="wick-settings__chips">
            {ALERT_THRESHOLD_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                class={`wick-settings__chip${
                  settings.alertThreshold === choice ? ' wick-settings__chip--on' : ''
                }`}
                aria-pressed={settings.alertThreshold === choice}
                onClick={() => onChange({ alertThreshold: choice })}
              >
                {choice}%
              </button>
            ))}
          </div>

          <div class="wick-settings__switch-row">
            <span class="wick-settings__switch-label">Also ping on session reset</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.alertOnReset}
              aria-label="Also ping on session reset"
              class={`wick-settings__toggle${
                settings.alertOnReset ? ' wick-settings__toggle--on' : ''
              }`}
              onClick={() => onChange({ alertOnReset: !settings.alertOnReset })}
            >
              <span class="wick-settings__knob" />
            </button>
          </div>
        </section>

        {/* ---- Sidebar ---- */}
        <section class="wick-settings__group">
          <h2 class="wick-settings__eyebrow">Sidebar</h2>

          <div class="wick-settings__options">
            {DISPLAY_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="checkbox"
                aria-checked={settings.display[key]}
                class="wick-settings__option"
                onClick={() => toggleDisplay(key)}
              >
                <span
                  class={`wick-settings__box${
                    settings.display[key] ? ' wick-settings__box--on' : ''
                  }`}
                >
                  {settings.display[key] && <CheckIcon />}
                </span>
                <span class="wick-settings__option-label">{label}</span>
              </button>
            ))}
          </div>
        </section>

        <div class="wick-rule" />

        {/* ---- Project ---- */}
        <section class="wick-settings__group">
          <h2 class="wick-settings__eyebrow">Project</h2>

          <div class="wick-settings__links">
            <a class="wick-settings__link" href={REPO_URL} target="_blank" rel="noreferrer">
              Star on GitHub
            </a>
            <a class="wick-settings__link" href={ISSUES_URL} target="_blank" rel="noreferrer">
              Report an issue
            </a>
          </div>

          {/* An ask, not an ad: it sits under Project, at the bottom, once. */}
          <a class="wick-settings__support" href={KOFI_URL} target="_blank" rel="noreferrer">
            <span class="wick-settings__support-label">Support on Ko-fi</span>
            <span class="wick-settings__support-handle">{KOFI_HANDLE}</span>
          </a>
        </section>
      </div>

      <footer class="wick-settings__footer">
        <span class="wick-settings__version">{version === undefined ? '' : `v${version}`}</span>
        {onClose !== undefined && (
          <button
            type="button"
            class="wick-button wick-settings__inline-button wick-settings__primary"
            onClick={onClose}
          >
            Done
          </button>
        )}
      </footer>
    </div>
  );
}

/**
 * What went wrong, in the user's terms.
 *
 * Neither failure is the user's mistake, so neither is worded as one. Both say
 * what state they are left in, because the thing a half-finished join needs to
 * answer is "did anything happen?".
 */
const PROBLEM_COPY: Record<Exclude<BoardOutcome, 'ok'>, string> = {
  unavailable: 'Could not reach the leaderboard. Nothing was changed.',
  'not-permitted': 'Wick needs permission to reach the leaderboard before it can join.',
};

/**
 * Drawn rather than typed, for the same reason as the gear: the archive uses a
 * character (×) and Windows may route it through a font Wick does not control.
 * See the design notes deviation 6.
 */
function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M2 2 L10 10 M10 2 L2 10"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        fill="none"
      />
    </svg>
  );
}

/** The archive's ✓, drawn for the same reason. */
function CheckIcon() {
  return (
    <svg
      class="wick-settings__check"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M1.5 5.2 L4 7.5 L8.5 2.5"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  );
}
