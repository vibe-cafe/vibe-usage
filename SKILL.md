---
name: vibe-usage
description: Track and sync AI coding tool token usage to vibefriends.com dashboard.
metadata:
  {
    "openclaw": {
      "emoji": "📊",
      "requires": { "bins": ["npx"] },
      "install": [{ "id": "vibe-usage", "kind": "npm", "package": "@vibe-cafe/vibe-usage" }]
    }
  }
---

# Vibe Usage

Track your AI coding tool token usage and sync to [vibefriends.com](https://vibefriends.com/usage).

## Setup

First-time setup (interactive — opens the browser for login, then syncs and turns on background sync):

```bash
npx @vibe-cafe/vibe-usage
```

Headless machines: pre-issue a key at https://vibefriends.com/usage/setup and run `npx @vibe-cafe/vibe-usage init --manual-key <vbu_...> --no-daemon`.

## Commands

When the user asks to sync usage, check costs, or track tokens, run:

```bash
npx @vibe-cafe/vibe-usage sync
```

Other available commands:

| Command | Description |
|---------|-------------|
| `npx @vibe-cafe/vibe-usage sync` | Sync latest usage data |
| `npx @vibe-cafe/vibe-usage status` | Show config, detected tools, and how much each tool has uploaded |
| `npx @vibe-cafe/vibe-usage daemon status` | Check the background sync service (installed by first run) |
| `npx @vibe-cafe/vibe-usage reset` | Delete all data and re-upload |
| `npx @vibe-cafe/vibe-usage reset --local` | Delete this host's data and re-upload |

## When to Use

- User says "sync my usage", "upload usage", "track tokens"
- User asks "how much have I spent?", "what's my cost?"
- User wants to check if sync is working: run `status`
- User asks whether background sync is on: run `daemon status` (the first run installs it; `daemon install` re-enables it after `--no-daemon` or `daemon uninstall`)

## Notes

- Requires initial setup (run `npx @vibe-cafe/vibe-usage` first — browser login, no key to copy)
- Config is stored at `~/.vibe-usage/config.json`
- Supports: Claude Code, Codex, Grok, and others
