interface TelegramCardProps {
  /** Whether the relay has a live token for this installation. */
  connected: boolean;
  /** Weekly threshold, in percent, at which an alert is sent. */
  threshold: number;
  /** Whether a message also goes out when a window resets. */
  alsoOnReset: boolean;
}

/**
 * Alert status, and what it will do.
 *
 * **No bot token appears here, and none ever should.** The archive's settings
 * card takes a token from @BotFather and stores it in `chrome.storage.local`;
 * extension storage is trivially extractable and a Telegram bot token is an
 * unscoped bearer credential the user cannot contain once it leaks. Wick holds
 * a revocable per-user relay token instead. See
 * ADR 0002 (relay, not a stored bot token).
 *
 * Status: M6 builds the relay and the connect flow. This renders the state.
 */
export function TelegramCard({ connected, threshold, alsoOnReset }: TelegramCardProps) {
  return (
    <div class="wick-telegram">
      <div class="wick-telegram__head">
        <span class="wick-telegram__title">Telegram alerts</span>
        <span class={`wick-telegram__status${connected ? '' : ' wick-telegram__status--off'}`}>
          <span class="wick-telegram__dot" />
          {connected ? 'Connected' : 'Not set up'}
        </span>
      </div>

      <div class="wick-telegram__note">
        {connected
          ? `Alerts at ${threshold}% weekly${alsoOnReset ? ' and on reset' : ''}.`
          : 'Optional. Wick tracks fine without it.'}
      </div>
    </div>
  );
}
