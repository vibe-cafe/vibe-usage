# Kiro CLI token estimation — design note

*Context for the `kiro.js` change that adds a native `~/.kiro/sessions/cli/*.jsonl`
event-stream parser. Companion HTML: [`kiro-cli-token-estimation.html`](./kiro-cli-token-estimation.html).
中文版:[`kiro-cli-token-estimation.zh.md`](./kiro-cli-token-estimation.zh.md) ·
[`kiro-cli-token-estimation.zh.html`](./kiro-cli-token-estimation.zh.html).*

## TL;DR

- The **shipping Kiro CLI** stores each conversation as a `{version, kind, data}`
  **event stream** at `~/.kiro/sessions/cli/<uuid>.jsonl` (companion `<uuid>.json`
  holds `cwd` + model). It does **not** populate `data.sqlite3`'s `conversations_v2`
  table, so the `858336b` CLI path reads **zero** rows on these installs.
- This change adds that event stream as the **first** Kiro data source, estimates
  in/out/thinking/cache tokens from text (`chars/4`), and falls back to the existing
  credit / legacy paths when it is absent.
- Numbers were **cross-validated** against an independent re-count (input reconciles
  to **99.5%**). One correctness trap is called out and handled: **thinking-block
  crypto signatures must be excluded from token counts** (they are ~1.5M "tokens"
  of noise on a real machine and would inflate output by >100%).

## Why the previous CLI path finds nothing

`858336b` reads `conversations_v2` / `conversations` from
`~/Library/Application Support/kiro-cli/data.sqlite3`, plus `~/.kiro_sessions/*.json`
archives. On a real, heavily-used Kiro CLI install:

| Source the `858336b` path reads | Rows on the test machine |
|---|---|
| `data.sqlite3` → `conversations_v2` | **0** |
| `data.sqlite3` → `conversations` | **0** |
| `~/.kiro_sessions/*.json` | directory absent |

The actual conversation data lives in `~/.kiro/sessions/cli/*.jsonl` (116 files
touched over 2 days on the test machine), in an event-stream format — not the
`history[]` shape the DB path expects.

## The native format

`<uuid>.jsonl` — one JSON event per line, `{version, kind, data}`:

| kind | payload | maps to |
|---|---|---|
| `Prompt` | `data.content[]` (`text` / `image`); `data.meta.timestamp` = epoch **seconds** | fresh input; **only** timestamp source |
| `AssistantMessage` | `content[]`: `text` (reply), `thinking` (`text` + `modelId` + crypto `signature`), `toolUse` (`name` + `input`) | output / reasoning; model id |
| `ToolResults` | `content[]` tool output | fresh input to the next turn |
| `Compaction` | `summary` | resets the running context size |

`<uuid>.json` — session metadata: `cwd` (→ project) and
`session_state.rts_model_state.model_info.model_id` (model fallback).

## Estimation

`token = string-leaf-chars / 4`, walking only string leaves and **skipping
non-linguistic keys** (`signature`, `redactedContent`, `toolUseId`, `modelId`,
`message_id`, `format`, `id`). Per assistant turn:

- `outputTokens` = assistant `text` + `toolUse` (name/input)
- `reasoningOutputTokens` = `thinking.text` (signature excluded)
- `inputTokens` = user prompt + preceding `ToolResults` (+ ~1600/image)
- `cachedInputTokens` = running conversation context (re-sent every turn) + a
  per-call system-prompt/tool-schema overhead
- `model` = `thinking.modelId` → session `model_id` → `kiro-token-estimate`
- `timestamp` = the enclosing `Prompt`'s timestamp (turns inherit it)

Output is estimated from the assistant **text**, which is more faithful than a
chunk count — `time_between_chunks` is not present in this native format anyway.

### Two "re-sent every turn" terms (reviewer decision points)

1. **Thinking signatures in cache.** Extended-thinking + tool-use requires
   re-sending thinking blocks (incl. their signature) on every later request, so
   the signature is added to the running context (not to output). Counted at
   `chars/4` — a conservative floor (base64 tokenizes worse).
2. **System prompt + tool schemas.** Injected on every request but never written
   to the log, so the stream alone counts none of them. Modeled as a per-turn
   constant `KIRO_CLI_SYSTEM_OVERHEAD_TOKENS` (default **20000**). Set it to `0`
   to count only logged text. **Happy to change/remove this — your call.**

## How the numbers were validated

Two independently-written counters over the same logs:

- **Estimator** — stateful turn walker with selective field extraction.
- **Independent re-count** — single pass summing every string leaf per event kind,
  no turn logic, no cache model, no key-skipping.

Results:

1. The check **caught a real bug**: an early version extracted tool results via
   `JSON.stringify`, counting structural overhead → **6×** inflation (14.8M vs
   2.5M input). Only independent implementations surface that.
2. After the fix, **input reconciles to 99.5%** (2,532,691 vs 2,544,964).
3. The output-side gap was fully explained by a third, separate measurement:
   signatures = ~1.48M tokens — exactly the difference. Not a bug; a deliberate
   exclusion.

Scope: this validates **parsing correctness and consistency**, not the `chars/4`
ratio or that the cache model matches provider billing (Kiro exposes no ground
truth — it meters in Credits / `INVOCATIONS`, which are non-linear in tokens).

## Tests

`test/kiro.test.js` adds:

- `cliEventsToEntries` — in/out/think estimation, **signature excluded from
  output but kept in cache**, structure-not-inflated counting, and prompt-timestamp
  inheritance across multiple assistant turns.
- `parse` — reads a native `~/.kiro/sessions/cli/*.jsonl` fixture end-to-end and
  aggregates buckets.

All existing Kiro tests still pass (the two `parse` tests set
`KIRO_CLI_SESSIONS_DIR` to an empty dir so the new priority-#1 source is inert).
