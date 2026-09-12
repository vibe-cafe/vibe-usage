# vibe-usage

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai).

## Quick Start

One command, nothing to configure:

```bash
npx @vibe-cafe/vibe-usage
```

On the first run it:
1. Opens [vibecafe.ai/usage/device](https://vibecafe.ai/usage/device) in your browser — sign in, confirm the code shown in the terminal, click 「确认链接」; the key is saved to `~/.vibe-usage/config.json`
2. Detects the AI coding tools installed on this machine
3. Uploads your usage history
4. Turns on background sync (every 30 minutes, starts at login) — no prompt, nothing else to install

Run the same command again any time to sync right now. To turn background sync off: `npx @vibe-cafe/vibe-usage daemon uninstall`. Add `--no-daemon` to the first run if you don't want the background service at all.

Prefer a menu-bar app? [Vibe Usage for Mac](https://github.com/vibe-cafe/vibe-usage-app) · [for Windows](https://github.com/vibe-cafe/vibe-usage-windows).

### CI / Headless

If you don't have a local browser (CI, remote SSH session, container), pre-issue a key at [vibecafe.ai/usage/setup](https://vibecafe.ai/usage/setup) and pass it on the command line. Non-interactive runs never install the background service:

```bash
npx @vibe-cafe/vibe-usage init --manual-key vbu_xxxxxxxxxxxx --no-daemon
```

<details>
<summary><strong>All commands</strong> — everything below still works; the older spellings print a hint pointing at the simpler form</summary>

```bash
npx @vibe-cafe/vibe-usage              # Init (first run, browser login, then background sync) or sync (subsequent runs)
npx @vibe-cafe/vibe-usage --no-daemon  # Same, but skip installing the background service on first run
npx @vibe-cafe/vibe-usage init         # Re-run setup via browser login (also how you re-bind to another account)
npx @vibe-cafe/vibe-usage init --manual-key <vbu_...>   # Skip browser, use pre-issued key (CI/headless)
npx @vibe-cafe/vibe-usage sync         # Manual sync
npx @vibe-cafe/vibe-usage sync --extra-codex-home /path/to/.codex  # Add another Codex Home for this run only
npx @vibe-cafe/vibe-usage summary       # Print last 7 days as markdown (cost / tokens / by tool / by model / by project)
npx @vibe-cafe/vibe-usage summary --days N  # Same, over the last N days (1-90)
npx @vibe-cafe/vibe-usage daemon       # Continuous sync (every 30m, foreground)
npx @vibe-cafe/vibe-usage daemon install    # Install background service (systemd/launchd/Task Scheduler)
npx @vibe-cafe/vibe-usage daemon uninstall  # Remove background service
npx @vibe-cafe/vibe-usage daemon status     # Show background service status
npx @vibe-cafe/vibe-usage daemon stop       # Stop background service
npx @vibe-cafe/vibe-usage daemon restart    # Restart background service
npx @vibe-cafe/vibe-usage reset        # Delete all data and re-upload from local logs
npx @vibe-cafe/vibe-usage reset --local  # Delete this host's data only and re-upload (`--host` remains a legacy alias)
npx @vibe-cafe/vibe-usage skill         # Install skill for AI coding assistants
npx @vibe-cafe/vibe-usage skill --remove  # Remove installed skills
npx @vibe-cafe/vibe-usage status       # Show config & detected tools
npx @vibe-cafe/vibe-usage help --all   # Full help (plain `help` shows the short version)
```

</details>

## Supported Tools

| Tool | Data Location |
|------|---------------|
| Alma | Electron app-data `alma/chat_threads.db` (macOS: `~/Library/Application Support/alma/chat_threads.db`; fixture/relocation override: `VIBE_USAGE_ALMA_DB`). Reads the `usage_records` ledger plus workspace names without selecting chat bodies, message metadata, provider credentials, or full workspace paths. Provider-prefixed model identifiers are normalized to their final model segment. Cache writes are included in input usage. The ledger contains assistant responses only, so Alma emits token buckets without session timing. |
| Claude Code + Claude Desktop Code/Cowork | Claude Code data in `~/.claude/projects/` (tokens + sessions) and `~/.claude/transcripts/` (sessions only), plus Claude Desktop Cowork's per-session `.claude/projects/` directories. Also scans `$CLAUDE_CONFIG_DIR` and data-bearing `~/.claude-*` profiles. All variants use the existing `claude-code` source; the parser selects the most complete copy of each session so shared/copied transcripts are not counted twice. Logs are streamed and cache creation tokens are included in input usage. |
| Cindy | Per-owner SQLite ledgers in the two regional Electron user-data roots: macOS `~/Library/Application Support/{CindyGlobal,Cindy}/cindy-*.db`, Windows `%APPDATA%\{CindyGlobal,Cindy}\cindy-*.db`, Linux `${XDG_CONFIG_HOME:-~/.config}/{CindyGlobal,Cindy}/cindy-*.db` (fixture/relocation override: `VIBE_USAGE_CINDY_DIRS`). Cindy-launched Claude Code already writes ordinary `~/.claude` transcripts, so it remains attributed to **Claude Code** and is not read again. Cindy's otherwise-private Codex and Pi daily/model ledger rows augment the existing **Codex** and **pi** sources. Currency rows are summed and cache creation joins input; chat messages, credentials, costs, and owner ids are never selected. The ledger adds token buckets only, without project or session timing. |
| Codex CLI | `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/` (default `~/.codex`), plus an optional temporary `--extra-codex-home`, legacy `codexExtraHome`, or explicitly added Codex/Multica roots; a versioned local index avoids re-reading unchanged rollouts and reads only safe append tails for ordinary sessions, while fork/sub-agent replay matching, duplicate suppression, and live/archive/cross-root deduplication retain their existing semantics |
| Cola | `~/.cola/sessions/<scope>/*.jsonl` (or `$COLA_DATA_DIR/sessions/`), verified with Cola 1.4.4. Reads assistant token usage and session timing through the shared Pi reader; cache writes join input, cache reads remain separate, and reasoning is split from output. Copied transcripts with new session headers are deduplicated using the original record metadata and attributed to the earliest available session copy. Project names come from `cwd`, never channel/scope names. |
| Grok | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/` (default `~/.grok`) plus explicitly added Grok Homes; token usage from `updates.jsonl` `turn_completed.usage` (per-model `modelUsage`, cache reads, reasoning); project from `summary.json` cwd; copied sessions keep the more complete local record |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` |
| CraftAgent | `~/.craft-agent/workspaces/*/sessions/*/.pi-sessions/*.jsonl`; honors `$CRAFT_AGENT_DIR` / `$CRAFTAGENT_DIR`; cache writes are included in input usage |
| Cursor | `state.vscdb` (SQLite, reads `cursorAuth/accessToken`, fetches CSV from `cursor.com`); cloud data is stamped with a fixed `cursor-cloud` hostname so multi-machine setups don't double-count |
| DimAgent | `$DIMCODE_HOME/dimcode.sqlite` (default `~/.dimcode/v2/dimcode.sqlite`); exact usage from `usage_ledger`, with forked ledger/history copies deduplicated |
| Gemini CLI | `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl` (current line-delimited format) and legacy `session-*.json`; recurses into nested subagent sessions |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite, `json_extract` query) |
| OpenClaw | `~/.openclaw/agents/`, `~/.openclaw-<profile>/agents/` (profile deployments); cache-creation/cache-write tokens are included in input usage |
| Oh My Pi | `~/.omp/agent/sessions/`, `~/.omp/profiles/*/agent/sessions/`, and `$XDG_DATA_HOME/omp/{sessions,profiles/*/sessions}`; recognizes OMP's `$PI_CODING_AGENT_DIR`, current v3 title slots and path/hashed session directories, deduplicates copied records, includes cache writes in input, and splits reasoning from OMP's inclusive output count |
| pi | `~/.pi/agent/sessions/` or `$PI_CODING_AGENT_DIR/sessions/`, plus the session directory Pi itself was pointed at via `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in `~/.pi/agent/settings.json`, plus explicitly added `pi-coding-agent` roots for stores only reachable through `pi --session <file>` (fixture/relocation override: `VIBE_USAGE_PI_SESSION_DIRS`). Cache writes are included in input usage; reasoning is read from Pi's `usage.reasoning` (legacy `usage.reasoningTokens` still accepted) and split out of the inclusive output total |
| Qwen Code | `~/.qwen/tmp/` |
| Kimi Code | Current `~/.kimi-code/sessions/wd_<slug>_<hash>/session_<id>/agents/<agent>/wire.jsonl` (`usage.record` deltas, including retry/compaction scope and cache creation; main/subagent wires form one session), data root resolved via `$KIMI_CODE_HOME` like the CLI itself, with project names from `session_index.jsonl`; legacy `~/.kimi/sessions/` is parsed alongside (`kimi migrate` never carries usage over, so both stores are always merged) |
| MiniMax Code (mcode) | `$MCODE_HOME/v2/sqlite/runtime-state.sqlite` (default `~/.minimax/v2/sqlite/runtime-state.sqlite`; fixture override: `VIBE_USAGE_MCODE_DB`). Reads only allow-listed token ledger fields and session workspace/project paths, uses basename-only projects, folds cache writes into input, keeps cache reads and reasoning separate, and never selects raw/message JSON payloads. WAL/lock reads use a disposable snapshot; malformed or incompatible databases are skipped to preserve incremental state. |
| MiMoCode | `$MIMOCODE_HOME/data/mimocode.db`, `$XDG_DATA_HOME/mimocode/mimocode.db`, or `~/.local/share/mimocode/mimocode.db` (SQLite; exact input, output, reasoning, and cache-read tokens from assistant messages; honors `MIMOCODE_DB`; cache-write tokens are included in input usage) |
| Amp | `~/.local/share/amp/threads/`; cache-creation tokens are included in input usage |
| Droid | `~/.factory/sessions/` |
| DeepSeek Harness | `$DSH_HOME/sessions/` (default `~/.dsh`, fixture/relocation override: `VIBE_USAGE_DSH_SESSIONS`). Reads V0–V3 logs, including `session.v3.jsonl.zstd` from DSH `0.1.5-alpha.2`, with multi-frame Zstandard support (Node ≥ 22.15 built-in, `zstd` CLI fallback) and plain JSONL support. Each session uses its highest `session[.vN].jsonl[.zstd]` generation once, so frozen pre-migration logs are not double-counted. Usage comes from `assistant/message`: cache writes join uncached input, cache reads remain separate, and reasoning is split out of inclusive output. Fork history uses V0/V1 `seedLength` or V2/V3's last `session/end-seed` tagged `inherited: true`, and is skipped only when the parent copy confirms it; missing parents retain the sole local history. Unknown versions warn and protect sync state. |
| Hermes (CLI / Desktop) | `<home>/state.db` + `<home>/profiles/<name>/state.db` (SQLite, multi-profile). Home: `$HERMES_HOME`, otherwise `~/.hermes` on macOS/Linux or `%LOCALAPPDATA%\hermes` on Windows (falls back to an existing `~/.hermes` only when the Windows native root is absent). Cache writes join input; reasoning is separated from inclusive output. Usage is currently a cumulative session total attributed to session start: a session spanning several days does **not** yet provide an accurate daily breakdown. |
| Kiro | Kiro CLI native event streams `~/.kiro/sessions/cli/*.jsonl` (estimated tokens from message text: input = prompt + tool results, output = reply + tool calls, reasoning = thinking, cacheRead = re-sent context; thinking-block signatures excluded). Falls back to `~/Library/Application Support/kiro-cli/data.sqlite3` / `~/.local/share/kiro-cli/data.sqlite3` + optional `~/.kiro_sessions/*.json` archives, then IDE `q-client.log` whole-credit deltas as `kiro-credits` (floored cumulative diff — the server stores token counts as bigint); legacy IDE `dev_data/devdata.sqlite` token telemetry is opt-in with `VIBE_USAGE_KIRO_LEGACY_TOKENS=1` |
| Cline | Current CLI/SDK `~/.cline/data/sessions/*/*.messages.json` plus legacy `~/.cline/{,data/}state/taskHistory.json` and editor extension stores. Honors `CLINE_DIR`, `CLINE_DATA_DIR`, and `CLINE_SESSION_DATA_DIR`; copied history is deduplicated |
| Roo Code | `<host>/User/globalStorage/rooveterinaryinc.roo-cline/{tasks/_index.json,tasks/<id>/{history_item,ui_messages}.json}` (walks all VSCode-fork hosts) |
| Trae CLI | macOS: `~/Library/Caches/trae-cli/sessions/`; Windows: `%LOCALAPPDATA%/trae-cli/cache/sessions/`; Linux: `~/.cache/trae-cli/sessions/` (CLI telemetry only; Trae IDE/Trae Work chats are not supported). Token usage is summed per unique LLM call (`model.stream.eino`, plus `model.generate` failovers); nested duplicate spans that share a session `traceID` are not max-merged. `traces.jsonl` / `events.jsonl` are streamed line-by-line so a multi-hundred-MB events file cannot hit Node's string-length limit. |
| Antigravity | Scans App 2.0 `~/.gemini/antigravity/conversations/`, `agy` CLI `~/.gemini/antigravity-cli/conversations/`, and standalone IDE `~/.gemini/antigravity-ide/conversations/`. `.db` stores, including the same paths below explicitly added alternate Homes, are parsed offline (tokens, model, project, sessions). When Gemini blobs omit `chatStartMetadata.createdAt` or `modelDisplayName`, timestamps fall back to `steps.metadata` and model names to `responseModel`. `.pb` history in the default stores requires the corresponding App/IDE language server to be running; when several servers are open, the parser tries the others for unreadable conversations. Unavailable legacy history produces a warning and preserves prior sync state. |
| WorkBuddy | Current releases: `~/.workbuddy-ai/projects/**/*.jsonl`; legacy releases: `~/.workbuddy/projects/**/*.jsonl` (fixture/relocation override: `VIBE_USAGE_WORKBUDDY_DIRS`). Reads usage-bearing completed assistant and `function_call` records, using the routed model identifier exposed as `providerData.requestModelId`. Splits cache reads and reasoning from inclusive input/output totals, deduplicates copied record IDs, and extracts local session timing without uploading message content. |
| ZCode | `~/.zcode/cli/db/db.sqlite` (SQLite; reads the `message` table for per-message tokens, model, and project `cwd`/`root`, joined to `session.directory`) |
| Qoder | International edition (qoder.com). IDE store `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` (Windows `%APPDATA%\Qoder`, Linux `~/.config/Qoder`; honors `QODER_HOME`, fixture override `VIBE_USAGE_QODER_DB`) gives real tokens from `chat_message.token_info` (prompt includes cached; split out) with `model_key` usually a routing tier, reported as `qoder-auto` / `qoder-ultimate` / … so it never collides with a priced model id; message content is never selected, and lock/schema failures fall back to a snapshot or `skipped`. CLI + desktop app transcripts `~/.qoder/projects/**/*.jsonl` (honors `QODER_CONFIG_DIR`, fixture override `VIBE_USAGE_QODER_PROJECTS`; sub-agents under `<session>/subagents/`) are credit-billed with every token field at 0, so they contribute sessions only — credits are account funding and are not collected |
| Qoder CN | China edition (qoder.com.cn, separate account). Same two shapes under `~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db` (`QODER_CN_HOME` / `VIBE_USAGE_QODER_CN_DB`) and `~/.qoder-cn/projects/` (`QODERCN_CONFIG_DIR` / `VIBE_USAGE_QODER_CN_PROJECTS`); reported as source `qoder-cn` |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Extracts session metadata where the source safely exposes user/assistant timing: active time (AI generation time, excluding queue/TTFT wait), total duration, and message counts. Alma intentionally emits buckets only; Cindy's daily-ledger augmentation adds no timing data to the native Codex/pi sessions because doing so would require reading Cindy chat records.
- Uploads buckets + sessions to your vibecafe.ai dashboard (always gzip-compressed, ~94% smaller)
- Incremental upload: every parser emits a complete local snapshot, then only buckets/sessions that are new or changed since the last successful upload are sent — a quiet machine uploads nothing. Upload state remains in `~/.vibe-usage/state.json`; failed or still-indexing parsers retain their prior state, while deleted local logs are pruned. Deleting the state file triggers a one-time full re-upload, and `reset` clears it automatically after deleting cloud data
- Incremental Codex parsing: a versioned, disposable cache under `~/.vibe-usage/cache/codex/` stores per-rollout aggregate results and parser continuation state. Unchanged rollouts require no raw-log reads; an ordinary append reads only the new tail; forks, sub-agents, replacements, truncations, and failed safety checks fall back to the full correctness path. A bounded rolling audit occasionally re-reads one historical file. Very large first-time indexes checkpoint before the Mac app timeout and resume on the next sync instead of restarting
- The Codex parser cache contains derived aggregates and replay metadata, not raw prompt or response text. It is independent of upload state and can be deleted safely (the next sync rebuilds it). `reset` intentionally keeps it so the required full re-upload does not also require a full disk rescan. Set `VIBE_USAGE_CODEX_CACHE=0` to disable the optimization for diagnosis
- SQLite-backed tools are read via Node's built-in `node:sqlite` on Node ≥ 22.5 — no `sqlite3` binary needed (works on Windows out of the box); on older Node the CLI falls back to the system `sqlite3` executable
- Continuous syncing is on by default: the first run installs a background service (see [Background sync](#background-sync)); the [Vibe Usage Mac app](https://github.com/vibe-cafe/vibe-usage-app) is the menu-bar alternative

## Cursor 网络排查

Cursor 用量需要从 `cursor.com` 下载 CSV。`Cursor usage export skipped (network: …)` 表示这次下载失败；CLI 会保留 Cursor 的历史同步状态，下次同步重新尝试。

- `ENOTFOUND` / `EAI_AGAIN`：检查 DNS 和终端网络。
- `UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` / `ECONNRESET`：检查到 Cursor 的连接及终端代理。浏览器或 Cursor 应用能联网，不代表 Node.js 使用了相同代理。
- `CERT_*` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 等：检查系统时间和代理或公司网络的 CA 证书配置；自定义 CA 可通过 `NODE_EXTRA_CA_CERTS` 指定。
- `timeout after …ms`：导出超时。`cursor.com` 的导出是按整个账号现算的，**账号用量越大越慢**，所以重度用户会每次都超时、而不是偶尔。默认等待 120 秒；仍不够就调大，例如 `VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS=300000`，然后重跑一次 `sync` 补传历史。
- `Cursor session rejected`：在 Cursor 的 Account 设置中重新登录，再同步。

需要 HTTP/HTTPS 代理时，Node.js **22.21+ 或 24.5+** 可用 `NODE_USE_ENV_PROXY=1` 启用环境变量代理（[Node.js 官方说明](https://nodejs.org/en/learn/http/enterprise-network-configuration)）。以下为 macOS/Linux 终端示例，代理地址须替换为实际地址：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1 npx @vibe-cafe/vibe-usage sync
```

这些环境变量只影响当前命令；已经运行的桌面应用和后台服务有各自的进程环境。持续失败时，请提供完整的 Cursor 报错、操作系统、`node -v` 和 CLI 版本，以便区分具体原因。

## Trust Model

vibe-usage parses **local tool logs and local application state** on a machine the user fully controls. The reported data is self-reported telemetry — local logs, parsers, and upload requests can all be modified by the user.

**Good for visibility, not sufficient for settlement.**

Suitable for:

- personal analytics and efficiency review
- team-internal AI coding adoption visibility
- token usage trends across tools, models, and projects
- rough cost estimation and anomaly detection

Not sufficient for:

- financial settlement or team expense reimbursement
- user rewards, credits, token, or airdrop allocation
- agent contribution scoring or marketplace revenue sharing
- proof-of-work / proof-of-usage or contractual billing

In short: this solves the *visibility* problem, not the *verifiability* problem. High-trust use cases need additional, independently verifiable metering layers.

## AI Skill

Install vibe-usage as a skill for your AI coding assistant, so it knows how to sync usage data on your behalf:

```bash
npx @vibe-cafe/vibe-usage skill
```

This auto-detects installed AI tools (Claude Code, Cursor, Windsurf, Codex CLI) and writes a `SKILL.md` to each tool's global skills directory. To remove:

```bash
npx @vibe-cafe/vibe-usage skill --remove
```

You can also install via the [open skills ecosystem](https://github.com/vercel-labs/skills):

```bash
npx skills add vibe-cafe/vibe-usage
```

## Development

Run the Node test suite locally with `npm test`. CI covers Node 20 and 22 on Ubuntu and macOS.

Test against a local vibe-cafe dev server without publishing:

```bash
VIBE_USAGE_DEV=1 VIBE_USAGE_API_URL=http://localhost:3000 npx @vibe-cafe/vibe-usage init
VIBE_USAGE_DEV=1 npx @vibe-cafe/vibe-usage sync
```

`VIBE_USAGE_DEV=1` uses a separate config file (`~/.vibe-usage/config.dev.json`).

## Config

Config stored at `~/.vibe-usage/config.json` (dev: `config.dev.json`).

| Key | Description |
|-----|-------------|
| `apiKey` | Your API key (starts with `vbu_`) |
| `apiUrl` | Server URL (default: `https://vibecafe.ai`) |
| `hostname` | Stable device name for usage tracking (set at init, reused across syncs) |
| `codexExtraHome` | Optional additional Codex Home scanned together with `$CODEX_HOME` / `~/.codex` |
| `extraRoots` | Tool-specific additional roots managed by the commands below; currently supports `codex`, `grok`, `antigravity`, and `pi-coding-agent` |

The `hostname` is captured once during `init` and reused for all future syncs. This prevents macOS mDNS hostname changes (e.g., `MacBook-Pro` → `MacBook-Pro-2`) from creating duplicate device entries. To change it manually:

```bash
npx @vibe-cafe/vibe-usage config set hostname my-device-name
```

Add isolated runtime data without editing JSON by hand:

```bash
# Codex accepts either one direct Codex Home or a Multica container whose
# <workspace>/<task>/codex-home directories are at most three levels below it.
npx @vibe-cafe/vibe-usage config add-root codex /path/to/multica-container

# Grok expects a Grok Home containing sessions/.
npx @vibe-cafe/vibe-usage config add-root grok /path/to/grok-home

# Antigravity expects an alternate HOME containing .gemini/antigravity*/conversations/.
npx @vibe-cafe/vibe-usage config add-root antigravity /path/to/alternate-home

# Pi accepts a directory that holds session .jsonl files directly, or a Pi
# agent directory containing sessions/. Use this when a harness starts Pi with
# `pi --session <file>`: that path is recorded nowhere Pi's own settings can
# report, so it is invisible to discovery.
npx @vibe-cafe/vibe-usage config add-root pi-coding-agent /path/to/pi-sessions

npx @vibe-cafe/vibe-usage config roots
npx @vibe-cafe/vibe-usage config remove-root grok /path/to/grok-home
```

Default roots are always scanned and existing `codexExtraHome` configurations remain valid. Additional roots are only scanned after they are explicitly added. If a configured root later becomes unavailable, that tool is skipped for the current sync so its incremental upload state is not pruned.

## Background sync

The first `npx @vibe-cafe/vibe-usage` run installs a user-level service (systemd on Linux, launchd on macOS, Task Scheduler on Windows — no admin rights needed) that syncs every 30 minutes and starts automatically on login. Nothing else to do.

<details>
<summary>Managing the service, and how it is launched</summary>

```bash
npx @vibe-cafe/vibe-usage daemon status
npx @vibe-cafe/vibe-usage daemon stop
npx @vibe-cafe/vibe-usage daemon restart
npx @vibe-cafe/vibe-usage daemon uninstall
npx @vibe-cafe/vibe-usage daemon install    # only needed after --no-daemon or uninstall
```

**How the service starts the CLI.** When you ran the CLI through `npx`, the service is registered as `npx --yes @vibe-cafe/vibe-usage@latest daemon`, so it survives `npm cache clean` and picks up the newest release at every login. When the CLI was installed globally (`npm install -g @vibe-cafe/vibe-usage`) or run from a checkout, the service pins that exact `node <bin> daemon` path instead — upgrade the package and `daemon restart` to pick up a new version. `daemon status` prints which of the two forms a machine has. A service installed by a CLI older than 0.10.25 keeps its pinned npx-cache path; to switch it to the self-updating form run `daemon uninstall` and then the bare command once.

**Foreground mode** (no service, Ctrl+C to stop):

```bash
npx @vibe-cafe/vibe-usage daemon
```

</details>

## License

MIT
