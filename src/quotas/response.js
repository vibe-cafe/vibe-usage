export class InvalidQuotaResponse extends Error {}

// Parse only after the response body has arrived. A connection lost while
// reading it is a transport failure, even on an HTTP 200.
export function parseQuotaPayload(parse, payload, now) {
  try { return parse(payload, now); }
  catch { throw new InvalidQuotaResponse(); }
}

export function requestFailureReason(error) {
  // Native fetch throws TimeoutError; the proxy tunnel's http.request throws
  // AbortError with the TimeoutError as its cause.
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return 'timedOut';
  if (error instanceof SyntaxError || error instanceof InvalidQuotaResponse) return 'unrecognizedResponse';
  return 'unreachable';
}
