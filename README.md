# vibe-usage

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai).

## Quick Start

```bash
npx vibe-usage
```

This will:
1. Ask for your API key (get one at https://vibecafe.ai/usage/setup)
2. Detect installed AI coding tools
3. Run an initial sync of your usage data

## Commands

```bash
npx vibe-usage              # Init (first run) or sync (subsequent runs)
npx vibe-usage init         # Re-run setup
npx vibe-usage sync         # Manual sync
npx vibe-usage daemon       # Continuous sync (every 5 minutes)
npx vibe-usage reset        # Delete all data and re-upload from local logs
npx vibe-usage reset --local  # Delete this host's data only and re-upload
npx vibe-usage status       # Show config & detected tools
```

## Supported Tools

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/` |
| Codex CLI | `~/.codex/sessions/` |
| Gemini CLI | `~/.gemini/tmp/` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) |
| OpenClaw | `~/.openclaw/agents/` |
| Qwen Code | `~/.qwen/tmp/` |
| Kimi Code | `~/.kimi/sessions/` |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Uploads to your vibecafe.ai dashboard
- Stateless: computes full totals from local logs each sync (idempotent, no state files)
- For continuous syncing, use `npx vibe-usage daemon` or the [Vibe Usage Mac app](https://github.com/vibe-cafe/vibe-usage-app)

## Config

Config stored at `~/.vibe-usage/config.json`. Contains your API key and server URL.

## Daemon Mode

Run continuous syncing in the foreground (every 5 minutes):

```bash
npx vibe-usage daemon
```

Press Ctrl+C to stop. For background use: `nohup npx vibe-usage daemon &`

## License

MIT
