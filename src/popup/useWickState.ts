import { useEffect, useState } from 'preact/hooks';
import { TELEGRAM_ORIGIN_PATTERN } from '~/background/telegram';
import { readState, writeSettings } from '~/background/store';
import type { ConnectOutcome, RuntimeMessage, RuntimeResponse } from '~/core/messages';
import { DEFAULT_SETTINGS, type Settings, type WickState } from '~/core/types';

/**
 * Live extension state for the interface.
 *
 * Reads `chrome.storage.local` directly rather than asking the service worker
 * for it. Presentation reads from the store and never fetches — and storage is
 * already the seam every other module writes through, so going through a
 * message round-trip would add a hop and a failure mode without adding a
 * guarantee.
 *
 * It does send one message: a refresh request on open. A popup that shows a
 * number from fifteen minutes ago is worse than one that shows it and then
 * corrects itself a second later.
 */

export interface WickStateHandle {
  state: WickState;
  /** False until the first read completes, so the interface can hold still. */
  ready: boolean;
  /** Persist a settings change. Optimistic — storage is local and does not fail. */
  update(patch: Partial<Settings>): void;
}

const EMPTY: WickState = {
  snapshot: null,
  history: [],
  settings: DEFAULT_SETTINGS,
  status: { kind: 'never-run' },
};

export function useWickState(): WickStateHandle {
  const [state, setState] = useState<WickState>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;

    const load = () => {
      void readState().then((next) => {
        if (!live) return;
        setState(next);
        setReady(true);
      });
    };

    load();

    // Any write by the collector, the icon renderer or the alert dispatcher
    // lands in storage, so one subscription covers all of them.
    const onChanged = (_changes: unknown, area: string) => {
      if (area === 'local') load();
    };
    chrome.storage.onChanged.addListener(onChanged);

    void sendToWorker({ type: 'wick:refresh' });

    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    // Applied locally first so a toggle responds under the finger; the storage
    // write comes back through the subscription above and confirms it.
    setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    void writeSettings(patch);
  };

  return { state, ready, update };
}

/**
 * Hand a pasted bot token to the worker.
 *
 * Two steps, in this order and in this place. The host permission is requested
 * here because `chrome.permissions.request` only works inside a user gesture,
 * and the Connect click is the only gesture Wick gets — a service worker has
 * none. The verification and chat lookup are the worker's job: it owns the
 * Telegram client and the settings write, and the token makes one trip across
 * this boundary and never comes back.
 *
 * A declined grant is a decision, not a failure. Nothing is written and the
 * user can grant it on the next attempt.
 */
export async function connectTelegram(botToken: string): Promise<ConnectOutcome> {
  if (!(await grantTelegramOrigin())) return 'not-permitted';

  const reply = await sendToWorker({ type: 'wick:telegram-connect', botToken });
  if (reply === null || !reply.ok) return 'unavailable';
  return 'outcome' in reply ? reply.outcome : 'unavailable';
}

/**
 * Finish a connection whose token is already stored.
 *
 * Asks for the origin again for the same reason `connectTelegram` does — this
 * is a separate click and therefore a separate gesture, and `request` resolves
 * true without prompting for a grant the user has already given.
 */
export async function finishTelegram(): Promise<ConnectOutcome> {
  if (!(await grantTelegramOrigin())) return 'not-permitted';

  const reply = await sendToWorker({ type: 'wick:telegram-finish' });
  if (reply === null || !reply.ok) return 'unavailable';
  return 'outcome' in reply ? reply.outcome : 'unavailable';
}

/** Forget the token. Fire and forget; the settings write comes back through storage. */
export function disconnectTelegram(): void {
  void sendToWorker({ type: 'wick:telegram-disconnect' });
}

/**
 * Ask for the Telegram origin.
 *
 * Called synchronously from the click, with no `await` in front of it — not
 * even a `permissions.contains` check first. Chrome requires
 * `permissions.request` to run inside the user gesture, and an awaited call
 * before it spends the gesture and makes this one throw. The check would have
 * been redundant anyway: `request` resolves `true` without prompting for a
 * permission the user has already granted.
 */
async function grantTelegramOrigin(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [TELEGRAM_ORIGIN_PATTERN] });
  } catch {
    // A browser without optional host permissions, or a call that has lost its
    // gesture. Either way Wick does not have the grant.
    return false;
  }
}

/**
 * Send a message to the service worker, swallowing the failure when there is
 * nobody listening.
 *
 * An MV3 worker that has been torn down and is still waking up will reject the
 * send. For the refresh on open the popup does not care — the refresh is an
 * optimisation and storage already holds a usable answer — so the failure comes
 * back as `null` and each caller decides whether that matters.
 */
async function sendToWorker(message: RuntimeMessage): Promise<RuntimeResponse | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as RuntimeResponse;
  } catch {
    // No receiver. Nothing to do and nothing worth telling the user.
    return null;
  }
}
