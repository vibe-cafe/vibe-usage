// Codex writes usage twice for the same request: once as the UI-facing
// `event_msg` / `token_count`, and once as a durable `token_usage_record`.
// The UI event can be missing entirely — an interrupted or crashed call never
// reaches the point where it is emitted — while the durable record still lands,
// so counting only the UI form under-reports real usage.
//
// Rewrite the durable form into the shape the parser already understands, and
// keep a `usage_record` marker so the UI event that mirrors the same request is
// not counted a second time when its cumulative total lags.
export function normalizeUsageRecord(obj) {
  if (obj?.type !== 'token_usage_record') return obj;
  const p = obj.payload;
  const usage = p?.usage;
  const total = p?.thread_token_usage;
  if (!usage || !total || !Number.isFinite(total.total_tokens) || total.total_tokens <= 0) return obj;
  for (const value of [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens ?? 0, usage.reasoning_output_tokens ?? 0]) {
    if (!Number.isFinite(value) || value < 0) return obj;
  }
  return { ...obj, type: 'event_msg', payload: {
    type: 'token_count', usage_record: true,
    info: { last_token_usage: pickUsage(usage), total_token_usage: pickUsage(total) },
  }};
}

function pickUsage(value) {
  const keys = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_read_input_tokens',
    'cache_write_input_tokens', 'reasoning_output_tokens', 'total_tokens'];
  return Object.fromEntries(keys.filter(key => Number.isFinite(value[key])).map(key => [key, value[key]]));
}
