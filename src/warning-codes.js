/**
 * Fixed warning codes for diagnostics (sync history, `doctor`).
 *
 * Parser warnings are free text: they embed full file paths (a Claude Code
 * transcript path carries the encoded project directory), exception messages
 * and remote error text. The terminal and the daemon log keep printing that
 * text unchanged. Anything meant to leave the machine -- the local sync
 * history and the `doctor` report a user pastes into a group chat -- carries
 * only a code from this closed vocabulary plus a count, never the text.
 *
 * classifyWarning() maps a warning to its code by the fixed wording *our own
 * code* writes around the embedded raw parts ("cannot read directory",
 * "额外根目录不可用", ...). A warning no rule recognizes becomes `other`, so a
 * new or reworded template can never leak text; it only loses precision.
 * When adding a warning template, add a rule here and a case to
 * test/warning-codes.test.js.
 */

// Code → short Chinese label for the `doctor` text report. The set is closed:
// sync history and `doctor --json` never emit a code outside this table.
export const WARNING_CODES = Object.freeze({
  read_failed: '读文件失败',
  dir_unreadable: '读目录失败',
  extra_root_unavailable: '额外目录不存在或结构不对',
  extra_root_read_failed: '额外目录读取失败',
  unsupported_format: '格式不认识（工具可能改了格式，或文件损坏）',
  usage_missing: '有会话但没读到用量（工具可能改了格式）',
  legacy_sessions_pending: '旧格式会话待读取（需打开对应 App）',
  merge_failed: '同一会话的分段无法合并',
  store_unavailable: '数据库无法从本进程读取',
  sqlite_unavailable: '没有可用的 SQLite（node:sqlite 和 sqlite3 命令都没有）',
  decoder_unavailable: '缺少解压组件（zstd）',
  cursor_token_encrypted: '本地登录令牌已加密',
  auth_rejected: '登录凭证被拒绝，需要在该工具里重新登录',
  network_timeout: '网络请求超时',
  network_failed: '网络请求失败',
  remote_http_error: '远端返回错误状态',
  export_unusable: '远端导出不可用，备用接口也没有读到用量',
  fallback_used: '已改用备用接口补回（模型名可能不完整）',
  backfill_paused: '历史补齐本次暂停，下次继续',
  account_changed: '登录账号已更换',
  events_regressed: '最新事件时间回退（可能换成了另一个账号）',
  upload_withheld: '部分窗口暂停上传（切点保护）',
  parser_error: '解析出错',
  invalid_result: '解析结果无效',
  other: '其他',
});

export function isWarningCode(code) {
  return typeof code === 'string' && Object.hasOwn(WARNING_CODES, code);
}

// Ordered: the first matching rule wins. More specific wordings come before
// the generic read/dir rules, because e.g. "无法读取 <db>: 不认识的表结构" is a
// format problem, not an I/O one.
const RULES = [
  // Cursor 3.27+ token encryption (issue #144). Its notice also says
  // "暂不支持读取", so it must precede the format rule.
  ['cursor_token_encrypted', /已加密保存登录凭证|issues\/144/],
  ['sqlite_unavailable', /sqlite3 CLI not found/i],
  // DSH on Node < 22.15 without the zstd CLI.
  ['decoder_unavailable', /install the zstd CLI/],
  ['backfill_paused', /历史补齐本次暂停/],
  ['auth_rejected', /session rejected|auth rejected/i],
  ['network_timeout', /\(timeout after \d+ms\)|Request timed out/],
  ['network_failed', /\(network: /],
  ['remote_http_error', /skipped \(HTTP \d{3}/],
  ['fallback_used', /已从仪表盘事件接口补回/],
  ['export_unusable', /CSV 导出不可用/],
  ['extra_root_unavailable', /额外根目录不可用|额外目录不可用|额外 Codex Home 不可用|额外目录缺少/],
  ['extra_root_read_failed', /额外根目录读取失败/],
  ['merge_failed', /无法合并会话分段/],
  ['legacy_sessions_pending', /旧格式会话未能读取/],
  ['usage_missing', /有已完成轮次但未读到用量/],
  ['store_unavailable', /:memory: 无法从另一进程读取/],
  ['unsupported_format', new RegExp([
    '不认识的表结构',
    '结构不兼容',
    'incompatible database schema',
    '不支持或不一致的',
    'is not supported',
    'uses format version',
    'invalid format version',
    'disagrees with filename version',
    'lacks isSeeded',
    'isSeeded disagrees',
    'end-seed marker',
    'missing session header record',
    'Zstandard',
    'zstd frames',
  ].join('|'))],
  // Directory reads. Node's fs messages name the syscall, so a generic
  // "cannot read <path>" whose error came from readdir is a directory too.
  ['dir_unreadable', new RegExp([
    'cannot read (?:a )?(?:data |sessions |project |session )?directory',
    '无法读取(?:数据|会话)?目录',
    '跳过无法读取的会话目录',
    ", scandir '",
    ", opendir '",
  ].join('|'))],
  ['read_failed', new RegExp([
    'cannot read',
    'cannot stat',
    '无法读取',
    '读取失败',
    'dsh: skipping',
  ].join('|'))],
];

/** Map one warning (or parser error message) to a fixed code; never returns text. */
export function classifyWarning(message) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  for (const [code, pattern] of RULES) {
    if (pattern.test(text)) return code;
  }
  return 'other';
}

/** A parser that threw: same rules, but an unrecognized failure is `parser_error`. */
export function classifyParserError(message) {
  const code = classifyWarning(message);
  return code === 'other' ? 'parser_error' : code;
}

/** { code: count } for a list of warnings; empty object for none. */
export function countWarningCodes(messages) {
  const counts = {};
  for (const message of messages || []) {
    const code = classifyWarning(message);
    counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}
