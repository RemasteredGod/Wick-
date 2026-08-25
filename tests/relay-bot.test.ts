import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  isCodeLive,
  isCodeShape,
  mintCode,
  normaliseCode,
  CODE_TTL_MS,
} from '../relay/codes';
import { handle, parseCommand, type Context } from '../relay/commands';
import { sendMessage, setWebhook, verifyWebhookSecret } from '../relay/telegram';
import { handleUpdate } from '../relay/webhook';
import { fold } from '../leaderboard/names';
import type { RelayStore, Profile } from '../relay/store';
import type { Standing } from '../leaderboard/ranking';

const config = { botToken: 'BOT:TOKEN', webhookSecret: 'shhh-a-long-secret' };

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

/** A fake store that records what was asked of it. */
function fakeStore(initial?: Partial<FakeState>) {
  const state: FakeState = {
    profile: null,
    taken: new Set<string>(),
    renameCodes: new Set<string>(),
    board: [],
    standing: null,
    calls: [],
    codes: [],
    ...initial,
  };

  const store: RelayStore = {
    async saveCode(chatId, code, mintedAt) {
      state.codes.push({ chatId, code, mintedAt });
      state.calls.push('saveCode');
    },
    async profile() {
      return state.profile;
    },
    async createProfile(_chatId, name) {
      state.profile = { name, digest: false };
      state.taken.add(name);
      state.calls.push('createProfile');
    },
    async setName(_chatId, name) {
      if (state.profile) state.profile.name = name;
      state.calls.push('setName');
    },
    async setDigest(_chatId, on) {
      if (state.profile) state.profile.digest = on;
      state.calls.push('setDigest');
    },
    async isNameTaken(folded) {
      return state.taken.has(folded);
    },
    async redeemRenameCode(code) {
      const had = state.renameCodes.delete(code);
      state.calls.push('redeemRenameCode');
      return had;
    },
    async board() {
      return state.board;
    },
    async standing() {
      return state.standing;
    },
    async deleteProfile() {
      state.profile = null;
      state.calls.push('deleteProfile');
    },
    async forget() {
      state.profile = null;
      state.calls.push('forget');
    },
  };

  return { store, state };
}

interface FakeState {
  profile: Profile | null;
  taken: Set<string>;
  renameCodes: Set<string>;
  board: Standing[];
  standing: Standing | null;
  calls: string[];
  codes: { chatId: number; code: string; mintedAt: number }[];
}

function context(store: RelayStore, random = sequence([0.5])): Context {
  return { store, now: 1_800_000_000_000, today: '2026-08-25', random };
}

/* ---- codes ---------------------------------------------------------------- */

