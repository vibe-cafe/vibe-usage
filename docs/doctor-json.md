# `doctor --json` contract (schemaVersion 1)

`npx @vibe-cafe/vibe-usage@latest doctor --json` (or `bun x …`) prints one JSON
object describing this machine's Vibe Usage setup. The Mac and Windows apps
merge it into their 「复制诊断信息」 report; humans run `doctor` without
`--json` for the same data as plain text. Approved 2026-11-09 by the
maintainer (Hogan), 一键诊断 plan, step 2.

## Guarantees

- **Read-only.** It reads `config.json`, `state.json`, `sync-history.json` and
  the tools' data-directory presence. It never runs a parser, reads a quota or
  a tool credential, writes or deletes a file, or uploads anything.
- **Network:** exactly two unauthenticated `GET`s, in parallel, each capped at
  10 s: `<apiUrl>/api/usage/settings` (no `Authorization` header; any HTTP
  answer, including 401, means reachable) and `<registry>/-/ping`. They use the
  same Node `https` module and default global agent as uploads, so they take
  the same route: through the environment proxy when `NODE_USE_ENV_PROXY=1`
  is set (Node 22.21+ / 24.5+; the Windows app sets it with `HTTPS_PROXY`
  when the system has a proxy), directly otherwise. A machine whose sync
  cannot get out fails here too, and one whose sync works through the proxy
  is reported reachable. Budget about 12 s; the apps should give the whole
  command 30 s.
- **Whitelist only.** Every value is a fixed enum, a code from the tables
  below, a number, a boolean, an ISO timestamp, a version string, or a tool's
  fixed id/display name. No path, directory or project name, hostname, account
  handle, warning text, response body, proxy address or key ever appears. A
  last-line scrub (home directory → `~`; `vbu_…`, `sk-…`, `Bearer …`, `eyJ…`,
  emails and 40+ character tokens → `***`) runs over every string before
  printing.
- **stdout carries only the JSON document; exit code 0.** A non-zero exit or
  unparsable stdout means the CLI failed.

## Compatibility rules for consumers

- Check `schemaVersion === 1`. A different number means a breaking change:
  show "CLI 版本较新/较旧，诊断格式不认识", never an empty section.
- Within schemaVersion 1 fields are only **added**. Ignore unknown keys.
- Treat an enum value or code you do not know as "unknown" and still show the
  raw code; the vocabularies below can grow within v1.
- A CLI older than `doctor` prints `Unknown command: doctor` on stderr and
  exits 1: report 「CLI 较旧，没有诊断命令」.
- Prefer this command over reading `~/.vibe-usage/sync-history.json` directly;
  the file format is internal (described at the end for reference only).

