import { useState } from 'preact/hooks';
import type { RelayConnectOutcome } from '~/core/messages';
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
 * How a connect attempt ended. The view renders it; the worker decides it.
 *
 * Defined at the boundary rather than here, so the two ends cannot disagree
 * about what the possible answers are.
 */
export type ConnectOutcome = RelayConnectOutcome;

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
   * Redeem a connect code. Presentation never fetches — the view collects the
   * code and hands it to the worker, which owns the relay client and the
   * storage write. Absent means the connect flow is not wired up yet, and the
   * field is disabled rather than pretending to work.
   */
  onConnect?: (code: string) => Promise<ConnectOutcome>;
  /** Revoke the relay token and clear it locally. */
  onDisconnect?: () => void;
  /** Leave the settings view. */
  onClose?: () => void;
  /** Shown in the footer, as the archive shows `v0.1.0`. */
  version?: string;
}

/**
 * The settings screen — artboard 03, as a full-popup view.
 *
 * Four groups, one screen, no tabs, in the archive's order: Telegram, Alert me
 * at, Sidebar, Project. Two deliberate departures from the artboard, both
 * already recorded:
 *
 * 1. **A view, not a modal.** A 400px card does not fit a 380px popup.
 *    docs/design.md deviation 3.
 * 2. **No bot-token field and no chat-ID field.** The archive takes both and
 *    keeps them in `chrome.storage.local`, which is plain JSON on disk holding
 *    an unscoped bearer credential. What this screen takes instead is a
 *    short-lived connect code, exchanged for a revocable per-user token. See
 *    docs/decisions/0002-telegram-relay-not-bot-token.md.
 *
 * The archive's Save button also goes. Every control here writes through
 * `onChange` as it is touched, so a Save button would only offer the chance to
 * lose a change by closing the popup — and a popup closes when you look away
 * from it.
 *
 * This component holds no state except the half-typed connect code and the
 * result of the last attempt. It reads no storage and performs no I/O.
 */
export function Settings({
  settings,
  onChange,
  onConnect,
  onDisconnect,
  onClose,
  version,
}: SettingsProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const connected = settings.relayToken !== null;

  async function submitCode(): Promise<void> {
    if (onConnect === undefined || busy) return;

    const trimmed = code.trim();
    if (trimmed === '') return;

    setBusy(true);
    setProblem(null);
    const outcome = await onConnect(trimmed);
    setBusy(false);

    if (outcome === 'ok') {
      setCode('');
      return;
    }
    setProblem(PROBLEM_COPY[outcome]);
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
        {/* ---- Telegram ---- */}
        <section class="wick-settings__group">
          <h2 class="wick-settings__eyebrow">Telegram</h2>

          <div class="wick-settings__field">
            <div class="wick-settings__status-row">
              <span
                class={`wick-telegram__status${connected ? '' : ' wick-telegram__status--off'}`}
              >
                <span class="wick-telegram__dot" />
                {connected ? (settings.relayLabel ?? 'Connected') : 'Not connected'}
              </span>

              {connected && onDisconnect !== undefined && (
                <button
                  type="button"
                  class="wick-button wick-settings__inline-button"
                  onClick={onDisconnect}
                >
                  Disconnect
                </button>
              )}
            </div>

            {connected ? (
              <p class="wick-settings__note">
                Alerts go through the relay, which holds no usage history. Disconnecting revokes
                this installation&rsquo;s token.
              </p>
            ) : (
              <form
                class="wick-settings__field"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCode();
                }}
              >
                <div class="wick-settings__row">
                  <input
                    type="text"
                    class="wick-settings__input"
                    placeholder="Connect code"
                    value={code}
                    disabled={onConnect === undefined || busy}
                    autocomplete="off"
                    spellcheck={false}
                    aria-label="Connect code"
                    onInput={(event) => setCode(event.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    class="wick-button wick-settings__inline-button wick-settings__primary"
                    disabled={onConnect === undefined || busy || code.trim() === ''}
                  >
                    {busy ? 'Connecting' : 'Connect'}
                  </button>
                </div>

                <p class="wick-settings__note">
                  {onConnect === undefined ? (
                    'Connect from the Wick popup in your toolbar. Granting access to the relay needs a permission prompt, and only the popup can raise one.'
                  ) : (
                    <>
                      Message the Wick bot on Telegram, send <code>/start</code>, and paste the code
                      it replies with. Wick never holds a bot token &mdash; the code becomes a
                      per-user token you can revoke.
                    </>
                  )}
                </p>
              </form>
            )}

            {problem !== null && <p class="wick-settings__note wick-settings__note--problem">{problem}</p>}
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
            <a
              class="wick-settings__link"
              href={LEADERBOARD_URL}
              target="_blank"
              rel="noreferrer"
            >
              View leaderboard
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
 * A rejected code is much more often expired than mistyped, so the copy leads
 * with that rather than implying the user cannot type.
 */
const PROBLEM_COPY: Record<Exclude<ConnectOutcome, 'ok'>, string> = {
  'invalid-code': 'That code did not work. Codes expire after a few minutes — ask the bot for a new one.',
  unavailable: 'Could not reach the relay. Nothing was changed.',
  'not-permitted': 'Wick needs permission to reach the relay before it can connect.',
};

/**
 * Drawn rather than typed, for the same reason as the gear: the archive uses a
 * character (×) and Windows may route it through a font Wick does not control.
 * See docs/design.md deviation 6.
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
