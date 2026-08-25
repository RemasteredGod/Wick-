/**
 * Run the bot on your laptop.
 *
 * No webhook, no domain, no tunnel, no deployment. This opens a long-polling
 * connection to Telegram and dispatches through exactly the same handlers the
 * production webhook uses, so what you try here is what will ship.
 *
 *     TELEGRAM_BOT_TOKEN=... node --experimental-strip-types relay/dev.ts
 *
 * Storage is in-memory and dies with the process — see memory-store.ts. Every
 * restart is a fresh world, which is usually what you want while developing.
 *
 * If a webhook is already registered this exits and says so, because Telegram
 * refuses to let both transports run at once.
 */

import { createMemoryStore } from './memory-store';
import { deleteWebhook, dispatch, nextOffset, pollOnce } from './polling';
import type { TelegramConfig } from './telegram';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (token === undefined || token === '') {
  console.error('TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather.');
  process.exit(1);
}

// Polling never checks this — it exists only to satisfy the shared config
// shape. See the note in polling.ts on why polling needs no shared secret.
const config: TelegramConfig = { botToken: token, webhookSecret: 'unused-when-polling' };

const store = createMemoryStore();
let offset = 0;
let running = true;

process.on('SIGINT', () => {
  running = false;
  console.log('\nStopping.');
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Crypto-grade, because an assigned name or code guessable from the clock is not one. */
function random(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

console.log('Wick bot — polling. Message your bot on Telegram. Ctrl-C to stop.');

while (running) {
  const result = await pollOnce(config, offset);

  if (!result.ok) {
    if (result.failure === 'webhook-conflict') {
      console.error(
        'A webhook is registered, so polling is refused. Removing it and retrying...',
      );
      if (!(await deleteWebhook(config))) {
        console.error('Could not delete the webhook. Stopping.');
        process.exit(1);
      }
      continue;
    }

    if (result.failure === 'bad-token') {
      console.error('Telegram rejected the token. Check TELEGRAM_BOT_TOKEN.');
      process.exit(1);
    }

    // A transient network problem. Wait a moment rather than spinning.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    continue;
  }

  offset = nextOffset(result.updates, offset);

  for (const update of result.updates) {
    const chatId = update.message?.chat?.id;
    const text = typeof update.message?.text === 'string' ? update.message.text : '';
    const reply = await dispatch(update, config, {
      store,
      now: Date.now(),
      today: today(),
      random,
    });

    if (reply !== null) {
      console.log(`[${String(chatId)}] ${text}`);
      console.log(`  -> ${reply.split('\n')[0] ?? ''}`);
    }
  }
}
