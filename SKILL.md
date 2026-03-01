---
name: vibe_usage
description: Track and sync AI coding tool token usage to vibecafe.ai dashboard.
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

Track your AI coding tool token usage and sync to [vibecafe.ai](https://vibecafe.ai/usage).

## Setup

First-time setup (interactive — asks for API key):

```bash
npx @vibe-cafe/vibe-usage
```

Get your API key at https://vibecafe.ai/usage/setup

## Commands

When the user asks to sync usage, check costs, or track tokens, run:

```bash
npx @vibe-cafe/vibe-usage sync
```

Other available commands:

| Command | Description |
|---------|-------------|
| `npx @vibe-cafe/vibe-usage sync` | Sync latest usage data |
| `npx @vibe-cafe/vibe-usage status` | Show config and detected tools |
| `npx @vibe-cafe/vibe-usage daemon` | Continuous sync every 5 minutes |
| `npx @vibe-cafe/vibe-usage reset` | Delete all data and re-upload |
| `npx @vibe-cafe/vibe-usage reset --local` | Delete this host's data and re-upload |

## When to Use

- User says "sync my usage", "upload usage", "track tokens"
- User asks "how much have I spent?", "what's my cost?"
- User wants to check if sync is working: run `status`
- User wants continuous background sync: run `daemon`

## Notes

- Requires initial setup with an API key (run `npx @vibe-cafe/vibe-usage` first)
- Config is stored at `~/.vibe-usage/config.json`
- Supports: Claude Code, Codex CLI, Gemini CLI, OpenCode, OpenClaw
