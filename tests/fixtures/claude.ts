/**
 * Wire payloads, as the protocol notes describes them.
 *
 * **These are written from the specification, not captured from live traffic.**
 * Nothing here is evidence that claude.ai sends these shapes; it is evidence
 * that Wick reads the shapes it believes claude.ai sends. Until step 3 of
 * protocol verification is done, that distinction is the whole
 * status of the project's protocol work, and a fixture file that quietly
 * blurred it would be worse than none.
 *
 * When real responses are captured, replace these with redacted copies and say
 * so here. The tests should not need to change: that is the point of keeping
 * the payloads in one file.
 */

/** A paid plan: a session window, an account weekly, and a scoped Opus weekly. */
export const usagePaid = {
  limits: [
    {
      kind: '5h',
      percent: 41,
      severity: 'ok',
      resets_at: '2026-08-25T18:00:00Z',
      is_active: true,
    },
    {
      kind: '7d',
      percent: 68,
      severity: 'approaching',
      resets_at: '2026-08-29T00:00:00Z',
      is_active: true,
    },
    {
      kind: '7d_oi',
      percent: 12,
      severity: 'ok',
      resets_at: '2026-08-29T00:00:00Z',
      is_active: true,
    },
  ],
};

/**
 * A plan that meters two models separately.
 *
 * The hazard this fixture exists for: both entries say `weekly_scoped`, and the
 * model is in a field of its own. Keyed on `kind` alone they are one window
 * with two sets of numbers.
 */
export const usageScoped = {
  limits: [
    {
      kind: 'weekly_scoped',
      model: 'claude-sonnet-4-5',
      percent: 55,
      severity: 'ok',
      resets_at: '2026-08-29T00:00:00Z',
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      model: 'claude-opus-4-6',
      percent: 91,
      severity: 'approaching',
      resets_at: '2026-08-29T00:00:00Z',
      is_active: true,
    },
  ],
};

/**
 * A free plan. The endpoint answers, and lists nothing.
 *
 * Not an error, not a signed-out session, and emphatically not "zero used" —
 * an account that meters nothing through this endpoint still has limits, and
 * the only place they surface is the completion stream.
 */
export const usageFree = { limits: [] };

/** The tail event of a completion stream. Utilization is a 0–1 float here. */
export const streamMessageLimit = {
  type: 'message_limit',
  message_limit: {
    type: 'within_limit',
    windows: {
      '5h': { status: 'ok', utilization: 0.44, resets_at: 1_787_853_600 },
      '7d': { status: 'approaching', utilization: 0.71, resets_at: 1_788_134_400 },
    },
  },
};

/** The same event, reporting the session window bound. */
export const streamMessageLimitExceeded = {
  type: 'message_limit',
  message_limit: {
    type: 'exceeded_limit',
    windows: {
      '5h': { status: 'exceeded', utilization: 0.98, resets_at: 1_787_853_600 },
    },
  },
};

/**
 * A refused send.
 *
 * Double-encoded: the useful payload is a JSON string inside `error.message`,
 * one `JSON.parse` past where it looks. Written as a string here because that
 * is how it arrives — the encoding is the hazard being tested.
 */
export const refusalBody = JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: JSON.stringify({
      resets_at: 1_787_853_600,
      windows: {
        '5h': { status: 'exceeded', utilization: 1, resets_at: 1_787_853_600 },
      },
    }),
  },
});

/** One `text/event-stream` body, padded the way the protocol notes record. */
export function sseBody(events: unknown[]): string {
  return events
    .map((event) => `event: completion\ndata: ${JSON.stringify(event)}     \n\n`)
    .join('');
}