describe('connect codes', () => {
  it('draws eight characters from the unambiguous alphabet', () => {
    const code = mintCode(sequence([0.1, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6]));
    expect(code).toHaveLength(CODE_LENGTH);
    for (const character of code) expect(CODE_ALPHABET).toContain(character);
  });

  it('excludes every confusable pair', () => {
    // Reading a code off a phone must never be a guess, because a wrong guess
    // spends one of five attempts.
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('normalises what a user typed without repairing it', () => {
    expect(normaliseCode(' k7qm2xpd ')).toBe('K7QM2XPD');
    // `O` is not in the alphabet, so this was mistyped. Silently turning it
    // into `0` would hide the mistake — and `0` is not in the alphabet either.
    expect(isCodeShape(normaliseCode('K7QM2XPO'))).toBe(false);
  });

  it('rejects codes of the wrong shape', () => {
    expect(isCodeShape('K7QM2XP')).toBe(false);
    expect(isCodeShape('K7QM2XPDX')).toBe(false);
    expect(isCodeShape('k7qm2xpd')).toBe(false);
    expect(isCodeShape('')).toBe(false);
  });

  it('expires after ten minutes', () => {
    const minted = 1_000_000;
    expect(isCodeLive(minted, minted + CODE_TTL_MS - 1)).toBe(true);
    expect(isCodeLive(minted, minted + CODE_TTL_MS)).toBe(false);
  });
});

/* ---- parsing -------------------------------------------------------------- */

describe('parseCommand', () => {
  it('reads the commands ADR 0006 and 0007 specify', () => {
    expect(parseCommand('/start')).toEqual({ kind: 'start' });
    expect(parseCommand('/me')).toEqual({ kind: 'me' });
    expect(parseCommand('/optin')).toEqual({ kind: 'optin' });
    expect(parseCommand('/optout')).toEqual({ kind: 'optout' });
    expect(parseCommand('/forget')).toEqual({ kind: 'forget' });
    expect(parseCommand('/leaderboard')).toEqual({ kind: 'leaderboard' });
  });

  it('strips the @botname suffix Telegram adds in groups', () => {
    // Without this the bot appears dead in every group it is added to.
    expect(parseCommand('/start@WickBot')).toEqual({ kind: 'start' });
    expect(parseCommand('/forget@WickBot  ')).toEqual({ kind: 'forget' });
  });

  it('reads digest arguments and reports state when there is none', () => {
    expect(parseCommand('/digest on')).toEqual({ kind: 'digest', on: true });
    expect(parseCommand('/digest OFF')).toEqual({ kind: 'digest', on: false });
    expect(parseCommand('/digest')).toEqual({ kind: 'digest', on: null });
    expect(parseCommand('/digest maybe')).toEqual({ kind: 'digest', on: null });
  });

  it('normalises a rename code but leaves the name alone', () => {
    expect(parseCommand('/rename k7qm2xpd Ash')).toEqual({
      kind: 'rename',
      code: 'K7QM2XPD',
      name: 'Ash',
    });
  });

  it('treats anything else as help rather than ignoring it', () => {
    expect(parseCommand('hello')).toEqual({ kind: 'help' });
    expect(parseCommand('/nonsense')).toEqual({ kind: 'help' });
    expect(parseCommand('')).toEqual({ kind: 'help' });
  });
});

/* ---- handling ------------------------------------------------------------- */

describe('handling', () => {
  it('mints and stores a code on /start, and never mentions a bot token', async () => {
    const { store, state } = fakeStore();
    const reply = await handle({ kind: 'start' }, 42, context(store));

    expect(state.codes).toHaveLength(1);
    expect(state.codes[0]?.chatId).toBe(42);
    expect(reply).toContain(state.codes[0]?.code ?? 'MISSING');
    // The archive's flow asked for a BotFather token. This one never does, and
    // says so rather than leaving the user wondering what is missing.
    expect(reply.toLowerCase()).not.toContain('botfather');
    expect(reply.toLowerCase()).toContain('never be asked for a bot token');
  });

  it('assigns a name on /optin rather than letting the user choose', async () => {
    const { store, state } = fakeStore();
    const reply = await handle({ kind: 'optin' }, 42, context(store));

    expect(state.profile?.name).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    expect(reply).toContain('assigned, not chosen');
    expect(reply).toContain('$1');
  });

  it('does not create a second profile for a chat already on the board', async () => {
    const { store, state } = fakeStore({ profile: { name: 'amber-ledger-0042', digest: false } });
    const reply = await handle({ kind: 'optin' }, 42, context(store));

    expect(reply).toContain('already');
    expect(state.calls).not.toContain('createProfile');
  });

  it('draws a different name when the first one is already taken', async () => {
    // Three random draws per candidate, so the sequence must be long enough
    // that a retry produces a genuinely different name rather than the same one.
    const draws = () => sequence([0.02, 0.5, 0.9, 0.37, 0.14, 0.66, 0.81, 0.23, 0.45]);

    const first = fakeStore();
    await handle({ kind: 'optin' }, 1, context(first.store, draws()));
    const firstName = first.state.profile?.name ?? '';
    expect(firstName).not.toBe('');

    // Same draws, but the first candidate is spoken for.
    const second = fakeStore({ taken: new Set([fold(firstName)]) });
    const reply = await handle({ kind: 'optin' }, 2, context(second.store, draws()));
    const secondName = second.state.profile?.name ?? '';

    expect(secondName).not.toBe('');
    expect(secondName).not.toBe(firstName);
    expect(reply).toContain('leaderboard as');
  });

  it('labels /me and /leaderboard as self-reported', async () => {
    const standing: Standing = {
      rank: 7,
      name: 'amber-ledger-0042',
      ranked: 12_345,
      counters: { input: 5_000, output: 7_345, cacheCreation: 900, cacheRead: 4_000_000 },
      sessions: 19,
      lastDay: '2026-08-25',
    };
    const { store } = fakeStore({
      profile: { name: 'amber-ledger-0042', digest: false },
      standing,
      board: [standing],
    });

    const me = await handle({ kind: 'me' }, 42, context(store));
    expect(me).toContain('Self-reported');
    expect(me).toContain('rank 7');
    expect(me).toContain('not counted'); // cache reads are shown but excluded

    const listed = await handle({ kind: 'leaderboard' }, 42, context(store));
    expect(listed).toContain('Self-reported');
  });

  it('keeps alerts working on /optout, and says so', async () => {
    const { store, state } = fakeStore({ profile: { name: 'amber-ledger-0042', digest: false } });
    const reply = await handle({ kind: 'optout' }, 42, context(store));

    expect(state.calls).toContain('deleteProfile');
    expect(state.calls).not.toContain('forget');
    expect(reply).toContain('alerts still work');
  });

  it('deletes everything on /forget, with no profile required', async () => {
    const { store, state } = fakeStore({ profile: null });
    const reply = await handle({ kind: 'forget' }, 42, context(store));

    expect(state.calls).toContain('forget');
    expect(reply).toContain('holds nothing');
  });

  it('defaults the digest to off and toggles it', async () => {
    const { store, state } = fakeStore({ profile: { name: 'amber-ledger-0042', digest: false } });

    expect(await handle({ kind: 'digest', on: null }, 42, context(store))).toContain('is off');
    await handle({ kind: 'digest', on: true }, 42, context(store));
    expect(state.profile?.digest).toBe(true);
  });
});

describe('rename', () => {
  // A factory, not a shared object: setName mutates the profile in place, so a
  // shared fixture would carry one test's rename into the next one's assertion.
  const profile = (): Profile => ({ name: 'amber-ledger-0042', digest: false });

  it('spends a code and sets the name', async () => {
    const { store, state } = fakeStore({ profile: profile(), renameCodes: new Set(['K7QM2XPD']) });
    const reply = await handle({ kind: 'rename', code: 'K7QM2XPD', name: 'ash' }, 42, context(store));

    expect(reply).toContain('now ash');
    expect(state.profile?.name).toBe('ash');
  });

  it('does not spend the code when the name is refused', async () => {
    // The user paid for this code. A name that was never going to be allowed
    // must not consume it.
    const { store, state } = fakeStore({ profile: profile(), renameCodes: new Set(['K7QM2XPD']) });
    const reply = await handle(
      { kind: 'rename', code: 'K7QM2XPD', name: 'anthropic' },
      42,
      context(store),
    );

    expect(reply).toContain('reserved');
    expect(state.calls).not.toContain('redeemRenameCode');
    expect(state.renameCodes.has('K7QM2XPD')).toBe(true);
  });

  it('does not spend the code when the name is taken', async () => {
    const { store, state } = fakeStore({
      profile: profile(),
      renameCodes: new Set(['K7QM2XPD']),
      taken: new Set(['ash']),
    });
    const reply = await handle({ kind: 'rename', code: 'K7QM2XPD', name: 'ash' }, 42, context(store));

    expect(reply).toContain('taken');
    expect(state.calls).not.toContain('redeemRenameCode');
  });

  it('refuses an unknown or spent code', async () => {
    const { store, state } = fakeStore({ profile: profile(), renameCodes: new Set() });
    const reply = await handle({ kind: 'rename', code: 'K7QM2XPD', name: 'ash' }, 42, context(store));

    expect(reply).toContain('not valid');
    expect(state.profile?.name).toBe('amber-ledger-0042');
  });

  it('explains the usage when arguments are missing', async () => {
    const { store } = fakeStore({ profile: profile() });
    expect(await handle({ kind: 'rename', code: '', name: '' }, 42, context(store))).toContain(
      'Usage:',
    );
  });
});

/* ---- telegram transport --------------------------------------------------- */

describe('sendMessage', () => {
  function fakeFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    return (async () => response) as unknown as typeof fetch;
  }

  it('sends plain text with no parse_mode', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    await sendMessage(config, 42, 'Weekly usage 80% — pace 28/day', capture);

    expect(body['chat_id']).toBe(42);
    expect(body['text']).toBe('Weekly usage 80% — pace 28/day');
    // A stray underscore in an alert must never 400. The relay does not parse
    // the text, and choosing a markup dialect would be parsing it.
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('reports a blocked user distinctly, because that row should be deleted', async () => {
    const outcome = await sendMessage(config, 42, 'hi', fakeFetch({ ok: false, status: 403 }));
    expect(outcome).toEqual({ ok: false, reason: 'blocked' });
  });

  it('reads retry_after out of a 429 body', async () => {
    const outcome = await sendMessage(
      config,
      42,
      'hi',
      fakeFetch({ ok: false, status: 429, json: async () => ({ parameters: { retry_after: 31 } }) }),
    );
    expect(outcome).toEqual({ ok: false, reason: 'rate-limited', retryAfter: 31 });
  });

  it('never throws on a network failure', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await sendMessage(config, 42, 'hi', failing)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('webhook secret', () => {
  it('accepts only the configured secret', () => {
    expect(verifyWebhookSecret(config, 'shhh-a-long-secret')).toBe(true);
    expect(verifyWebhookSecret(config, 'shhh-a-long-secreT')).toBe(false);
    expect(verifyWebhookSecret(config, '')).toBe(false);
    expect(verifyWebhookSecret(config, null)).toBe(false);
  });

  it('registers narrowed update types', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    await setWebhook(config, 'https://relay.usewick.lol/api/telegram', capture);

    expect(body['secret_token']).toBe(config.webhookSecret);
    // An update type you do not handle is one you cannot mishandle.
    expect(body['allowed_updates']).toEqual(['message']);
  });
});

/* ---- the endpoint --------------------------------------------------------- */

describe('handleUpdate', () => {
  const ok = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

  function update(text: string, chatId: number | null = 42) {
    return { message: { text, chat: chatId === null ? {} : { id: chatId } } };
  }

  it('refuses an update without the secret header', async () => {
    const { store, state } = fakeStore();
    const result = await handleUpdate(update('/forget'), null, {
      ...context(store),
      config,
      fetchImpl: ok,
    });

    expect(result.status).toBe(403);
    // The forged /forget must not have run.
    expect(state.calls).not.toContain('forget');
  });

  it('handles a valid update and replies', async () => {
    const { store } = fakeStore();
    const result = await handleUpdate(update('/start'), config.webhookSecret, {
      ...context(store),
      config,
      fetchImpl: ok,
    });

    expect(result.status).toBe(200);
    expect(result.sent).toContain('connect code');
  });

  it('acknowledges updates it has no opinion about', async () => {
    const { store } = fakeStore();
    for (const body of [{}, null, 'nonsense', update('hi', null)]) {
      const result = await handleUpdate(body, config.webhookSecret, {
        ...context(store),
        config,
        fetchImpl: ok,
      });
      expect(result.status).toBe(200);
    }
  });

  it('answers 200 even when handling throws, so Telegram does not retry forever', async () => {
    const exploding: RelayStore = {
      ...fakeStore().store,
      async saveCode() {
        throw new Error('database on fire');
      },
    };

    const result = await handleUpdate(update('/start'), config.webhookSecret, {
      ...context(exploding),
      config,
      fetchImpl: ok,
    });

    expect(result.status).toBe(200);
    expect(result.sent).toContain('went wrong');
  });

  it('forgets a chat that blocked the bot', async () => {
    const { store, state } = fakeStore();
    const blocked = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;

    await handleUpdate(update('/help'), config.webhookSecret, {
      ...context(store),
      config,
      fetchImpl: blocked,
    });

    expect(state.calls).toContain('forget');
  });
});
