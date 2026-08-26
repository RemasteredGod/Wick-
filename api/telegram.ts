/**
 * The Telegram webhook, as a Vercel function.
 *
 * A thin seam and nothing more: read the environment, build the store, hand the
 * body to `handleUpdate`. All the behaviour is in relay/, which is tested
 * without a network or a database — this file exists to translate between
 * Vercel's request and that.
 *
 * This is the **v2 leaderboard bot**, which is yours and needs a webhook. It is
 * not the per-user bot each user creates for alerts (ADR 0009); that one talks
 * to their browser directly and never touches this deployment.
 */

import { handleUpdate } from '../relay/webhook.js';
import { configFromEnv, createSupabaseStore } from '../relay/supabase-store.js';
import { header, readJson, sendText, type Req, type Res } from '../relay/http.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed');
    return;
  }

  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const webhookSecret = process.env['TELEGRAM_WEBHOOK_SECRET'];

  if (botToken === undefined || webhookSecret === undefined) {
    // 500 rather than 200: this is a deployment that cannot work, and Telegram
    // retrying is the correct behaviour once the variables are set.
    sendText(res, 500, 'not configured');
    return;
  }

  const body = await readJson(req);
  if (body === null) {
    // Unparseable bodies are acknowledged, not retried. Whatever sent it, a
    // redelivery will not be more parseable than the first attempt.
    sendText(res, 200, 'ok');
    return;
  }

  let store;
  try {
    store = createSupabaseStore(configFromEnv(process.env));
  } catch {
    sendText(res, 500, 'not configured');
    return;
  }

  const result = await handleUpdate(body, header(req, 'x-telegram-bot-api-secret-token'), {
    config: { botToken, webhookSecret },
    store,
    now: Date.now(),
    today: new Date().toISOString().slice(0, 10),
    random: cryptoRandom,
  });

  sendText(res, result.status, result.status === 403 ? 'forbidden' : 'ok');
}

/**
 * A float in [0, 1) from the platform CSPRNG.
 *
 * Not `Math.random`: connect codes and assigned names are drawn from this, and
 * either being predictable from the time it was generated defeats the attempt
 * limit and lets someone find a profile before it is shared.
 */
function cryptoRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}
