// The one place that knows what an Ultrafast Codex rollout record looks like.
//
// There is no captured sample yet (2026-11-18). The tier value comes from
// reading openai/codex: `codex-rs/tui/src/service_tier_resolution.rs` matches
// the literal "ultrafast" and resolves the effective tier per model, and the
// rollout records it where the other tiers already are: `turn_context.payload
// .service_tier` and `thread_settings_applied.thread_settings.service_tier`.
// When a sanitized real session is available, replace the builders below (or
// load the capture from this directory) and keep the exports: every Ultrafast
// test reads its records from here.
export const ULTRAFAST_TIER_VALUE = 'ultrafast';

export function sessionMeta(timestamp, id, extra = {}) {
  return { timestamp, type: 'session_meta', payload: { id, cwd: '/Users/x/proj', timestamp, ...extra } };
}

/** `serviceTier` undefined writes no `service_tier` field at all (older Codex builds). */
export function turnContext(timestamp, { model, serviceTier } = {}) {
  return {
    timestamp,
    type: 'turn_context',
    payload: { ...(model ? { model } : {}), ...(serviceTier === undefined ? {} : { service_tier: serviceTier }) },
  };
}

export function threadSettingsApplied(timestamp, { model, serviceTier } = {}) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: { ...(model ? { model } : {}), ...(serviceTier === undefined ? {} : { service_tier: serviceTier }) },
    },
  };
}

export function usage(input, output = 0, { cached = 0, reasoning = 0 } = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

/** One model call. `cumulativeTotal` must grow with every call of a session. */
export function tokenCount(timestamp, last, cumulativeTotal) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: cumulativeTotal }, last_token_usage: last },
    },
  };
}

export const MODEL = 'gpt-6.1-sol';
// Half-hour windows on 2026-11-10 (UTC), after the 2026-08-31 fixed tier cutover.
export const at = (hhmm, seconds = '00') => `2026-11-10T${hhmm}:${seconds}.000Z`;
export const W1000 = at('10:00');
export const W1030 = at('10:30');
export const W1100 = at('11:00');

/**
 * One session: 50 standard tokens at 10:05, a late 5 Ultrafast at 10:29, then
 * in the 10:30 window 60 standard + 40 Ultrafast, switching tier per turn.
 */
export function mixedSession(id = 'mixed') {
  return [
    sessionMeta(at('10:05'), id),
    turnContext(at('10:05'), { model: MODEL, serviceTier: null }),
    tokenCount(at('10:05', '10'), usage(50), 50),
    turnContext(at('10:29'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }),
    tokenCount(at('10:29', '10'), usage(5), 55),
    turnContext(at('10:31'), { model: MODEL, serviceTier: null }),
    tokenCount(at('10:31', '10'), usage(60), 115),
    turnContext(at('10:40'), { model: MODEL, serviceTier: ULTRAFAST_TIER_VALUE }),
    tokenCount(at('10:40', '10'), usage(40), 155),
  ];
}
