export class InvalidQuotaResponse extends Error {}

// Parse only after the response body has arrived. A connection lost while
// reading it is a transport failure, even on an HTTP 200.
export function parseQuotaPayload(parse, payload, now) {
  try { return parse(payload, now); }
  catch { throw new InvalidQuotaResponse(); }
}

export function requestFailureReason(error) {
  if (error?.name === 'TimeoutError') return 'timedOut';
  if (error instanceof SyntaxError || error instanceof InvalidQuotaResponse) return 'unrecognizedResponse';
  return 'unreachable';
}
