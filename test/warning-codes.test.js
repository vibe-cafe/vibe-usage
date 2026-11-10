import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WARNING_CODES,
  classifyParserError,
  classifyWarning,
  countWarningCodes,
  isWarningCode,
} from '../src/warning-codes.js';
import { ENCRYPTED_TOKEN_NOTICE } from '../src/parsers/cursor.js';
import { sqliteUnavailableError } from '../src/parsers/sqlite.js';

// Synthetic paths only: a Chinese user name with a space, an encoded Claude
// project directory, and a Windows profile -- the shapes the plan says must
// never reach a report. The classifier only ever returns a code.
const HOME = '/Users/张 三';
const PROJECT_DIR = `${HOME}/.claude/projects/-Users-张-三-Coding-秘密项目`;
const FILE = `${PROJECT_DIR}/0b7c.jsonl`;
const WIN = 'C:\\Users\\张三\\AppData\\Roaming';

// Every warning template the parsers and roots modules write (2026-11-09),
// with the code it must map to.
const CASES = [
  // Claude Code / Claude Desktop
  [`Claude Code: cannot read directory ${PROJECT_DIR}: EACCES: permission denied, scandir '${PROJECT_DIR}'`, 'dir_unreadable'],
  [`Claude Code: cannot read directory ${HOME}/.claude: not a directory`, 'dir_unreadable'],
  [`Claude Code: cannot stat ${FILE}: EACCES: permission denied, stat '${FILE}'`, 'read_failed'],
  [`Claude Code: cannot read ${FILE}: EACCES: permission denied, open '${FILE}'`, 'read_failed'],
  [`Claude Desktop: cannot read directory ${HOME}/Library/Application Support/Claude: EPERM`, 'dir_unreadable'],
  [`Claude Code: 额外目录不可用 ${HOME}/备份/.claude: 目录不存在`, 'extra_root_unavailable'],
  // SQLite ledgers
  ['alma: cannot read usage database (database is locked)', 'read_failed'],
  ['alma: cannot read usage database (incompatible database schema)', 'unsupported_format'],
  ['cindy: cannot read usage database (database unavailable)', 'read_failed'],
  ['cindy: cannot read usage database (read failed)', 'read_failed'],
  [`MiniMax Code: 跳过结构不兼容的数据库 ${HOME}/.minimax/runtime.db`, 'unsupported_format'],
  [`MiniMax Code: 无法读取 ${HOME}/.minimax-work/runtime.db，已跳过: SQLITE_BUSY`, 'read_failed'],
  [`Kilo: 无法读取 ${HOME}/.local/share/kilo/kilo.db: file is not a database`, 'read_failed'],
  [`Kilo: 无法读取数据库 ${HOME}/.local/share/kilo/kilo.db: EACCES`, 'read_failed'],
  ['Kilo: KILO_DB=:memory: 无法从另一进程读取，已跳过', 'store_unavailable'],
  [`OpenCode: 无法读取 ${HOME}/.local/share/opencode/opencode.db: 不认识的表结构（没有 message / session_message 表）: ${HOME}/x.db`, 'unsupported_format'],
  [`OpenCode: 额外目录缺少 opencode.db 或 storage/message/: ${HOME}/备份`, 'extra_root_unavailable'],
  [`OpenCode: 无法读取数据目录 ${HOME}/备份: EACCES`, 'dir_unreadable'],
  [`CodeArts Agent: 无法读取 ${HOME}/.codeartsdoer/codearts-data/opencode.db: SQLITE_CORRUPT`, 'read_failed'],
  [`CodeArts Agent: 无法读取数据目录 ${HOME}/.codeartsdoer: EACCES`, 'dir_unreadable'],
  // Pi family, Qoder, Kimi, WorkBuddy, CodeBuddy
  [`pi-coding-agent: cannot read directory ${HOME}/.pi/agent/sessions: EACCES`, 'dir_unreadable'],
  [`cola: cannot read ${HOME}/.cola/sessions/a.jsonl: EIO: i/o error, read`, 'read_failed'],
  ['pi-coding-agent: 额外根目录不可用，已跳过本次 Pi 同步: /Volumes/备份/.pi', 'extra_root_unavailable'],
  [`qoder: cannot read ${HOME}/.qoder/projects: ENOENT: no such file or directory, scandir '${HOME}/.qoder/projects'`, 'dir_unreadable'],
  [`qoder-cn: cannot read ${HOME}/.qoder-cn/projects/p/s.jsonl: EACCES: permission denied, open 'x'`, 'read_failed'],
  [`qoder: cannot read ${WIN}\\Qoder\\local.db: database is locked`, 'read_failed'],
  [`kimi-code: 无法读取 ${HOME}/.kimi-code/sessions/a/wire.jsonl: EACCES`, 'read_failed'],
  ['workbuddy: cannot read a data directory', 'dir_unreadable'],
  ['workbuddy: cannot read a session file', 'read_failed'],
  ['workbuddy: cannot stat a session file', 'read_failed'],
  [`codebuddy: 无法读取目录 ${HOME}/.codebuddy/projects: EACCES`, 'dir_unreadable'],
  [`codebuddy: 无法读取会话 ${HOME}/.codebuddy/projects/p/s.jsonl: EACCES`, 'read_failed'],
  // Cline
  [`cline: 无法读取数据目录 ${HOME}/.cline/data: EACCES`, 'dir_unreadable'],
  [`cline: 无法读取会话目录 ${HOME}/.cline/data/sessions: EACCES`, 'dir_unreadable'],
  [`cline: 不支持或不一致的会话清单 ${HOME}/.cline/data/sessions/s1: version 2`, 'unsupported_format'],
  [`cline: 跳过无法读取的会话目录 ${HOME}/.cline/data/sessions/s2: EACCES`, 'dir_unreadable'],
  [`cline: 不支持或不一致的会话文件 ${HOME}/.cline/data/sessions/s1/a.messages.json: session id mismatch`, 'unsupported_format'],
  [`cline: 跳过无法读取的会话文件 ${HOME}/.cline/data/sessions/s1/a.messages.json: Unexpected end of JSON input`, 'read_failed'],
  // Extra roots (Codex, Grok, Hermes, Antigravity)
  [`codex: 额外 Codex Home 不可用，已跳过本次 Codex 同步: ${HOME}/old/.codex`, 'extra_root_unavailable'],
  [`codex: 额外根目录不可用，已跳过本次 Codex 同步: ${HOME}/old/.codex`, 'extra_root_unavailable'],
  [`codex: 额外根目录读取失败，已保留上次同步数据: ${HOME}/.codex`, 'extra_root_read_failed'],
  ['codex: 会话文件读取失败，已保留上次同步数据', 'read_failed'],
  ['codex: 同一会话的部分文件读取失败，已保留上次同步数据', 'read_failed'],
  ['codex: 无法合并会话分段，已保留上次同步数据: conflicting copy order', 'merge_failed'],
  ['grok: 额外根目录不可用，已跳过本次 Grok 同步: /Volumes/备份/.grok', 'extra_root_unavailable'],
  ['grok: 额外根目录读取失败，已保留上次同步数据: /Volumes/备份/.grok/sessions', 'extra_root_read_failed'],
  ['grok: 2 个会话有已完成轮次但未读到用量（例如 s-秘密，3 轮），可能是 Grok 又更改了用量落盘格式，请反馈；本次未上传这些会话的用量。', 'usage_missing'],
  ['hermes: 额外根目录读取失败，已保留上次同步数据: /Volumes/备份/.hermes', 'extra_root_read_failed'],
  ['hermes: 额外根目录不可用，已跳过本次 Hermes 同步: /Volumes/备份/.hermes', 'extra_root_unavailable'],
  ['antigravity: 额外根目录读取失败，已保留上次同步数据: /Volumes/备份/antigravity', 'extra_root_read_failed'],
  ['antigravity: 额外根目录不可用，已跳过本次 Antigravity 同步: /Volumes/备份/antigravity', 'extra_root_unavailable'],
  ['antigravity: 3 个旧格式会话未能读取，请打开对应的 Antigravity IDE/App 后重新同步；已保留上次同步状态。', 'legacy_sessions_pending'],
  // DeepSeek Harness
  [`dsh: cannot read sessions directory ${HOME}/.dsh/sessions (EACCES)`, 'dir_unreadable'],
  ['dsh: cannot read project directory -Users-张-三-Coding-秘密项目 (EACCES)', 'dir_unreadable'],
  ['dsh: cannot read session directory p/s1 (format version 99 is not supported; update Vibe Usage)', 'unsupported_format'],
  ['dsh: cannot read session directory p/s1 (EACCES)', 'dir_unreadable'],
  ['dsh: skipping p/s1/session.v4.jsonl.zstd (decompress with node:zlib zstd (Node >= 22.15) or install the zstd CLI)', 'decoder_unavailable'],
  ['dsh: skipping p/s1/session.jsonl (session log changed while reading)', 'read_failed'],
  ['dsh: skipping p/s1/session.jsonl (missing session header record)', 'unsupported_format'],
  ['dsh: skipping p/s1/session.v2.jsonl (session s1 uses format version 9 (parser supports 0–4))', 'unsupported_format'],
  ['dsh: skipping p/s1/session.v1.jsonl.zstd (invalid Zstandard frame magic at byte 0)', 'unsupported_format'],
  // Cursor
  [`cursor: ${ENCRYPTED_TOKEN_NOTICE}`, 'cursor_token_encrypted'],
  ['cursor: Cursor usage export skipped (timeout after 120000ms). Cursor 用量导出超时，请稍后重试；可通过 VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS 增大导出等待时间。', 'network_timeout'],
  ['cursor: Cursor usage export skipped (network: ETIMEDOUT, ENETUNREACH). 请检查终端网络和代理配置；浏览器能访问 Cursor 不代表 Node.js 使用了相同代理。', 'network_failed'],
  ['cursor: Cursor usage export skipped (HTTP 503 Service Unavailable)', 'remote_http_error'],
  ['cursor: CSV 最新 token 事件停在 2026-11-01T00:00:00.000Z，已从仪表盘事件接口补回 3 个更新的 token 事件；这些事件的模型名可能不完整（不影响 token 总量）。', 'fallback_used'],
  ['cursor: CSV 导出不可用（unknown header: Date,Kind），已从仪表盘事件接口补回最近 7 天的 4 个 token 事件；这些事件的模型名可能显示为 default（不影响 token 总量）。', 'fallback_used'],
  ['cursor: CSV 导出不可用（no token columns），事件接口在最近 7 天也没有读到 token 用量。如果刚切换到 X 订阅，Cursor 的用量可能并入 grok.com/dashboard；本次已跳过以保留历史。', 'export_unusable'],
  ['cursor: CSV 导出不可用（no token columns）；事件接口也失败：Cursor usage export skipped (network: ECONNRESET). 请检查终端网络和代理配置。', 'network_failed'],
  ['cursor: 历史补齐本次暂停，下次同步继续（Cursor usage export skipped (HTTP 429 Too Many Requests)）', 'backfill_paused'],
];

