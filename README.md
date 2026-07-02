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
npx @vibe-cafe/vibe-usage summary       # Print last 7 days as markdown (cost / tokens / by model / by project)
npx @vibe-cafe/vibe-usage summary --days N  # Same, over the last N days (1-90)
npx @vibe-cafe/vibe-usage daemon       # Continuous sync (every 30m, foreground)
npx @vibe-cafe/vibe-usage daemon install    # Install background service (systemd/launchd)
npx @vibe-cafe/vibe-usage daemon uninstall  # Remove background service
npx @vibe-cafe/vibe-usage daemon status     # Show background service status
npx @vibe-cafe/vibe-usage daemon stop       # Stop background service
npx @vibe-cafe/vibe-usage daemon restart    # Restart background service
npx @vibe-cafe/vibe-usage reset        # Delete all data and re-upload from local logs
npx @vibe-cafe/vibe-usage reset --local  # Delete this host's data only and re-upload
npx @vibe-cafe/vibe-usage skill         # Install skill for AI coding assistants
npx @vibe-cafe/vibe-usage skill --remove  # Remove installed skills
npx @vibe-cafe/vibe-usage status       # Show config & detected tools
```

## Supported Tools

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/` (tokens + sessions), `~/.claude/transcripts/` (sessions only); also scans `$CLAUDE_CONFIG_DIR` when set (deduped), so relocated configs and GUI/CLI env mismatches are both covered |
| Codex CLI | `~/.codex/sessions/` and `~/.codex/archived_sessions/` |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` |
| Cursor | `state.vscdb` (SQLite, reads `cursorAuth/accessToken`, fetches CSV from `cursor.com`); cloud data is stamped with a fixed `cursor-cloud` hostname so multi-machine setups don't double-count |
| Gemini CLI | `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl` (current line-delimited format) and legacy `session-*.json`; recurses into nested subagent sessions |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite, `json_extract` query) |
| OpenClaw | `~/.openclaw/agents/`, `~/.openclaw-<profile>/agents/` (profile deployments) |
| pi | `~/.pi/agent/sessions/` |
| Qwen Code | `~/.qwen/tmp/` |
| Kimi Code | `~/.kimi/sessions/<md5(workdir)>/<session-id>/wire.jsonl` (wire protocol 1.9, model from `~/.kimi/config.toml`, project from `~/.kimi/kimi.json`) |
| Amp | `~/.local/share/amp/threads/` |
| Droid | `~/.factory/sessions/` |
| Hermes | `~/.hermes/state.db` + `~/.hermes/profiles/<name>/state.db` (SQLite, multi-profile) |
| Kiro | Kiro CLI native event streams `~/.kiro/sessions/cli/*.jsonl` (estimated tokens from message text: input = prompt + tool results, output = reply + tool calls, reasoning = thinking, cacheRead = re-sent context; thinking-block signatures excluded). Falls back to `~/Library/Application Support/kiro-cli/data.sqlite3` / `~/.local/share/kiro-cli/data.sqlite3` + optional `~/.kiro_sessions/*.json` archives, then IDE `q-client.log` whole-credit deltas as `kiro-credits` (floored cumulative diff — the server stores token counts as bigint); legacy IDE `dev_data/devdata.sqlite` token telemetry is opt-in with `VIBE_USAGE_KIRO_LEGACY_TOKENS=1` |
| Cline | `<host>/User/globalStorage/saoudrizwan.claude-dev/{state/taskHistory.json,tasks/<id>/ui_messages.json}` (walks all VSCode-fork hosts: Code, Cursor, Windsurf, VSCodium, Trae, ...) |
| Roo Code | `<host>/User/globalStorage/rooveterinaryinc.roo-cline/{tasks/_index.json,tasks/<id>/{history_item,ui_messages}.json}` (walks all VSCode-fork hosts) |
| Antigravity | `~/.gemini/antigravity/conversations/*.pb` to discover cascades, then reads token usage + sessions from the running language server via Connect RPC (process discovered with `ps`/`lsof` on macOS/Linux, PowerShell CIM with a `wmic` fallback on Windows) |
| ZCode | `~/.zcode/cli/db/db.sqlite` (SQLite; reads the `message` table for per-message tokens, model, and project `cwd`/`root`, joined to `session.directory`) |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Extracts session metadata from all parsers: active time (AI generation time, excluding queue/TTFT wait), total duration, message counts
- Uploads buckets + sessions to your vibecafe.ai dashboard (always gzip-compressed, ~94% smaller)
- Incremental: parsers still compute full totals from local logs each sync (idempotent), but only buckets/sessions that are new or changed since the last successful upload are sent — a quiet machine uploads nothing. Sync state is kept in `~/.vibe-usage/state.json`; deleting it just triggers a one-time full re-upload
- SQLite-backed tools (Cursor, OpenCode, Kiro, Hermes) are read via Node's built-in `node:sqlite` on Node ≥ 22.5 — no `sqlite3` binary needed (works on Windows out of the box); on older Node it falls back to the system `sqlite3` CLI
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
