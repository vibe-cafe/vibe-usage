import { test } from 'node:test';
import assert from 'node:assert';
import { parseGenMetadataBlob, parseStepMetadata } from '../src/parsers/antigravity-db.js';

// ── Minimal protobuf encoder (mirrors the wire format the decoder reads) ──
function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
const tag = (num, wire) => varint((num << 3) | wire);
const vfield = (num, val) => Buffer.concat([tag(num, 0), varint(val)]);
const lfield = (num, buf) => Buffer.concat([tag(num, 2), varint(buf.length), buf]);
const sfield = (num, str) => lfield(num, Buffer.from(str, 'utf-8'));

// Build a GeneratorMetadata blob: chatModel(1) { usage(4), chatStartMetadata(9),
// responseModel(19), modelDisplayName(21) }. Tag numbers cross-verified against
// the language server's GetCascadeTrajectory JSON.
function buildBlob({ input, output, cache, thinking, responseId, seconds, responseModel, displayName }) {
  const usageParts = [];
  if (input != null) usageParts.push(vfield(2, input));
  if (output != null) usageParts.push(vfield(3, output));
  if (cache != null) usageParts.push(vfield(5, cache));
  if (thinking != null) usageParts.push(vfield(9, thinking));
  if (responseId != null) usageParts.push(sfield(11, responseId));

  const chatModelParts = [];
  if (usageParts.length) chatModelParts.push(lfield(4, Buffer.concat(usageParts)));
  if (seconds != null) chatModelParts.push(lfield(9, lfield(4, vfield(1, seconds))));
  if (responseModel != null) chatModelParts.push(sfield(19, responseModel));
  if (displayName != null) chatModelParts.push(sfield(21, displayName));

  return lfield(1, Buffer.concat(chatModelParts));
}

test('parseGenMetadataBlob extracts token usage and the real display name', () => {
  const blob = buildBlob({
    input: 5528, output: 192, cache: 24481, thinking: 142,
    responseId: 'RESP_1', seconds: 1783484082,
    responseModel: 'gemini-3-flash-a', displayName: 'Gemini 3.5 Flash (High)',
  });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.inputTokens, 5528);
  assert.equal(r.outputTokens, 192);
  assert.equal(r.cacheReadTokens, 24481);
  assert.equal(r.thinkingOutputTokens, 142);
  assert.equal(r.responseId, 'RESP_1');
  assert.equal(r.responseModel, 'gemini-3-flash-a');
  assert.equal(r.displayName, 'Gemini 3.5 Flash (High)');
  assert.equal(r.timestamp.getTime(), 1783484082 * 1000);
});

test('parseGenMetadataBlob keeps the CLI display name even when responseModel is generic', () => {
  // CLI writes responseModel="gemini-default" (useless) but a real displayName.
  const blob = buildBlob({
    input: 1000, output: 50, seconds: 1783484000,
    responseModel: 'gemini-default', displayName: 'Gemini 3.5 Flash (Medium)',
  });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.displayName, 'Gemini 3.5 Flash (Medium)');
  assert.equal(r.responseModel, 'gemini-default');
});

test('parseGenMetadataBlob returns null for rows without token usage', () => {
  // Error / planning placeholders carry no usage sub-message.
  const blob = buildBlob({
    seconds: 1783484000, responseModel: 'gemini-default', displayName: 'Gemini 3.5 Flash (Medium)',
  });
  assert.equal(parseGenMetadataBlob(blob), null);
});

test('parseGenMetadataBlob tolerates missing timestamp', () => {
  const blob = buildBlob({ input: 10, output: 5, displayName: 'X' });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.inputTokens, 10);
  assert.equal(r.timestamp, null);
});

// ── Step metadata (session timing) ──
// steps.metadata: createdAt Timestamp at field 1 (seconds=1.1), source enum
// at field 3 (4=user, 2=model). Behavior-verified against payload contents.
function buildStep({ source, seconds }) {
  const parts = [];
  if (seconds != null) parts.push(lfield(1, vfield(1, seconds)));
  if (source != null) parts.push(vfield(3, source));
  return Buffer.concat(parts);
}

test('parseStepMetadata maps source=4 to a user turn', () => {
  const ev = parseStepMetadata(buildStep({ source: 4, seconds: 1783508701 }));
  assert.equal(ev.role, 'user');
  assert.equal(ev.timestamp.getTime(), 1783508701 * 1000);
});

test('parseStepMetadata maps source=2 to an assistant turn', () => {
  const ev = parseStepMetadata(buildStep({ source: 2, seconds: 1783508703 }));
  assert.equal(ev.role, 'assistant');
});

test('parseStepMetadata skips non-user/model sources (system/tool)', () => {
  assert.equal(parseStepMetadata(buildStep({ source: 5, seconds: 1783508701 })), null);
  assert.equal(parseStepMetadata(buildStep({ seconds: 1783508701 })), null); // no source
});
