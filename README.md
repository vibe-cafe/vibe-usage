# vibe-usage

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai).

## Quick Start

```bash
npx @vibe-cafe/vibe-usage
```

That's it. The CLI opens [vibecafe.ai/usage/device](https://vibecafe.ai/usage/device) in your browser; sign in, confirm the verification code shown in your terminal, click 「确认链接」, and the CLI receives an API key automatically.

After approval, it will:
1. Save your API key to `~/.vibe-usage/config.json`
2. Detect installed AI coding tools
3. Run an initial sync of your usage data
4. Prompt you to enable the background daemon for continuous syncing (recommended)

### CI / Headless

If you don't have a local browser (CI, remote SSH session, container), pre-issue a key at [vibecafe.ai/usage/setup](https://vibecafe.ai/usage/setup) and pass it on the command line:

```bash
npx @vibe-cafe/vibe-usage init --manual-key vbu_xxxxxxxxxxxx
```

## Commands

```bash
npx @vibe-cafe/vibe-usage              # Init (first run, browser login) or sync (subsequent runs)
npx @vibe-cafe/vibe-usage init         # Re-run setup via browser login
npx @vibe-cafe/vibe-usage init --manual-key <vbu_...>   # Skip browser, use pre-issued key (CI/headless)
npx @vibe-cafe/vibe-usage sync         # Manual sync
npx @vibe-cafe/vibe-usage sync --extra-codex-home /path/to/.codex  # Add another Codex Home for this run only
npx @vibe-cafe/vibe-usage summary       # Print last 7 days as markdown (cost / tokens / by model / by project)
npx @vibe-cafe/vibe-usage summary --days N  # Same, over the last N days (1-90)
npx @vibe-cafe/vibe-usage daemon       # Continuous sync (every 30m, foreground)
npx @vibe-cafe/vibe-usage daemon install    # Install background service (systemd/launchd)
npx @vibe-cafe/vibe-usage daemon uninstall  # Remove background service
npx @vibe-cafe/vibe-usage daemon status     # Show background service status
npx @vibe-cafe/vibe-usage daemon stop       # Stop background service
npx @vibe-cafe/vibe-usage daemon restart    # Restart background service
npx @vibe-cafe/vibe-usage reset        # Delete all data and re-upload from local logs
npx @vibe-cafe/vibe-usage reset --local  # Delete this host's data only and re-upload (`--host` remains a legacy alias)
npx @vibe-cafe/vibe-usage skill         # Install skill for AI coding assistants
npx @vibe-cafe/vibe-usage skill --remove  # Remove installed skills
npx @vibe-cafe/vibe-usage status       # Show config & detected tools
```

## Supported Tools

