import { useState } from 'preact/hooks';
import type { ConnectOutcome as BoundaryOutcome } from '~/core/messages';
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
export type ConnectOutcome = BoundaryOutcome;

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
   * Hand a pasted bot token to the worker. Presentation never fetches — the
   * view collects the token and the worker verifies it, finds the chat and
   * writes settings. Absent means the flow is not wired up here, and the field
   * is disabled rather than pretending to work.
   */
  onConnect?: (botToken: string) => Promise<ConnectOutcome>;
  /**
   * Retry chat discovery for a token already stored. The second half of the
   * flow, after the user has messaged their bot.
   */
  onFinish?: () => Promise<ConnectOutcome>;
  /** Send a test message, so the user sees something arrive. */
  onTest?: () => Promise<ConnectOutcome>;
  /** Forget the token and chat locally. Nothing is revoked — see ADR 0009. */
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
  onFinish,
  onTest,
  onDisconnect,
  onClose,
  version,
}: SettingsProps) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  /**
   * Three states, not two.
   *
   * `awaiting` is the one the old two-state version could not express: Telegram
   * has vouched for the token, but the user has not messaged their bot yet so
   * there is no chat to send to. That is the commonest point to be at during
   * setup, and showing it as "not connected" made the token look rejected when
   * nothing was wrong with it.
   */
  const stage: 'empty' | 'awaiting' | 'connected' =
    settings.botToken === null ? 'empty' : settings.chatId === null ? 'awaiting' : 'connected';

  async function run(attempt: () => Promise<ConnectOutcome>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await attempt();
    setBusy(false);

    if (outcome === 'ok') {
      setToken('');
      return;
    }
    setSent(false);
    // `no-chat` is not shown as a problem: it is the expected result of a first
    // attempt, and the awaiting panel already says what to do about it.
    setProblem(outcome === 'no-chat' ? null : PROBLEM_COPY[outcome]);
  }

  async function submitToken(): Promise<void> {
    if (onConnect === undefined) return;
    const trimmed = token.trim();
    if (trimmed === '') return;
    await run(() => onConnect(trimmed));
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
                class={`wick-telegram__status${stage === 'connected' ? '' : ' wick-telegram__status--off'}`}
              >
                <span class="wick-telegram__dot" />
                {stage === 'connected'
                  ? (settings.chatLabel ?? 'Connected')
                  : stage === 'awaiting'
                    ? 'Waiting for your first message'
                    : 'Not connected'}
              </span>

              {stage !== 'empty' && onDisconnect !== undefined && (
                <button
                  type="button"
                  class="wick-button wick-settings__inline-button"
                  onClick={onDisconnect}
                >
                  {stage === 'connected' ? 'Disconnect' : 'Clear'}
                </button>
              )}
            </div>

            {stage === 'empty' ? (
              <form
                class="wick-settings__field"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitToken();
                }}
              >
                <div class="wick-settings__row">
                  <input
                    type="text"
                    class="wick-settings__input"
                    placeholder="Bot token from @BotFather"
                    value={token}
                    disabled={onConnect === undefined || busy}
                    autocomplete="off"
                    spellcheck={false}
                    aria-label="Telegram bot token"
                    onInput={(event) => setToken(event.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    class="wick-button wick-settings__inline-button wick-settings__primary"
                    disabled={onConnect === undefined || busy || token.trim() === ''}
                  >
                    {busy ? 'Checking' : 'Connect'}
                  </button>
                </div>

                <p class="wick-settings__note">
                  {onConnect === undefined ? (
                    'Connect from the Wick popup in your toolbar. Granting access to Telegram needs a permission prompt, and only the popup can raise one.'
                  ) : (
                    <>
                      Message <strong>@BotFather</strong>, send <code>/newbot</code>, and paste the
                      token it gives you.
                    </>
                  )}
                </p>
              </form>
            ) : (
              <>
                {/* The token stays on screen once accepted, greyed and masked.
                    It is the only evidence the field was filled in, and the
                    secret half is never rendered. */}
                <div class="wick-settings__row">
                  <input
                    type="text"
                    class="wick-settings__input"
                    value={maskToken(settings.botToken)}
                    disabled
                    readonly
                    aria-label="Telegram bot token, saved"
                  />
                  {stage === 'awaiting' && onFinish !== undefined && (
                    <button
                      type="button"
                      class="wick-button wick-settings__inline-button wick-settings__primary"
                      disabled={busy}
                      onClick={() => void run(onFinish)}
                    >
                      {busy ? 'Checking' : 'Finish'}
                    </button>
                  )}
                </div>

                {stage === 'awaiting' ? (
                  <p class="wick-settings__note">
                    Token accepted{settings.chatLabel === null ? '' : ` for ${settings.chatLabel}`}.
                    Now open Telegram, send your bot <code>/start</code>, and press Finish &mdash;
                    Telegram will not let a bot message you until you have written to it first.
                  </p>
                ) : (
                  <>
                    <div class="wick-settings__row">
                      {onTest !== undefined && (
                        <button
                          type="button"
                          class="wick-button wick-settings__inline-button"
                          disabled={busy}
                          onClick={() => {
                            void (async () => {
                              setBusy(true);
                              setProblem(null);
                              const outcome = await onTest();
                              setBusy(false);
                              setSent(outcome === 'ok');
                              if (outcome !== 'ok') setProblem(PROBLEM_COPY[outcome]);
                            })();
                          }}
                        >
                          {busy ? 'Sending' : sent ? 'Sent' : 'Send test message'}
                        </button>
                      )}
                    </div>

                    <p class="wick-settings__note">
                      Connected. Wick sent your current usage when you finished setup &mdash; if it
                      arrived, alerts will too. Nothing passes through a server.
                    </p>

                    <p class="wick-settings__note">
                      In Telegram, send your bot <code>/weekly</code> or <code>/daily</code> to ask
                      for usage. Replies come from this extension rather than a server, so Chrome
                      has to be open and an answer can take a few minutes.
                    </p>

                    <p class="wick-settings__note">
                      Disconnecting forgets the token here; to kill the bot itself, revoke it in
                      @BotFather.
                    </p>
                  </>
                )}
              </>
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
/**
 * Show enough of a token to recognise it, and none of the secret.
 *
 * A Telegram token is `<bot id>:<secret>`. The id half identifies which bot
 * without being the credential, so it is the half worth showing.
 */
function maskToken(botToken: string | null): string {
  if (botToken === null) return '';
  const [id] = botToken.split(':');
  return id === undefined || id === botToken ? '••••••••' : `${id}:${'•'.repeat(12)}`;
}

const PROBLEM_COPY: Record<Exclude<ConnectOutcome, 'ok'>, string> = {
  'bad-token': 'Telegram did not accept that token. Copy it again from @BotFather.',
  // The commonest first attempt, and the only one where nothing is wrong —
  // the user simply has a step left to do. Worded as an instruction, not an error.
  'no-chat': 'Send your bot a message on Telegram, then press Connect again.',
  unavailable: 'Could not reach Telegram. Nothing was changed.',
  'not-permitted': 'Wick needs permission to reach Telegram before it can connect.',
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
