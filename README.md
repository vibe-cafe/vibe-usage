# vibe-usage

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai).

## Quick Start

Get your API key at [vibecafe.ai/usage](https://vibecafe.ai/usage), then copy the one-liner shown there:

```bash
npx @vibe-cafe/vibe-usage --key vbu_xxxxxxxxxxxx
```

Or run without a key and paste it interactively:

```bash
npx @vibe-cafe/vibe-usage
```

Either path will:
1. Save your API key to `~/.vibe-usage/config.json`
2. Detect installed AI coding tools
3. Run an initial sync of your usage data
4. Prompt you to enable the background daemon for continuous syncing (recommended)

## Commands

```bash
npx @vibe-cafe/vibe-usage              # Init (first run) or sync (subsequent runs)
npx @vibe-cafe/vibe-usage --key <vbu_...>   # One-shot init with a pre-copied key
npx @vibe-cafe/vibe-usage init         # Re-run setup
npx @vibe-cafe/vibe-usage sync         # Manual sync
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
| Claude Code | `~/.claude/projects/` (tokens + sessions), `~/.claude/transcripts/` (sessions only) |
| Codex CLI | `~/.codex/sessions/` |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` |
| Gemini CLI | `~/.gemini/tmp/` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite, `json_extract` query) |
| OpenClaw | `~/.openclaw/agents/`, `~/.openclaw-<profile>/agents/` (profile deployments) |
| pi | `~/.pi/agent/sessions/` |
| Qwen Code | `~/.qwen/tmp/` |
| Kimi Code | `~/.kimi/sessions/` |
| Amp | `~/.local/share/amp/threads/` |
| Droid | `~/.factory/sessions/` |
| Hermes | `~/.hermes/state.db` + `~/.hermes/profiles/<name>/state.db` (SQLite, multi-profile) |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Extracts session metadata from all parsers: active time (AI generation time, excluding queue/TTFT wait), total duration, message counts
- Uploads buckets + sessions to your vibecafe.ai dashboard (gzip-compressed when ≥ 1 KB, ~94% smaller)
- Stateless: computes full totals from local logs each sync (idempotent, no state files)
- For continuous syncing, use `npx @vibe-cafe/vibe-usage daemon` or the [Vibe Usage Mac app](https://github.com/vibe-cafe/vibe-usage-app)

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