test('every parser warning template maps to its fixed code', () => {
  for (const [message, expected] of CASES) {
    assert.equal(classifyWarning(message), expected, message);
  }
});

test('the vocabulary is closed and every code has a label', () => {
  for (const [, code] of CASES) assert.ok(isWarningCode(code), code);
  for (const [code, label] of Object.entries(WARNING_CODES)) {
    assert.match(code, /^[a-z][a-z_]*$/);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0);
  }
  assert.equal(isWarningCode('toString'), false);
  assert.equal(isWarningCode('__proto__'), false);
});

test('an unrecognized warning is `other`, and an unrecognized parser error is `parser_error`', () => {
  assert.equal(classifyWarning('something new: vbu_secret at /Users/张 三/x'), 'other');
  assert.equal(classifyWarning(undefined), 'other');
  assert.equal(classifyParserError('TypeError: x is not iterable'), 'parser_error');
});

test('parser errors that bubble up are classified like warnings', () => {
  assert.equal(classifyParserError(sqliteUnavailableError('Cursor').message), 'sqlite_unavailable');
  assert.equal(
    classifyParserError('Cursor session rejected (401 Unauthorized; 401 Unauthorized). Open Cursor and sign in again (Cursor Settings → Account), then re-run sync.'),
    'auth_rejected',
  );
});

test('countWarningCodes keeps only codes and counts, never the text', () => {
  const counts = countWarningCodes([
    `Claude Code: cannot read ${FILE}: EACCES`,
    `Claude Code: cannot read ${FILE}.2: EACCES`,
    `Claude Code: cannot read directory ${PROJECT_DIR}: EACCES`,
  ]);
  assert.deepEqual(counts, { read_failed: 2, dir_unreadable: 1 });
  assert.doesNotMatch(JSON.stringify(counts), /张|秘密|Users/);
  assert.deepEqual(countWarningCodes([]), {});
  assert.deepEqual(countWarningCodes(undefined), {});
});
