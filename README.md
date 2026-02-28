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
npx vibe-usage          # Init (first run) or sync (subsequent runs)
npx vibe-usage init     # Re-run setup
npx vibe-usage sync     # Manual sync
npx vibe-usage reset    # Delete all data and re-upload from local logs
npx vibe-usage status   # Show config & detected tools
```

## Supported Tools

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/` |
| Codex CLI | `~/.codex/sessions/` |
| Gemini CLI | `~/.gemini/tmp/` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) |
| OpenClaw | `~/.openclaw/agents/` |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Uploads to your vibecafe.ai dashboard
- Only syncs new data since last sync (incremental)
- For continuous syncing, use the [Vibe Usage Mac app](https://github.com/vibe-cafe/vibe-usage-app) (auto-syncs every 5 minutes)

## Config

Config stored at `~/.vibe-usage/config.json`. Contains your API key and last sync timestamp.

## License

MIT
