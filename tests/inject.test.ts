/**
 * The MAIN-world fetch wrapper, in a fake page.
 *
 * Everything this file guards is a rule about being a guest: chain the existing
 * `fetch` rather than recursing through `window.fetch`, read a clone rather
 * than the page's own body, and never let anything Wick does become the reason
 * a message fails to render.
 *
 * The one behavioural rule on top of those: a *message* is a send the server
 * accepted. A request that was refused for hitting a limit, or that died on the
 * network, is not one — and counting it inflates the only figure on the panel
 * that claims to count what the user actually did.
 *
 * The module installs itself on import, so the fake window has to exist first;
 * hence the dynamic import in `beforeAll` rather than a static one.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INJECT_SOURCE, type InjectMessage } from '~/core/messages';
import { sseBody, streamMessageLimit } from './fixtures/claude';

const COMPLETION_URL =
  'https://claude.ai/api/organizations/org-1/chat_conversations/c-1/completion';

let posted: InjectMessage[] = [];
let calls: string[] = [];
let handler: (url: string) => Response | Promise<Response>;

/** The `fetch` the page had before Wick touched it. */
function originalFetch(input: RequestInfo | URL): Promise<Response> {
  calls.push(String(input));
  return Promise.resolve(handler(String(input)));
}

const fakeWindow = {
  fetch: originalFetch as unknown as typeof fetch,
  postMessage: (message: unknown) => void posted.push(message as InjectMessage),
  location: { origin: 'https://claude.ai' },
};

beforeAll(async () => {
  vi.stubGlobal('window', fakeWindow);
  await import('~/content/inject');
});

beforeEach(() => {
  posted = [];
  calls = [];
  handler = () => new Response('', { status: 200 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('window', fakeWindow);
});

function streamResponse(events: unknown[]): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Let the detached tee finish; the page never waits on it, so the test must. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function kinds(): string[] {
  return posted.map((message) => message.kind);
}

describe('installation', () => {
  it('replaces fetch and marks the page so a second injection does not stack', () => {
    expect(window.fetch).not.toBe(originalFetch);
    expect((window as unknown as Record<string, unknown>).__wickFetchWrapped).toBe(true);
  });

  it('chains the captured original rather than recursing through window.fetch', async () => {
    // The hazard: calling `window.fetch` from inside the replacement recurses
    // for ever the moment another extension patches the same function.
    await window.fetch('https://claude.ai/api/anything');

    expect(calls).toEqual(['https://claude.ai/api/anything']);
  });

  it('leaves the page its own untouched body', async () => {
    handler = () => streamResponse([streamMessageLimit]);

    const response = await window.fetch(COMPLETION_URL);
    const text = await response.text();
    await settle();

    // Wick reads a clone. If it had consumed this one, the page would render
    // nothing and Wick would be the reason.
    expect(text).toContain('message_limit');
  });
});

describe('an accepted completion', () => {
  it('counts one message, with an id', async () => {
    handler = () => streamResponse([streamMessageLimit]);

    await window.fetch(COMPLETION_URL);
    await settle();

    const sent = posted.filter((message) => message.kind === 'message-sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: INJECT_SOURCE });
    expect((sent[0] as { id: string }).id).toMatch(/\S/);
  });

  it('forwards the limit event at the tail of the stream', async () => {
    handler = () => streamResponse([{ type: 'content_block_delta' }, streamMessageLimit]);

    await window.fetch(COMPLETION_URL);
    await settle();

    // Hundreds of deltas, one interesting record: only the record crosses the
    // world boundary.
    expect(kinds().filter((kind) => kind === 'limits')).toHaveLength(1);
  });

  it('gives two sends two different ids', async () => {
    handler = () => streamResponse([streamMessageLimit]);

    await window.fetch(COMPLETION_URL);
    await window.fetch(COMPLETION_URL);
    await settle();

    const ids = posted
      .filter((message) => message.kind === 'message-sent')
      .map((message) => (message as { id: string }).id);

    expect(new Set(ids).size).toBe(2);
  });
});

describe('a send that was not accepted', () => {
  it('does not count a refusal as a message', async () => {
    handler = () =>
      new Response(JSON.stringify({ type: 'error' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });

    await window.fetch(COMPLETION_URL);
    await settle();

    expect(kinds()).toEqual(['refused']);
  });

  it('does not count a request that failed on the network', async () => {
    // A real `fetch` reports a network failure as a rejected promise, never as
    // a synchronous throw.
    handler = () => Promise.reject(new Error('Failed to fetch'));

    await expect(window.fetch(COMPLETION_URL)).rejects.toThrow('Failed to fetch');
    await settle();

    // The page sees its own rejection, and nothing was counted.
    expect(posted).toEqual([]);
  });
});

describe('requests that are not completions', () => {
  it('is invisible to them', async () => {
    handler = () => streamResponse([streamMessageLimit]);

    await window.fetch('https://claude.ai/api/organizations/org-1/usage');
    await settle();

    expect(posted).toEqual([]);
  });
});