## Fields

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Contract version. |
| `generatedAt` | ISO string | When the report was built (UTC). |
| `cli.version` | string | Version of the CLI that ran `doctor`. |
| `cli.surface` | `cli` \| `daemon` \| `mac-app` \| `windows-app` | Who ran it: `VIBE_USAGE_SURFACE` when set to a known value, else `cli`. |
| `system.platform` | string | Node's `process.platform` (`darwin`, `win32`, `linux`). |
| `system.arch` | string | `os.arch()` (`arm64`, `x64`). |
| `system.release` | string | `os.release()` (kernel / build number). |
| `runtime.name` | `node` \| `bun` | Runtime that ran `doctor`. In a terminal this is the terminal's runtime, which may differ from the one the app uses — the app reports its own. |
| `runtime.version` | string | That runtime's version. |
| `sqlite` | `node:sqlite` \| `sqlite3-cli` \| `none` | The SQLite implementation the parsers would use. `none` breaks Cursor, OpenCode, Kiro and the other SQLite-backed tools; an old Node with the `sqlite3` command is fine. |
| `account.configured` | boolean | An API key is configured. |
| `account.server` | `default` \| `custom` | `apiUrl` is `https://vibecafe.ai` or something else (the URL itself is not reported). |
| `account.uploadState` | `match` \| `mismatch` \| `unrecorded` \| `none` | Whether `state.json` belongs to the current key: `mismatch` = the next sync re-uploads the full local history; `unrecorded` = written by a CLI older than 0.11.1 (adopted on the next save); `none` = no upload state yet (or not configured). |
| `account.lastSyncRejected` | boolean \| null | The most recent *finished* sync in the history failed with `unauthorized`. `null` = no finished sync recorded. |
| `account.deviceTag` | string \| null | First 4 hex chars of `sha256(hostname)`, where hostname is the upload hostname saved in `config.json` (`hostname`), or `os.hostname()` without a trailing `.local` before the first sync. Distinguishes one person's machines; reveals nothing. |
| `network.server` | probe | Reachability of the configured server. |
| `network.npmRegistry` | probe + `registry` | Reachability of the npm registry: `npm_config_registry` (npx passes the user's registry down) or `https://registry.npmjs.org/`. `registry` is `official` (registry.npmjs.org) or `custom`; the URL is not reported. |
| `daemon.platform` | `launchd` \| `systemd` \| `taskscheduler` \| null | Background-service platform; `null` = unsupported (e.g. Linux without systemd). |
| `daemon.installed` | boolean | The CLI background service is installed. |
| `daemon.mode` | `npx` \| `pinned` \| null | How it launches: `npx …@latest` (self-updating) or a pinned bin path. `null` when not installed or unreadable. |
| `settings.uploadProject` | boolean \| null | The last project-name setting the server returned for this `apiUrl` (cached in `config.json`); `null` = never read successfully. |
| `settings.extraRoots` | number | Number of additional data roots configured (`config add-root`, plus a persisted `codexExtraHome`). |
| `settings.kikiStartAt` | `set` \| `unset` | Whether a Kiki cut is configured. |
| `settings.magpieStartAt` | `set` \| `none` \| `unset` | Magpie cut: a time, the literal `none` (all history), or absent. |
| `syncHistory.available` | boolean | A readable sync-history file exists. |
| `syncHistory.entries[]` | sync | Up to 10 recorded syncs, **newest first**. |
| `tools[]` | tool | Every tool that is detected, has something in its `lastSync` (data, a warning, an error, index progress, a server drop), or has upload state; registry order. |

**probe** — `{ reachable: boolean, latencyMs: number | null, error: <probe error> | null }`.
`latencyMs` is the time to the first HTTP response.

**sync** (one `syncHistory.entries[]` item):

| Field | Type | Meaning |
|---|---|---|
| `startedAt` | ISO string | When the sync started. |
| `endedAt` | ISO string \| null | When it ended; `null` together with `result: null`. |
| `surface` | surface \| null | Who started it (`VIBE_USAGE_SURFACE`, else `cli` / `daemon`). |
| `cliVersion` | string \| null | CLI version that ran this sync. |
| `runtime` | `{ name: 'node' \| 'bun', version: string \| null }` \| null | Runtime of that sync. |
| `result` | `success` \| `failed` \| `partial` \| null | `partial` = failed after something was already uploaded. `null` = the sync never recorded an end: killed (e.g. an app's 120 s timeout), the machine slept or shut down, or it is still running. Show 「未记录结束，原因未知」 unless the app's own record explains it (e.g. its timeout at the same time). |
| `durationMs` | number \| null | Wall time, when finished. |
| `uploaded` | `{ buckets: number, sessions: number }` | What the server accepted in this sync (both passes). |
| `failure` | `{ code: <sync failure code>, status?: number }` \| null | Why it failed; `status` (HTTP status number) only for `server_error`. |

**tool** (one `tools[]` item):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Upload source id (`claude-code`, `codex`, `cursor`, …). |
| `name` | string | Display name (`Claude Code`, `Codex CLI`, …). |
| `detected` | boolean | A data directory or store exists on this machine. |
| `extraRoots` | number | Additional roots configured for this tool. |
| `uploaded` | `{ buckets: number, sessions: number }` | Items `state.json` records as uploaded, all time. |
| `lastSync` | object \| null | This tool in the newest recorded sync whose parsers finished for it. A tool that ran there with nothing to report (no data, no warning) shows zeros and no warnings, i.e. healthy — so a tool that recovered no longer shows an older error. A sync that ended before its parsers finished, or while this tool (a deferred source such as Cursor) was still running, is skipped for it. `null` = no such sync. |
| `lastSync.startedAt` | ISO string | That sync's start. |
| `lastSync.buckets` / `.sessions` | number | What the parser produced in that sync (not what was uploaded). |
| `lastSync.skipped` | boolean | The parser marked its result partial, so the sync kept its old state. Cursor is always `true` (it only re-reads recent windows); not a problem by itself. |
| `lastSync.indexing` | `{ completed: number, total: number }` \| null | Building a local index (Claude Code / Codex cold cache); continues next sync. |
| `lastSync.warnings` | `{ <warning code>: number }` | How many warnings of each code (parsers cap their own warning lists, typically at 20). |
| `lastSync.error` | warning code \| null | The parser threw instead of returning; usually `parser_error`, `sqlite_unavailable` or `auth_rejected`. |
| `lastSync.serverDropped` | number | Buckets the server soft-dropped because it does not know this source yet. |

## Vocabularies

### Warning codes

| Code | 中文 |
|---|---|
| `read_failed` | 读文件失败 |
| `dir_unreadable` | 读目录失败 |
| `extra_root_unavailable` | 额外目录不存在或结构不对 |
| `extra_root_read_failed` | 额外目录读取失败 |
| `unsupported_format` | 格式不认识（工具可能改了格式，或文件损坏） |
| `usage_missing` | 有会话但没读到用量（工具可能改了格式） |
| `legacy_sessions_pending` | 旧格式会话待读取（需打开对应 App） |
| `merge_failed` | 同一会话的分段无法合并 |
| `store_unavailable` | 数据库无法从本进程读取 |
| `sqlite_unavailable` | 没有可用的 SQLite |
| `decoder_unavailable` | 缺少解压组件（zstd） |
| `cursor_token_encrypted` | 本地登录令牌已加密（Cursor 3.27+，#144） |
| `auth_rejected` | 登录凭证被拒绝，需要在该工具里重新登录 |
| `network_timeout` | 网络请求超时 |
| `network_failed` | 网络请求失败 |
| `remote_http_error` | 远端返回错误状态 |
| `export_unusable` | 远端导出不可用，备用接口也没有读到用量 |
| `fallback_used` | 已改用备用接口补回（模型名可能不完整） |
| `backfill_paused` | 历史补齐本次暂停，下次继续 |
| `account_changed` | 登录账号已更换 |
| `events_regressed` | 最新事件时间回退（可能换成了另一个账号） |
| `upload_withheld` | 部分窗口暂停上传（Magpie / Kiki 切点保护） |
| `parser_error` | 解析出错 |
| `invalid_result` | 解析结果无效 |
| `other` | 其他（新的或改过措辞的警告） |

### Sync failure codes

| Code | 中文 |
|---|---|
| `unauthorized` | API Key 被服务器拒绝 |
| `settings_unavailable` | 读取上传设置失败（网络或服务器） |
| `network_failed` | 网络失败 |
| `server_error` | 服务器错误（带 `status`） |
| `invalid_response` | 服务器返回无法解析 |
| `unexpected_error` | 意外错误 |

### Probe errors

| Code | 中文 |
|---|---|
| `timeout` | 超时 |
| `dns_failed` | 域名解析失败 |
| `connection_refused` | 连接被拒绝 |
| `connection_reset` | 连接被重置 |
| `tls_failed` | TLS 证书校验失败 |
| `network_failed` | 网络失败 |

## Example

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-09T06:32:00.000Z",
  "cli": { "version": "0.14.11", "surface": "mac-app" },
  "system": { "platform": "darwin", "arch": "arm64", "release": "25.1.0" },
  "runtime": { "name": "bun", "version": "1.3.2" },
  "sqlite": "sqlite3-cli",
  "account": { "configured": true, "server": "default", "uploadState": "match", "lastSyncRejected": false, "deviceTag": "7c2e" },
  "network": {
    "server": { "reachable": true, "latencyMs": 320, "error": null },
    "npmRegistry": { "registry": "official", "reachable": false, "latencyMs": null, "error": "timeout" }
  },
  "daemon": { "platform": "launchd", "installed": false, "mode": null },
  "settings": { "uploadProject": true, "extraRoots": 0, "kikiStartAt": "unset", "magpieStartAt": "unset" },
  "syncHistory": {
    "available": true,
    "entries": [
      {
        "startedAt": "2026-11-09T06:00:00.000Z", "endedAt": "2026-11-09T06:00:18.000Z",
        "surface": "mac-app", "cliVersion": "0.14.11", "runtime": { "name": "bun", "version": "1.3.2" },
        "result": "success", "durationMs": 18000, "uploaded": { "buckets": 12, "sessions": 3 }, "failure": null
      },
      {
        "startedAt": "2026-11-09T05:00:00.000Z", "endedAt": null,
        "surface": "mac-app", "cliVersion": "0.14.11", "runtime": { "name": "bun", "version": "1.3.2" },
        "result": null, "durationMs": null, "uploaded": { "buckets": 0, "sessions": 0 }, "failure": null
      }
    ]
  },
  "tools": [
    {
      "id": "cursor", "name": "Cursor", "detected": true, "extraRoots": 0,
      "uploaded": { "buckets": 840, "sessions": 0 },
      "lastSync": {
        "startedAt": "2026-11-09T06:00:00.000Z", "buckets": 0, "sessions": 0, "skipped": true,
        "indexing": null, "warnings": { "cursor_token_encrypted": 1 }, "error": null, "serverDropped": 0
      }
    }
  ]
}
```

## Reference: `~/.vibe-usage/sync-history.json` (internal)

`{ "schemaVersion": 1, "entries": [ … oldest first, at most 10 … ] }`. Each
entry has the **sync** fields above plus a random local `id` (matches the start
write with the end write), `parsed` (a parser pass finished), `pending`
(deferred sources still running at the last save) and `tools: { <source>: {
buckets, sessions, skipped?, indexing?, warnings?, error?, serverDropped? } }`,
which leaves out tools that ran with nothing to report. Mode 0600; dev
mode uses `sync-history.dev.json`; `VIBE_USAGE_STATE_DIR` relocates it with
`state.json`. Deleting it is always safe.
