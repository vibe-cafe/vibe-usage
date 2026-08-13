# WorkBuddy parser

Parses AI-coding token usage from [WorkBuddy](https://www.workbuddy.cn) into the
standard `{ buckets, sessions }` shape consumed by `vibe-usage sync`.

- **Source string sent to the backend:** `workbuddy`
- **Parser file:** [`src/parsers/workbuddy.js`](../../src/parsers/workbuddy.js)
- **Data-root discovery:** [`src/workbuddy-roots.js`](../../src/workbuddy-roots.js)
- **Registered in:** [`src/parsers/index.js`](../../src/parsers/index.js)
  (`'workbuddy': parseWorkbuddy`) and
  [`src/tools.js`](../../src/tools.js) (`TOOLS` entry `id: 'workbuddy'`)
- **Status:** integrated upstream in `ebe797e`
  ("Fix current WorkBuddy storage and usage records", co-authored with
  @poying2018), building on `cb255fba99` ("Add WorkBuddy and Alma usage support").

> ⚠️ **Backend allow-list required (action needed).** The parser parses
> correctly and `vibe-usage sync` uploads the data, but the vibecafe.ai backend
> currently drops any `workbuddy` bucket with
> `服务端未收录的 source: workbuddy`. `workbuddy` must be registered as an
> accepted `source` server-side before data appears on the dashboard. Tracked
> in issue #56.

---

## 1. Where the data lives

WorkBuddy keeps one JSONL transcript per session. The parser discovers data
roots via `findWorkbuddyDataDirs()` (in
[`src/workbuddy-roots.js`](../../src/workbuddy-roots.js)) and **appends
`projects` to each root if missing**, then scans every `*.jsonl` file
recursively:

```
~/.workbuddy-ai/projects/<project>/<sessionId>.jsonl
~/.workbuddy/projects/<project>/<sessionId>.jsonl
```

`findWorkbuddyDataDirs()` returns (in priority order):

1. `VIBE_USAGE_WORKBUDDY_DIRS` (env override, see §6) when set.
2. Otherwise the two defaults above, **`.workbuddy-ai` first, then
   `.workbuddy`**.

`<project>` — the workspace / project name. The parser prefers the last path
component of the session `cwd`, and falls back to the first path segment of the
file relative to its `projects` directory. Bare drive-letter components
(`C:`, `g:`) are dropped.

`<sessionId>` — the session id. It is also used as a **fallback session id** when
a record carries no explicit `sessionId`.

The `TOOLS` entry in `src/tools.js` uses `dataDir: join(homedir(),
'.workbuddy-ai', 'projects')` as the canonical install root for
`detectInstalledTools`, and its `detectDataDirs` returns
`findWorkbuddyDataDirs().filter(existsSync)`.

---

## 2. JSONL event schema

Each line is one event object with a `type` field. The parser reads two families
of records for tokens and `message` records for session timing.

### `message` — timing / session events

```jsonc
{
  "type": "message",
  "role": "user" | "assistant",
  "status": "completed",                 // assistant must be "completed/complete/success" to count
  "cwd": "F:\\aigame",                   // derives the project name
  "sessionId": "a1b2c3...",
  "id": "msg_001",                       // stable per-record id (dedup key)
  "timestamp": "2026-07-15T12:10:18.000Z"
}
```

- `role` resolves from `record.role ?? record.message?.role` → `user` or
  `assistant`.
- A completed assistant message is one whose `type === 'message'`, role is
  `assistant`, **and** `status` (checked across `status` / `message.status` /
  `state` / `message.state`, lower-cased) is `completed` / `complete` /
  `success`. Completed assistant messages may also carry usage (see §3).

### `function_call` — token usage (primary path)

```jsonc
{
  "type": "function_call",
  "id": "fc_001",
  "timestamp": "2026-07-15T12:10:20.000Z",
  "sessionId": "a1b2c3...",
  "providerData": {
    "model": "hy3",
    "usage": { /* normalized shape, see §3 */ },
    "rawUsage": { /* provider-native shape, see §3 */ }
  }
}
```

Unlike Claude Code (usage on the assistant `message`), WorkBuddy attaches the
per-request token usage to the `function_call` that triggered the underlying LLM
request. The parser treats a record as a usage record when it is a completed
assistant `message` **or** a `function_call` whose `providerData` is an object.

---

## 3. Usage shapes (both supported)

WorkBuddy may emit either a **normalized** shape or a **provider-native
(OpenAI-style)** shape, plus a few extra field-name variants. The parser reads
`providerData.usage` first, falls back to `message.usage`, and uses
`providerData.rawUsage` as a supplementary detail source.

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

### Field mapping (first non-null match wins per detail group)

| Bucket field            | Normalized sources                                                                  | Raw (OpenAI) sources                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `inputTokens`           | `inputTokens` / `input_tokens`                                                     | `prompt_tokens`                                                            |
| `outputTokens`          | `outputTokens` / `output_tokens`                                                   | `completion_tokens`                                                        |
| `cachedInputTokens`     | `inputTokensDetails[].cached_tokens`, `cache_read_input_tokens`                    | `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`           |
| `reasoningOutputTokens` | `outputTokensDetails[].reasoning_tokens`, `completion_thinking_tokens`            | `completion_tokens_details.reasoning_tokens`, `completion_thinking_tokens` |

Detail objects are searched across `input_details` / `inputDetails` /
`inputTokensDetails` / `prompt_tokens_details` (input) and the matching output
variants.

### Counting rules

- WorkBuddy's aggregate input/output fields **include** cache reads and
  reasoning tokens. The parser subtracts `cachedInputTokens` /
  `reasoningOutputTokens` from the inclusive totals to avoid double counting.
- When a provider exposes an **exclusive** `prompt_cache_miss_tokens` field, that
  value is preferred directly as `inputTokens` (no subtraction).
- A usage record with a total score of 0 (all token fields empty) is skipped.

### Model resolution (priority)

```
providerData.requestModelId
  → record.requestModelName
  → providerData.requestModelName
  → providerData.model
  → "unknown"
```

### Timestamp resolution (priority)

```
completedAt / completed_at
  → timestamp
  → createdAt / created_at
  → message.createdAt
```

Acceptable as a Date, a numeric epoch (ms if ≥ 1e12 else seconds), or an
ISO-8601 string.

---

## 4. Buckets & sessions

- **Buckets** — produced by `aggregateToBuckets(entries)` (shared helper). Keyed
  by `source | model | project | hostname | halfHourBucket`, summing
  input/output/cached/reasoning tokens. Records are de-duplicated by their stable
  `id`, keeping the **highest-score** (most complete) usage per id.
- **Sessions** — produced by `extractSessions(events)` (shared helper) from the
  `message` / `function_call` timing events, grouped by `sessionId`. Only
  sessions that contain **at least one user prompt** are emitted (the helper
  filters out sessions with no `user` event). Fields: `sessionHash`,
  `firstMessageAt`, `lastMessageAt`, `durationSeconds`, `activeSeconds`,
  `messageCount`, `userMessageCount`, `userPromptHours[24]`.

The `hostname` is filled by the shared `aggregateToBuckets` helper (from the
local machine), not by the parser itself.

---

## 5. Local verification (real example)

Running the parser against a real `~/.workbuddy/projects` tree:

```
buckets:   132
sessions:  48
models:    hy3, deepseek-v4-flash, deepseek-v4-pro, glm-5.2,
           mimo-v2.5-pro-ultraspeed, agnes-2.0-flash
elapsed:   ~560ms
```

(Numbers vary with the local transcript history.)

You can confirm the parser is wired up with:

```sh
vibe-usage status        # "WorkBuddy" should appear under detected tools
vibe-usage sync --dry-run # parses and prints buckets/sessions without uploading
```

---

## 6. Configuration & testing

`VIBE_USAGE_WORKBUDDY_DIRS` — semicolon/path-delimited list of data roots to
scan instead of the discovered defaults. Each entry may name either the
WorkBuddy home (e.g. `~/.workbuddy`) **or** its `projects/` directory; the parser
normalizes both forms (appends `projects` when missing). Handy for pointing at a
test fixture:

```sh
VIBE_USAGE_WORKBUDDY_DIRS="$PWD/test/fixtures/workbuddy" vibe-usage status
```

The override is honored by both `findWorkbuddyDataDirs()` (parser) and the
`TOOLS` `detectDataDirs` entry.

---

## 7. FAQ / troubleshooting

**Q: My data isn't showing on the vibecafe.ai dashboard.**
A: The parser works, but the backend allow-list does not yet contain `workbuddy`.
Sync uploads succeed but the buckets are dropped server-side
(`服务端未收录的 source: workbuddy`). This is a backend change, not a parser bug.
See issue #56.

**Q: Should I point at `~/.workbuddy` or `~/.workbuddy-ai`?**
A: Both are scanned. `findWorkbuddyDataDirs()` tries `.workbuddy-ai/projects`
first, then `.workbuddy/projects`. Use `VIBE_USAGE_WORKBUDDY_DIRS` to force a
specific root.

**Q: Buckets come back as 0.**
A: Check that sessions contain `function_call` records with a non-empty
`providerData.usage` (or completed assistant `message.usage`), and that
`VIBE_USAGE_WORKBUDDY_DIRS` (if set) points at a directory that contains
`*.jsonl` transcripts. The parser emits `warnings` in its result when it cannot
read a directory or file.

**Q: Why does the model sometimes show as `unknown`?**
A: None of the four model fields (`requestModelId`, `requestModelName`,
`providerData.requestModelName`, `providerData.model`) was present on the usage
record. Add the field to the provider payload or extend `modelFor()`.

---

## 8. Backend registration checklist (for maintainers)

To fully light up WorkBuddy on the dashboard:

1. Merge the parser (already in `main` via `ebe797e`).
2. Register `workbuddy` as an accepted `source` in the vibecafe.ai backend
   allow-list. (issue #56)
3. (Optional) Add a unit-test fixture under `test/fixtures/workbuddy/` and a
   case in the parser test suite.

Once step 2 lands, existing and future `vibe-usage sync` uploads from WorkBuddy
users will appear with no client-side change.
