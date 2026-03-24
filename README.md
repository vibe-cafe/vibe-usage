# vibe-usage

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai).

## Quick Start

```bash
npx @vibe-cafe/vibe-usage
```

This will:
1. Ask for your API key (get one at https://vibecafe.ai/usage/setup)
2. Detect installed AI coding tools
3. Run an initial sync of your usage data

## Commands

```bash
npx @vibe-cafe/vibe-usage              # Init (first run) or sync (subsequent runs)
npx @vibe-cafe/vibe-usage init         # Re-run setup
npx @vibe-cafe/vibe-usage sync         # Manual sync
npx @vibe-cafe/vibe-usage daemon       # Continuous sync (every 5 minutes)
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
| OpenClaw | `~/.openclaw/agents/` |
| pi | `~/.pi/agent/sessions/` |
| Qwen Code | `~/.qwen/tmp/` |
| Kimi Code | `~/.kimi/sessions/` |
| Amp | `~/.local/share/amp/threads/` |
| Droid | `~/.factory/sessions/` |

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Extracts session metadata from all 10 parsers: active time (AI generation time, excluding queue/TTFT wait), total duration, message counts
- Uploads buckets + sessions to your vibecafe.ai dashboard
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

Config stored at `~/.vibe-usage/config.json` (dev: `config.dev.json`). Contains your API key and server URL.

## Daemon Mode

Run continuous syncing in the foreground (every 5 minutes):

```bash
npx @vibe-cafe/vibe-usage daemon
```

Press Ctrl+C to stop. For background use: `nohup npx @vibe-cafe/vibe-usage daemon &`

## License

MIT
