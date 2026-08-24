/**
 * Threshold alerts: local notifications, and Telegram via the relay.
 *
 * Never holds a Telegram bot token. See
 * docs/decisions/0002-telegram-relay-not-bot-token.md.
 */

/** Subscribe to snapshot changes and dispatch alerts when thresholds are crossed. */
export function initAlerts(): void {
  // M6.
}
