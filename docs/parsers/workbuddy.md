# WorkBuddy parser

Parses token usage from [WorkBuddy](https://www.workbuddy.cn) into the standard
`{ buckets, sessions }` shape consumed by `vibe-usage sync`.

- Source string sent to the backend: **`workbuddy`**
- Parser file: [`src/parsers/workbuddy.js`](./workbuddy.js)
- Data-root discovery: [`src/workbuddy-roots.js`](../workbuddy-roots.js)
- Registered in [`src/parsers/index.js`](./index.js) and [`src/tools.js`](./tools.js)

> Integrated upstream in `ebe797e` (co-authored with @poying2018). This document
> describes the current upstream implementation.

> ⚠️ **Backend allow-list required.** The parser parses correctly, but the
> vibecafe.ai backend currently drops any `workbuddy` bucket
> (`服务端未收录的 source: workbuddy`). `workbuddy` must be registered as an
> accepted `source` on the backend before data shows on the dashboard. See
> issue #56.

## Where the data lives

WorkBuddy stores one JSONL transcript per session. The parser discovers data
roots via `findWorkbuddyDataDirs()` (in `src/workbuddy-roots.js`) and appends
`projects` to each root, scanning:

```
~/.workbuddy/projects/<project>/<sessionId>.jsonl
~/.workbuddy-ai/projects/<project>/<sessionId>.jsonl
```

- `<project>` — the workspace / project name (last path component of the session
  `cwd`, or the first path segment of the file relative to the projects dir).
- `<sessionId>` — the session id (also used as a fallback session id when a
  record has no explicit `sessionId`).

The parser walks every `*.jsonl` file under each `projects` directory recursively.

## JSONL event schema

Each line is one event object with a `type` field. The parser reads two families
of records for tokens, and `message` records for session timing.

### `message` — timing / session events

```jsonc
{
  "type": "message",
  "role": "user" | "assistant",
  "status": "completed",          // assistant messages must be "completed" to count
  "cwd": "F:\\aigame",            // used to derive the project name
  "sessionId": "a1b2c3...",
  "id": "msg_001",                // stable per-record id (dedup key)
  "timestamp": "2026-07-15T12:10:18.000Z"
}
```

### `function_call` — token usage (primary)

```jsonc
{
  "type": "function_call",
  "id": "fc_001",
  "timestamp": "2026-07-15T12:10:20.000Z",
  "sessionId": "a1b2c3...",
  "providerData": {
    "model": "hy3",
    "usage": { /* normalized shape, see below */ },
    "rawUsage": { /* provider-native shape, see below */ }
  }
}
```

Unlike Claude Code (which puts usage on the assistant `message`), WorkBuddy
attaches the per-request token usage to the `function_call` that triggered the
underlying LLM request. The parser reads `providerData.usage`, falls back to
`providerData.rawUsage`, and also accepts `message.usage` on completed assistant
messages.

## Usage shapes (both supported)

WorkBuddy may emit either a normalized shape or a provider-native (OpenAI-style)
shape. The parser handles both, plus a few extra field-name variants.

**Normalized**

```jsonc
{
  "inputTokens": 1911050,
  "outputTokens": 18453,
  "inputTokensDetails": [{ "cached_tokens": 1733504 }],
  "outputTokensDetails": [{ "reasoning_tokens": 1790 }]
}
```

**Provider-native (OpenAI-style)**

```jsonc
{
  "prompt_tokens": 1911050,
  "completion_tokens": 18453,
  "prompt_tokens_details": { "cached_tokens": 1733504 },
  "completion_tokens_details": { "reasoning_tokens": 1790 }
}
```

Mapping to bucket fields (first non-null match wins for each detail group):

| Bucket field            | Normalized sources                                                         | Raw (OpenAI) sources                              |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `inputTokens`           | `inputTokens` / `input_tokens`                                            | `prompt_tokens`                                  |
| `outputTokens`          | `outputTokens` / `output_tokens`                                           | `completion_tokens`                              |
| `cachedInputTokens`     | `inputTokensDetails[].cached_tokens`, `cache_read_input_tokens`           | `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` |
| `reasoningOutputTokens` | `outputTokensDetails[].reasoning_tokens`, `completion_thinking_tokens`    | `completion_tokens_details.reasoning_tokens`, `completion_thinking_tokens` |

Notes:
- Input/output aggregates in WorkBuddy include cache reads and reasoning. The
  parser subtracts `cachedInputTokens` / `reasoningOutputTokens` from the
  inclusive totals to avoid double counting. When a provider exposes an
  exclusive `prompt_cache_miss_tokens` field, that is preferred as `inputTokens`.
- `model` priority: `providerData.requestModelId` → `requestModelName` →
  `providerData.model`, defaulting to `unknown`.

## Project name derivation

The project name is the last path component of the session `cwd` (bare
drive-letter components like `C:` / `g:` are dropped), falling back to the first
path segment of the file relative to its `projects` directory. This matches how
other parsers (Claude Code, etc.) name projects.

## Buckets & sessions

- **Buckets** are produced by `aggregateToBuckets(entries)` (shared helper):
  keyed by `source | model | project | hostname | halfHourBucket`, summing
  input/output/cached/reasoning tokens. Records are de-duplicated by their stable
  `id`, keeping the highest-score (most complete) usage per id.
- **Sessions** are produced by `extractSessions(events)` (shared helper) from the
  `message` / `function_call` timing events, grouped by `sessionId`. Only sessions
  that contain at least one user prompt are emitted. Fields: `sessionHash`,
  `firstMessageAt`, `lastMessageAt`, `durationSeconds`, `activeSeconds`,
  `messageCount`, `userMessageCount`, `userPromptHours[24]`.

## Configuration & testing

- `VIBE_USAGE_WORKBUDDY_DIRS` — semicolon-separated list of data roots to scan
  instead of the discovered defaults (each is treated the same way — `projects`
  is appended when missing). Handy for pointing the parser at a test fixture:

  ```sh
  VIBE_USAGE_WORKBUDDY_DIRS="$PWD/test/fixtures/workbuddy" vibe-usage status
  ```

- The tool entry in `TOOLS` (`findWorkbuddyDataDirs`) also honors this override
  and is used by `detectInstalledTools`.

## Local verification (example)

```
buckets:   132
sessions:  48
models:    hy3, deepseek-v4-flash, deepseek-v4-pro, glm-5.2,
           mimo-v2.5-pro-ultraspeed, agnes-2.0-flash
elapsed:   ~560ms
```