| Tool | Data Location |
|------|---------------|
| Alma | Electron app-data `alma/chat_threads.db` (macOS: `~/Library/Application Support/alma/chat_threads.db`; fixture/relocation override: `VIBE_USAGE_ALMA_DB`). Reads the `usage_records` ledger plus workspace names without selecting chat bodies, message metadata, provider credentials, or full workspace paths. Provider-prefixed model identifiers are normalized to their final model segment. Cache writes are included in input usage. The ledger contains assistant responses only, so Alma emits token buckets without session timing. |
| Claude Code + Claude Desktop Code/Cowork | Claude Code data in `~/.claude/projects/` (tokens + sessions) and `~/.claude/transcripts/` (sessions only), plus Claude Desktop Cowork's per-session `.claude/projects/` directories. Also scans `$CLAUDE_CONFIG_DIR` and data-bearing `~/.claude-*` profiles. All variants use the existing `claude-code` source; the parser selects the most complete copy of each session so shared/copied transcripts are not counted twice. Logs are streamed and cache creation tokens are included in input usage. |
| Cindy | Per-owner SQLite ledgers in the two regional Electron user-data roots: macOS `~/Library/Application Support/{CindyGlobal,Cindy}/cindy-*.db`, Windows `%APPDATA%\{CindyGlobal,Cindy}\cindy-*.db`, Linux `${XDG_CONFIG_HOME:-~/.config}/{CindyGlobal,Cindy}/cindy-*.db` (fixture/relocation override: `VIBE_USAGE_CINDY_DIRS`). Cindy-launched Claude Code already writes ordinary `~/.claude` transcripts, so it remains attributed to **Claude Code** and is not read again. Cindy's otherwise-private Codex and Pi daily/model ledger rows augment the existing **Codex** and **pi** sources. Currency rows are summed and cache creation joins input; chat messages, credentials, costs, and owner ids are never selected. The ledger adds token buckets only, without project or session timing. |
| Codex CLI | `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/` (default `~/.codex`), plus an optional temporary `--extra-codex-home` or manually persisted `codexExtraHome`; a versioned local index avoids re-reading unchanged rollouts and reads only safe append tails for ordinary sessions, while fork/sub-agent replay matching, duplicate suppression, and live/archive/cross-root deduplication retain their existing semantics |
| Grok | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/` (default `~/.grok`); token usage from `updates.jsonl` `turn_completed.usage` (per-model `modelUsage`, cache reads, reasoning); project from `summary.json` cwd; honors `GROK_HOME` |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` |
| CraftAgent | `~/.craft-agent/workspaces/*/sessions/*/.pi-sessions/*.jsonl`; honors `$CRAFT_AGENT_DIR` / `$CRAFTAGENT_DIR`; cache writes are included in input usage |
| Cursor | `state.vscdb` (SQLite, reads `cursorAuth/accessToken`, fetches CSV from `cursor.com`); cloud data is stamped with a fixed `cursor-cloud` hostname so multi-machine setups don't double-count |
| DimAgent | `$DIMCODE_HOME/dimcode.sqlite` (default `~/.dimcode/v2/dimcode.sqlite`); exact usage from `usage_ledger`, with forked ledger/history copies deduplicated |
| Gemini CLI | `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl` (current line-delimited format) and legacy `session-*.json`; recurses into nested subagent sessions |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite, `json_extract` query) |
| OpenClaw | `~/.openclaw/agents/`, `~/.openclaw-<profile>/agents/` (profile deployments); cache-creation/cache-write tokens are included in input usage |
| Oh My Pi | `~/.omp/agent/sessions/`, `~/.omp/profiles/*/agent/sessions/`, and `$XDG_DATA_HOME/omp/{sessions,profiles/*/sessions}`; recognizes OMP's `$PI_CODING_AGENT_DIR`, current v3 title slots and path/hashed session directories, deduplicates copied records, includes cache writes in input, and splits reasoning from OMP's inclusive output count |
| pi | `~/.pi/agent/sessions/` or `$PI_CODING_AGENT_DIR/sessions/`, plus the session directory Pi itself was pointed at via `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in `~/.pi/agent/settings.json` (fixture/relocation override: `VIBE_USAGE_PI_SESSION_DIRS`). Cache writes are included in input usage; reasoning is read from Pi's `usage.reasoning` (legacy `usage.reasoningTokens` still accepted) and split out of the inclusive output total |
| Qwen Code | `~/.qwen/tmp/` |
| Kimi Code | Current `~/.kimi-code/sessions/wd_<slug>_<hash>/session_<id>/agents/<agent>/wire.jsonl` (`usage.record` deltas, including retry/compaction scope and cache creation; main/subagent wires form one session), data root resolved via `$KIMI_CODE_HOME` like the CLI itself, with project names from `session_index.jsonl`; legacy `~/.kimi/sessions/` is parsed alongside (`kimi migrate` never carries usage over, so both stores are always merged) |
| MiMoCode | `$MIMOCODE_HOME/data/mimocode.db`, `$XDG_DATA_HOME/mimocode/mimocode.db`, or `~/.local/share/mimocode/mimocode.db` (SQLite; exact input, output, reasoning, and cache-read tokens from assistant messages; honors `MIMOCODE_DB`; cache-write tokens are included in input usage) |
| Amp | `~/.local/share/amp/threads/`; cache-creation tokens are included in input usage |
| Droid | `~/.factory/sessions/` |
| DeepSeek Harness | `$DSH_HOME/sessions/` (default `~/.dsh`, fixture/relocation override: `VIBE_USAGE_DSH_SESSIONS`). Reads multi-frame Zstandard `session.jsonl.zstd` logs (built-in `node:zlib` zstd on Node ≥ 22.15, `zstd` CLI fallback) and plain `session.jsonl` logs. Usage comes from `assistant/message`: cache writes join uncached input, cache reads remain separate, and reasoning is split out of inclusive output. Fork/subagent history is de-duplicated from the immutable header: `parentSession` identifies the source and `seedLength` gives the exact leading event boundary. Inherited messages are skipped only when matching source seqs remain in the parent file; missing parents fail open. `session/end-seed` positions are not used because resumes can append the marker after real history. |
| Hermes | `~/.hermes/state.db` + `~/.hermes/profiles/<name>/state.db` (SQLite, multi-profile) |
| Kiro | Kiro CLI native event streams `~/.kiro/sessions/cli/*.jsonl` (estimated tokens from message text: input = prompt + tool results, output = reply + tool calls, reasoning = thinking, cacheRead = re-sent context; thinking-block signatures excluded). Falls back to `~/Library/Application Support/kiro-cli/data.sqlite3` / `~/.local/share/kiro-cli/data.sqlite3` + optional `~/.kiro_sessions/*.json` archives, then IDE `q-client.log` whole-credit deltas as `kiro-credits` (floored cumulative diff — the server stores token counts as bigint); legacy IDE `dev_data/devdata.sqlite` token telemetry is opt-in with `VIBE_USAGE_KIRO_LEGACY_TOKENS=1` |
| Cline | Standalone `~/.cline/` plus `<host>/User/globalStorage/saoudrizwan.claude-dev/` across VSCode-fork hosts; migrated copies are deduplicated and empty leftover extension stores no longer count as installed |
| Roo Code | `<host>/User/globalStorage/rooveterinaryinc.roo-cline/{tasks/_index.json,tasks/<id>/{history_item,ui_messages}.json}` (walks all VSCode-fork hosts) |
| Trae CLI | macOS: `~/Library/Caches/trae-cli/sessions/`; Windows: `%LOCALAPPDATA%/trae-cli/cache/sessions/`; Linux: `~/.cache/trae-cli/sessions/` (CLI telemetry only; Trae IDE/Trae Work chats are not supported). Token usage is summed per unique LLM call (`model.stream.eino`, plus `model.generate` failovers); nested duplicate spans that share a session `traceID` are not max-merged. `traces.jsonl` / `events.jsonl` are streamed line-by-line so a multi-hundred-MB events file cannot hit Node's string-length limit. |
| Antigravity | App 2.0 `~/.gemini/antigravity/conversations/*.db` and `agy` CLI `~/.gemini/antigravity-cli/conversations/*.db` are parsed offline (tokens, real model display name when present, project, sessions). Gemini 3.7 CLI blobs omit `chatStartMetadata.createdAt` and `modelDisplayName`; usage still comes from `gen_metadata`, timestamps fall back to `steps.metadata` at the same idx, and the model name falls back to `responseModel`. Legacy App `.pb` history falls back to Connect RPC while the language server is running |
| WorkBuddy | Current releases: `~/.workbuddy-ai/projects/**/*.jsonl`; legacy releases: `~/.workbuddy/projects/**/*.jsonl` (fixture/relocation override: `VIBE_USAGE_WORKBUDDY_DIRS`). Reads usage-bearing completed assistant and `function_call` records, using the routed model identifier exposed as `providerData.requestModelId`. Splits cache reads and reasoning from inclusive input/output totals, deduplicates copied record IDs, and extracts local session timing without uploading message content. |
| ZCode | `~/.zcode/cli/db/db.sqlite` (SQLite; reads the `message` table for per-message tokens, model, and project `cwd`/`root`, joined to `session.directory`) |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Extracts session metadata where the source safely exposes user/assistant timing: active time (AI generation time, excluding queue/TTFT wait), total duration, and message counts. Alma intentionally emits buckets only; Cindy's daily-ledger augmentation adds no timing data to the native Codex/pi sessions because doing so would require reading Cindy chat records.
- Uploads buckets + sessions to your vibecafe.ai dashboard (always gzip-compressed, ~94% smaller)
- Incremental upload: every parser emits a complete local snapshot, then only buckets/sessions that are new or changed since the last successful upload are sent — a quiet machine uploads nothing. Upload state remains in `~/.vibe-usage/state.json`; failed or still-indexing parsers retain their prior state, while deleted local logs are pruned. Deleting the state file triggers a one-time full re-upload, and `reset` clears it automatically after deleting cloud data
- Incremental Codex parsing: a versioned, disposable cache under `~/.vibe-usage/cache/codex/` stores per-rollout aggregate results and parser continuation state. Unchanged rollouts require no raw-log reads; an ordinary append reads only the new tail; forks, sub-agents, replacements, truncations, and failed safety checks fall back to the full correctness path. A bounded rolling audit occasionally re-reads one historical file. Very large first-time indexes checkpoint before the Mac app timeout and resume on the next sync instead of restarting
- The Codex parser cache contains derived aggregates and replay metadata, not raw prompt or response text. It is independent of upload state and can be deleted safely (the next sync rebuilds it). `reset` intentionally keeps it so the required full re-upload does not also require a full disk rescan. Set `VIBE_USAGE_CODEX_CACHE=0` to disable the optimization for diagnosis
- SQLite-backed tools are read via Node's built-in `node:sqlite` on Node ≥ 22.5 — no `sqlite3` binary needed (works on Windows out of the box); on older Node the CLI falls back to the system `sqlite3` executable
- For continuous syncing, use `npx @vibe-cafe/vibe-usage daemon` or the [Vibe Usage Mac app](https://github.com/vibe-cafe/vibe-usage-app)

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

The `hostname` is captured once during `init` and reused for all future syncs. This prevents macOS mDNS hostname changes (e.g., `MacBook-Pro` → `MacBook-Pro-2`) from creating duplicate device entries. To change it manually:

```bash
npx @vibe-cafe/vibe-usage config set hostname my-device-name
```

## Daemon Mode

### Background service (recommended)

Install as a system service for automatic background syncing:

```bash
npx @vibe-cafe/vibe-usage daemon install
```

This creates a user-level service (systemd on Linux, launchd on macOS) that syncs every 30 minutes and starts automatically on login. Manage with:

```bash
npx @vibe-cafe/vibe-usage daemon status
npx @vibe-cafe/vibe-usage daemon stop
npx @vibe-cafe/vibe-usage daemon restart
npx @vibe-cafe/vibe-usage daemon uninstall
```

For reliable operation, install globally first: `npm install -g @vibe-cafe/vibe-usage`

### Foreground mode

Run continuous syncing in the foreground (every 30 minutes):

```bash
npx @vibe-cafe/vibe-usage daemon
```

Press Ctrl+C to stop.

## License

MIT
