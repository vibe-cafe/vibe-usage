import { parse as parseClaudeCode } from './claude-code.js';
import { parse as parseCline } from './cline.js';
import { parse as parseCodex } from './codex.js';
import { parse as parseCopilotCli } from './copilot-cli.js';
import { parse as parseCraftAgent } from './craft-agent.js';
import { parse as parseCursor } from './cursor.js';
import { parse as parseDimAgent } from './dimagent.js';
import { parse as parseRooCode } from './roo-code.js';
import { parse as parseGeminiCli } from './gemini-cli.js';
import { parse as parseGrok } from './grok.js';
import { parse as parseOpencode } from './opencode.js';
import { parse as parseOpenclaw } from './openclaw.js';
import { parse as parseOmp } from './omp.js';
import { parse as parseQwenCode } from './qwen-code.js';
import { parse as parseKimiCode } from './kimi-code.js';
import { parse as parseAmp } from './amp.js';
import { parse as parseAlma } from './alma.js';
import { parse as parseDroid } from './droid.js';
import { parse as parseDsh } from './dsh.js';
import { parse as parseAntigravity } from './antigravity.js';
import { parse as parseHermes } from './hermes.js';
import { parse as parseKiro } from './kiro.js';
import { parse as parseMcode } from './mcode.js';
import { parse as parseMimocode } from './mimocode.js';
import { parse as parsePiCodingAgent } from './pi-coding-agent.js';
import { parse as parseZcode } from './zcode.js';
import { parse as parseTraeCli } from './trae-cli.js';
import { parse as parseWorkbuddy } from './workbuddy.js';

export const parsers = {
  'claude-code': parseClaudeCode,
  'codex': parseCodex,
  'grok': parseGrok,
  'copilot-cli': parseCopilotCli,
  'craft-agent': parseCraftAgent,
  'cursor': parseCursor,
  'dimagent': parseDimAgent,
  'gemini-cli': parseGeminiCli,
  'opencode': parseOpencode,
  'openclaw': parseOpenclaw,
  'omp': parseOmp,
  'pi-coding-agent': parsePiCodingAgent,
  'qwen-code': parseQwenCode,
  'kimi-code': parseKimiCode,
  'amp': parseAmp,
  'alma': parseAlma,
  'droid': parseDroid,
  'dsh': parseDsh,
  'antigravity': parseAntigravity,
  'trae-cli': parseTraeCli,
  'hermes': parseHermes,
  'kiro': parseKiro,
  'mcode': parseMcode,
  'mimocode': parseMimocode,
  'cline': parseCline,
  'roo-code': parseRooCode,
  'workbuddy': parseWorkbuddy,
  'zcode': parseZcode,
};

export { roundToHalfHour, aggregateToBuckets, extractSessions } from './aggregate.js';
