# vibe-usage

Track your AI coding tool token usage and sync to [VibeCafé](https://vibefriends.com).

## Quick Start

One command, nothing to configure:

```bash
npx @vibe-cafe/vibe-usage
```

On the first run it:
1. Opens [vibefriends.com/usage/device](https://vibefriends.com/usage/device) in your browser — sign in, confirm the code shown in the terminal, click 「确认链接」; the key is saved to `~/.vibe-usage/config.json`
2. Detects the AI coding tools installed on this machine
3. Uploads your usage history
4. Turns on background sync (every 30 minutes, starts at login) — no prompt, nothing else to install

Run the same command again any time to sync right now. To turn background sync off: `npx @vibe-cafe/vibe-usage daemon uninstall`. Add `--no-daemon` to the first run if you don't want the background service at all.

Prefer a menu-bar app? [Vibe Usage for Mac](https://github.com/vibe-cafe/vibe-usage-app) · [for Windows](https://github.com/vibe-cafe/vibe-usage-windows).

### CI / Headless

If you don't have a local browser (CI, remote SSH session, container), pre-issue a key at [vibefriends.com/usage/setup](https://vibefriends.com/usage/setup) and pass it on the command line. Non-interactive runs never install the background service:

```bash
npx @vibe-cafe/vibe-usage init --manual-key vbu_xxxxxxxxxxxx --no-daemon
```

<details>
<summary><strong>All commands</strong> — everything below still works; the older spellings print a hint pointing at the simpler form</summary>

```bash
npx @vibe-cafe/vibe-usage              # Init (first run, browser login, then background sync) or sync (subsequent runs)
npx @vibe-cafe/vibe-usage --no-daemon  # Same, but skip installing the background service on first run
npx @vibe-cafe/vibe-usage init         # Re-run setup via browser login (also how you re-bind to another account)
npx @vibe-cafe/vibe-usage init --manual-key <vbu_...>   # Skip browser, use pre-issued key (CI/headless)
npx @vibe-cafe/vibe-usage sync         # Manual sync
npx @vibe-cafe/vibe-usage sync --extra-codex-home /path/to/.codex  # Add another Codex Home for this run only
npx @vibe-cafe/vibe-usage summary       # Print last 7 days as markdown (cost / tokens / by tool / by model / by project)
npx @vibe-cafe/vibe-usage summary --days N  # Same, over the last N days (1-90)
npx @vibe-cafe/vibe-usage daemon       # Continuous sync (every 30m, foreground)
npx @vibe-cafe/vibe-usage daemon install    # Install background service (systemd/launchd/Task Scheduler)
npx @vibe-cafe/vibe-usage daemon uninstall  # Remove background service
npx @vibe-cafe/vibe-usage daemon status     # Show background service status
npx @vibe-cafe/vibe-usage daemon stop       # Stop background service
npx @vibe-cafe/vibe-usage daemon restart    # Restart background service
npx @vibe-cafe/vibe-usage reset        # Delete all data and re-upload from local logs
npx @vibe-cafe/vibe-usage reset --local  # Delete this host's data only and re-upload (`--host` remains a legacy alias)
npx @vibe-cafe/vibe-usage skill         # Install skill for AI coding assistants
npx @vibe-cafe/vibe-usage skill --remove  # Remove installed skills
npx @vibe-cafe/vibe-usage status       # Config, detected tools, and what each tool has uploaded so far
npx @vibe-cafe/vibe-usage quota discover --json  # Detect subscription-quota products locally
npx @vibe-cafe/vibe-usage quota fetch --product kimi-code --product zcode --product grok --json  # Fetch only selected quotas
npx @vibe-cafe/vibe-usage help --all   # Full help (plain `help` shows the short version)
```

</details>

## Subscription Quotas

The versioned `quota` JSON contract is designed for local desktop clients. `discover` only checks ordinary app, config-directory, and executable presence signals: it does not open credentials or use the network. `fetch` invokes only products explicitly named with `--product`, and one provider failure does not prevent results for the others.

- A quota result may carry a machine-readable `emptyReason` (`limitReached` / `noWindow` / `notEntitled` / `sessionWithoutPlanLimits`) alongside the human `message`; it is additive within schema v1, so clients that do not know it ignore it, and it says *why* there was no window instead of leaving the caller to parse prose. OpenCode Go sets `notEntitled` for a key without the Go subscription.
- **Kimi Code** reads the official OAuth file from `$KIMI_CODE_HOME/credentials/kimi-code.json` (otherwise `~/.kimi-code/credentials/kimi-code.json`) and falls back to the legacy `$KIMI_SHARE_DIR` / `~/.kimi` location — the first login that exists wins. It calls `https://api.kimi.com/coding/v1/usages` and supports both the current 2.x response and the legacy quota response. When the short-lived access token is close to expiry, it uses Kimi's standard OAuth refresh flow and atomically rotates the official credential with owner-only permissions. Refreshes are serialized across Vibe Usage processes and re-check the file before writing so a concurrent Kimi CLI refresh wins safely.
- **ZCode / GLM Coding Plan** accepts only a caller-supplied regional key: `BIGMODEL_API_KEY` calls the domestic `https://open.bigmodel.cn/api/monitor/usage/quota/limit`, while the existing `Z_AI_API_KEY` keeps using `https://api.z.ai/api/monitor/usage/quota/limit`. If both are present, the explicitly named BigModel key wins. It does not read ZCode's private OAuth state.
- **Grok** reads at most the final 2 MiB of the official CLI's ordinary `$GROK_HOME/logs/unified.jsonl` (default `~/.grok/logs/unified.jsonl`). It accepts only the structured `billing: fetched credits config` event and projects the current utilization, period bounds, subscription tier, and event timestamp. It performs no network request, reads no credentials, and never returns or retains other log fields.
- **OpenCode Go** reads only OpenCode's own saved login for it, read-only, from OpenCode's data directory (`$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` on every platform; `VIBE_USAGE_OPENCODE_DIRS` replaces discovery for fixtures/relocated data). In order: OpenCode 2.x's credential table in `opencode.db` (the `opencode-go` key, then the `opencode` integration — an OpenCode account sign-in, which is the only connect option new users get since OpenCode 2.4.0, or a service-account key), then 1.x's `auth.json` (the `opencode-go` entry, then `opencode`), which is read only when the table holds no OpenCode login and 2.x has not imported the file (2.x leaves its imported copy behind); no other provider's credential is inspected, and from the table only the fields the request needs are extracted, never the refresh token. It calls the official `https://opencode.ai/zen/go/v1/usage` endpoint with that key, or with an account sign-in's access token plus the workspace it chose (`x-opencode-org-id`, as OpenCode itself sends it). An OpenCode credential is used only for the default OpenCode Console, and an account sign-in only while its token is valid: the CLI never renews it, so an expired sign-in sends nothing and reports `expired_credentials` until OpenCode next runs and renews it. It reports the three windows OpenCode Go enforces (5-hour rolling, weekly, monthly) as normalized meters. A valid OpenCode login without an active Go subscription (HTTP 403) is a quiet "no data" rather than an error. Nothing is written back to OpenCode, logged, or included in output; only a one-way hash of the key (or, for an account sign-in, of the workspace ID) scopes the disposable cache.
- **Cursor** queries `https://cursor.com/api/usage-summary` with the Cursor sign-in Vibe Usage keeps (`login cursor`, below) when there is one, otherwise with the official app's saved access token. It shows plan/model percentages and billing-cycle reset times; fractional percentages stay in percentage units. It never reads browser cookies or changes Cursor's database, and never renews Cursor's own login. When Cursor's own login is encrypted (Cursor 3.27+) and there is no Vibe Usage sign-in, the result is `unsupported` with `signIn: "required"`; a Vibe Usage sign-in that Cursor ended gives `signIn: "expired"`. Transient failures may use only the same-account, unexpired quota cache.
- **Antigravity / AGY** supports a signed-in `agy` CLI or Antigravity Desktop. Google is asked only after Antigravity was used on this computer — judged from the names, sizes and modification times of the files in its local conversation stores, never their contents; with no conversation at all nothing is asked — at most once every 5 minutes, and after a failed read only after 5, 10, 20, 40, then 60 minutes. Otherwise the last reading is returned from `~/.vibe-usage/antigravity-quota.json` (moved by `VIBE_USAGE_QUOTA_CACHE_DIR`; no token, account or conversation data): a window whose reset has passed is shown as 0% used if Antigravity sat unused since, and left out until the next read if it was used. A sign-in failure discards the reading. A read has 20 seconds including cleanup and tries, in order: the official `agy -p /usage --output-format json` (only on a confirmed 1.1.11 or newer, since older versions can bill it as a prompt; the version check is remembered per binary); a running Antigravity Desktop's own language server, found in the local process and socket tables and called on `127.0.0.1` with that process's own CSRF token; and only then a temporary instance of the installed desktop engine, started under the desktop's real version (macOS `Info.plist`, Windows `resources/app/package.json` or `app.asar`) and not at all when that version cannot be read. The `agy` processes Vibe starts get `AGY_CLI_DISABLE_AUTO_UPDATE=true` and do-nothing `open` / `xdg-open` / `rundll32` / `BROWSER` launchers first on `PATH`, so a failed silent sign-in that goes through them cannot open a browser tab (verified for macOS by others with agy 1.3.3; unverified on Windows); after `agy` asks for sign-in or hangs in `/usage`, it is skipped until its own conversation store changes or the binary changes. The card shows the Gemini family’s 5-hour and weekly windows, or the first family with known quota when Gemini is absent. Requests to the local servers go directly to `127.0.0.1`, including behind a proxy. Vibe never reads or refreshes Antigravity's sign-in and closes every process it starts. Google says reading quota from third-party apps is not supported.
  Vibe looks for the CLI in `~/.local/bin`, on PATH, in `/opt/homebrew/bin` and `/usr/local/bin` on macOS, and in `%LOCALAPPDATA%\agy\bin` on Windows. `ANTIGRAVITY_CLI_PATH` selects an absolute CLI path. For desktop-only installs it checks `/Applications` and `~/Applications` on macOS and `%LOCALAPPDATA%\Programs\antigravity` on Windows.

```bash
npx @vibe-cafe/vibe-usage quota fetch --product cursor --product antigravity --json
```

These are local quota integrations, separate from token-history uploads. Discovery still performs no credential reads or network calls. Both upstream protocols can change; incompatible responses surface a retry/login error rather than a fabricated zero. Publish the CLI adapters before desktop builds that enable these products; schema v1 and existing config/state stay compatible, and rollback removes the two quota registrations without changing historical uploads.

Quota results are never uploaded or added to incremental sync state. Credential-backed providers may use the disposable cache at `~/.vibe-usage/quota-cache.json`; it contains normalized meters only, is scoped to a one-way hash of the active credential, rejects expired windows, and has a seven-day hard expiry. Grok's local-log result is not cached. No credential is stored in that cache, logs, or command output; the only credential write is Kimi's standard token rotation back to Kimi's own credential file.

## Supported Tools

| Tool | Data Location |
|------|---------------|
| Alma | Electron app-data `alma/chat_threads.db` (macOS: `~/Library/Application Support/alma/chat_threads.db`; fixture/relocation override: `VIBE_USAGE_ALMA_DB`). Reads the `usage_records` ledger plus workspace names without selecting chat bodies, message metadata, provider credentials, or full workspace paths. Provider-prefixed model identifiers are normalized to their final model segment. Cache writes are included in input usage. The ledger contains assistant responses only, so Alma emits token buckets without session timing. |
| Claude Code + Claude Desktop Code/Cowork | Claude Code data in `~/.claude/projects/` (tokens + sessions) and `~/.claude/transcripts/` (sessions only), plus Claude Desktop Cowork's per-session `.claude/projects/` directories. Also scans `$CLAUDE_CONFIG_DIR` and data-bearing `~/.claude-*` profiles. All variants use the existing `claude-code` source; the parser selects the most complete copy of each session so shared/copied transcripts are not counted twice. Logs are streamed, unchanged project transcripts are served from a local summary cache, and cache creation tokens are included in input usage. |
| Cindy | Per-owner SQLite ledgers in the two regional Electron user-data roots: macOS `~/Library/Application Support/{CindyGlobal,Cindy}/cindy-*.db`, Windows `%APPDATA%\{CindyGlobal,Cindy}\cindy-*.db`, Linux `${XDG_CONFIG_HOME:-~/.config}/{CindyGlobal,Cindy}/cindy-*.db` (fixture/relocation override: `VIBE_USAGE_CINDY_DIRS`). Cindy-launched Claude Code already writes ordinary `~/.claude` transcripts, so it remains attributed to **Claude Code** and is not read again. Cindy's otherwise-private Codex and Pi daily/model ledger rows augment the existing **Codex** and **pi** sources. Currency rows are summed and cache creation joins input; chat messages, credentials, costs, and owner ids are never selected. The ledger adds token buckets only, without project or session timing. |
| CodeArts Agent (CodeArts Doer for Coding) | The embedded agent kernel's WAL SQLite store at `~/.codeartsdoer/codearts-data/opencode.db` (fixture/relocation override: `VIBE_USAGE_CODEARTS_AGENT_DIRS`, whose entries may be the database, `codearts-data`, or its `.codeartsdoer` parent). Reads only allow-listed identity/timing/model/project/token fields from `message` joined to `session`; prompt text, tool payloads, errors, costs, credentials and account/quota data are never selected. Input, output, cache reads and reasoning are separate counters; an untyped cache write is priced as the cheaper 5m cache-creation bucket rather than folded into input, since the store gives no per-TTL breakdown to price it more precisely. Child-agent calls keep contributing token usage, while their injected user messages fold into the top-level logical session instead of inflating human prompt/session counts. Copied stores deduplicate by session + message id, and lock/read failures use a disposable WAL snapshot or preserve prior incremental state. |
| Codex CLI | `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/` (default `~/.codex`), plus an optional temporary `--extra-codex-home`, legacy `codexExtraHome`, or explicitly added Codex/Multica roots; conversations Codex Desktop compressed after 7 days (`.jsonl.zst`) are read too, which needs Node 22.15 or later (the desktop apps bundle it); a versioned local index avoids re-reading unchanged rollouts and reads only safe append tails for ordinary sessions, same-session continuation files are combined without counting exact live/archive/cross-root copies twice, and fork/sub-agent replay remains excluded |
| Cola | `~/.cola/sessions/<scope>/*.jsonl` (or `$COLA_DATA_DIR/sessions/`), verified with Cola 1.4.4. Reads assistant token usage and session timing through the shared Pi reader; cache writes join input, cache reads remain separate, and reasoning is split from output. Copied transcripts with new session headers are deduplicated using the original record metadata and attributed to the earliest available session copy. Project names come from `cwd`, never channel/scope names. |
| Grok | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/` (default `~/.grok`) plus explicitly added Grok Homes; token usage from `updates.jsonl` `turn_completed.usage` (per-model `modelUsage`, cache reads, reasoning); project from `summary.json` cwd; copied sessions keep the more complete local record |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` |
| CraftAgent | `~/.craft-agent/workspaces/*/sessions/*/.pi-sessions/*.jsonl`; honors `$CRAFT_AGENT_DIR` / `$CRAFTAGENT_DIR`; cache writes are included in input usage |
| Cursor | the Cursor sign-in Vibe Usage keeps (`login cursor`), else `state.vscdb` (SQLite; reads only the token Cursor itself already stored locally, never refreshes it), plus `cursor.com`'s usage CSV, with the dashboard's paginated usage-events API as fallback when the CSV is empty or changes shape; cloud data is stamped with a fixed `cursor-cloud` hostname so multi-machine setups don't double-count; `status` shows the signed-in account and newest event |
| DimAgent | Legacy TypeScript store `$DIMCODE_HOME/dimcode.sqlite` (default `~/.dimcode/v2/dimcode.sqlite`): exact usage from `usage_ledger`, with forked ledger/history copies deduplicated. Rust Dim (`dima` alpha and later): `<home>/rust/dimcode.sqlite` for `$DIMCODE_HOME`, `~/.dimcode-alpha`, `~/.dimcode` and `~/.dim`, all merged into the same source — per-request `model/usage` events plus compaction summarizer usage, fork copies counted once; an unreadable store warns while the others still sync |
| Gemini CLI | `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl` (current line-delimited format) and legacy `session-*.json`; recurses into nested subagent sessions |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) — both the legacy `message` table and the 2.x `session_message` projection are read, merged by message id — with `storage/message/` as the legacy alternative; cache writes are counted as 5m cache creation; supports explicitly added data roots |
| OpenClaw | `~/.openclaw/agents/`, `~/.openclaw-<profile>/agents/` (profile deployments); cache-creation/cache-write tokens are included in input usage |
| Oh My Pi | `~/.omp/agent/sessions/`, `~/.omp/profiles/*/agent/sessions/`, and `$XDG_DATA_HOME/omp/{sessions,profiles/*/sessions}`; recognizes OMP's `$PI_CODING_AGENT_DIR`, current v3 title slots and path/hashed session directories, deduplicates copied records, includes cache writes in input, and splits reasoning from OMP's inclusive output count |
| pi | `~/.pi/agent/sessions/` or `$PI_CODING_AGENT_DIR/sessions/`, plus the session directory Pi itself was pointed at via `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in `~/.pi/agent/settings.json`, plus explicitly added `pi-coding-agent` roots for stores only reachable through `pi --session <file>` (fixture/relocation override: `VIBE_USAGE_PI_SESSION_DIRS`). Cache writes are included in input usage; reasoning is read from Pi's `usage.reasoning` (legacy `usage.reasoningTokens` still accepted) and split out of the inclusive output total |
| Qwen Code | `~/.qwen/tmp/` |
| Kiki | `$KIKI_HOME/sessions/` (default `~/.kiki/sessions/`; fixture override: `VIBE_USAGE_KIKI_DIR` sets the home). Reports **`kiki` / Kiki**, independently of Kimi Code, using the shared per-agent `usage.record` reader. Main/subagent deltas, retries and compaction are counted; cache creation joins input because no TTL is recorded, while cache reads stay separate. Exact copied records for the same session/agent count once, without collapsing repeated calls inside a wire. Known routing prefixes in `KIKI_MODEL_PREFIXES` are removed; other slash-bearing model ids are preserved. No estimated cache ratios or source-data rewrites. |
| Kilo (CLI / Desktop) | Shared Kilo server SQLite store at `$XDG_DATA_HOME/kilo/kilo.db` (default `~/.local/share/kilo/kilo.db` on macOS/Linux/Windows); honors `$KILO_DB` (absolute, or relative to the Kilo data root). Reads only allow-listed token/model/project/timing fields. Per-step `step-finish` usage takes precedence over assistant-message totals, including the actual model chosen by Auto; concrete provider/model ids are preserved. Cache reads and reasoning remain separate; cache writes use the 5m category. Shared/copy/fork history counts once when the local metadata proves a replay; missing originals retain the sole visible history. Child calls contribute usage without inflating human prompts. Fixture override: `VIBE_USAGE_KILO_DIRS` (path-delimited directories or database files) is for tests only and the background service does not keep it; to read a store elsewhere, set `KILO_DB`. |
| Kimi Code | Current `<home>/sessions/wd_<slug>_<hash>/session_<id>/agents/<agent>/wire.jsonl` (`usage.record` deltas, including retry/compaction scope and cache creation; main/subagent wires form one session), with project names from `session_index.jsonl`. Every home with that layout is scanned: the CLI home (`$KIMI_CODE_HOME`, else `~/.kimi-code`) plus the Kimi Work desktop app's embedded runtime home (`<Electron userData>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home`), which the app never writes into the CLI home; legacy `~/.kimi/sessions/` is parsed alongside (`kimi migrate` never carries usage over, so both stores are always merged) |
| MiniMax Code (mcode) | `$MCODE_HOME/v2/sqlite/runtime-state.sqlite` (default `~/.minimax/v2/sqlite/runtime-state.sqlite`; also reads the roots the CLI relocates to — `$MINIMAX_DATA_DIR` / `$MAVIS_DATA_DIR`, each `~/.minimax-<profile>`, the pre-npm `~/.minimax-code` user-data dir and the pre-rename `~/.mavis` home — and merges them, dropping rows a store only holds as a copy; fixture override: `VIBE_USAGE_MCODE_DB`). Reads only allow-listed token ledger fields and session workspace/project paths, uses basename-only projects, folds cache writes into input, keeps cache reads and reasoning separate, and never selects raw/message JSON payloads. WAL/lock reads use a disposable snapshot; malformed or incompatible databases are skipped to preserve incremental state (a broken extra store is reported as a warning instead of blanking the live one). |
| MiMoCode | `$MIMOCODE_HOME/data/mimocode.db`, `$XDG_DATA_HOME/mimocode/mimocode.db`, or `~/.local/share/mimocode/mimocode.db` (SQLite; exact input, output, reasoning, and cache-read tokens from assistant messages; honors `MIMOCODE_DB`; cache-write tokens are included in input usage) |
| Amp | `~/.local/share/amp/threads/`; cache-creation tokens are included in input usage |
| Droid | `~/.factory/sessions/` |
| DeepSeek Harness | `$DSH_HOME/sessions/` (default `~/.dsh`, fixture/relocation override: `VIBE_USAGE_DSH_SESSIONS`). Reads V0–V4 logs, including `session.v4.jsonl.zstd` from DSH's V4 integration format, with multi-frame Zstandard support (Node ≥ 22.15 built-in, `zstd` CLI fallback) and plain JSONL support. Each session uses its highest `session[.vN].jsonl[.zstd]` generation once, so frozen pre-migration logs are not double-counted. Usage comes from `assistant/message`: cache writes join uncached input, cache reads remain separate, and reasoning is split out of inclusive output. Fork history uses V0/V1 `seedLength` or V2–V4's last `session/end-seed` tagged `inherited: true`, and is skipped only when the parent copy confirms it; missing parents retain the sole local history. Unknown versions warn and protect sync state. |
| Hermes (CLI / Desktop) | `<home>/state.db` + `<home>/profiles/<name>/state.db` (SQLite, multi-profile). Home: `$HERMES_HOME`, otherwise `~/.hermes` on macOS/Linux or `%LOCALAPPDATA%\hermes` on Windows (falls back to an existing `~/.hermes` only when the Windows native root is absent). Additional homes: `config add-root hermes <path>` (a directory containing `state.db` or `profiles/*/state.db`), scanned alongside the default and deduped. Cache writes join input; reasoning is separated from inclusive output. Usage is currently a cumulative session total attributed to session start: a session spanning several days does **not** yet provide an accurate daily breakdown. |
| Kiro | Kiro CLI native event streams `~/.kiro/sessions/cli/*.jsonl` (estimated tokens from message text: input = prompt + tool results, output = reply + tool calls, reasoning = thinking, cacheRead = re-sent context; thinking-block signatures excluded). Falls back to `~/Library/Application Support/kiro-cli/data.sqlite3` / `~/.local/share/kiro-cli/data.sqlite3` + optional `~/.kiro_sessions/*.json` archives, then IDE `q-client.log` whole-credit deltas as `kiro-credits` (floored cumulative diff — the server stores token counts as bigint); legacy IDE `dev_data/devdata.sqlite` token telemetry is opt-in with `VIBE_USAGE_KIRO_LEGACY_TOKENS=1` |
| Cline (CLI / SDK / Desktop app) | All variants write the same `~/.cline/data/sessions/*/*.messages.json` per-call metrics (the desktop app's manifest says `source: "desktop"`; its Electron userData holds only WebView caches), plus legacy `~/.cline/{,data/}state/taskHistory.json` and editor extension stores. Honors `CLINE_DIR`, `CLINE_DATA_DIR`, and `CLINE_SESSION_DATA_DIR`; copied history is deduplicated |
| Roo Code | `<host>/User/globalStorage/rooveterinaryinc.roo-cline/{tasks/_index.json,tasks/<id>/{history_item,ui_messages}.json}` (walks all VSCode-fork hosts) |
| Trae CLI | macOS: `~/Library/Caches/trae-cli/sessions/`; Windows: `%LOCALAPPDATA%/trae-cli/cache/sessions/`; Linux: `~/.cache/trae-cli/sessions/` (CLI telemetry only; Trae IDE/Trae Work chats are not supported). Token usage is summed per unique LLM call (`model.stream.eino`, plus `model.generate` failovers); nested duplicate spans that share a session `traceID` are not max-merged. `traces.jsonl` / `events.jsonl` are streamed line-by-line so a multi-hundred-MB events file cannot hit Node's string-length limit. |
| Antigravity | Scans App 2.0 `~/.gemini/antigravity/conversations/`, `agy` CLI `~/.gemini/antigravity-cli/conversations/`, and standalone IDE `~/.gemini/antigravity-ide/conversations/`. `.db` stores, including the same paths below explicitly added alternate Homes, are parsed offline (tokens, model, project, sessions). Usage is read from `gen_metadata` and from `steps.metadata` (newer builds keep the live usage on the step instead); the two are merged by response/message identity, keeping the richest payload so a call both tables saw is counted once. Output is the store's total (thinking is billed once as reasoning, not twice), and cache writes land in the 5m column. When Gemini blobs omit `chatStartMetadata.createdAt` or `modelDisplayName`, timestamps fall back to the step's own clock or the `steps.idx` join and model names to `responseModel`/step model info. `.pb` history in the default stores requires the corresponding App/IDE language server to be running; when several servers are open, the parser tries the others for unreadable conversations. Unavailable legacy history produces a warning and preserves prior sync state. |
| WorkBuddy | Current releases: `~/.workbuddy-ai/projects/**/*.jsonl`; legacy releases: `~/.workbuddy/projects/**/*.jsonl` (fixture/relocation override: `VIBE_USAGE_WORKBUDDY_DIRS`). Reads usage-bearing completed assistant and `function_call` records, using the routed model identifier exposed as `providerData.requestModelId`. Splits cache reads and reasoning from inclusive input/output totals, deduplicates copied record IDs, and extracts local session timing without uploading message content. |
| CodeBuddy | Tencent's CodeBuddy Code CLI (`@tencent-ai/codebuddy-code`). Home is `$CODEBUDDY_CONFIG_DIR` or `~/.codebuddy` (fixture/relocation override: `VIBE_USAGE_CODEBUDDY_DIRS`); transcripts at `projects/<compressed-cwd>/<sessionId>.jsonl`, including nested subagent directories. Only the API-message records' `message.usage` is read: `input_tokens` + `cache_creation_input_tokens` fold into input (the store writes no per-TTL breakdown), `cache_read_input_tokens` stays separate, `output_tokens` is the full completion. Retries and copies dedupe onto one logical call using `message.id`, `providerData.messageId`, or the record id (the CLI leaves `message.id` empty on some builds; `conversationRequestId` is a turn id, never a dedup key). The model comes from `message.model` and falls back to `providerData.requestModelId`/`model`, because successful calls can write `message.model: null`; routing-tier labels are namespaced (`codebuddy-auto`) so they can never match another vendor's price. Prompt text, thinking signatures, and tool payloads are never read. |
| ZCode | `~/.zcode/cli/db/db.sqlite` (SQLite; reads the `message` table for per-message tokens, model, and project `cwd`/`root`, joined to `session.directory`; fixture/relocation override: `VIBE_USAGE_ZCODE_DB`) |
| Qoder | International edition (qoder.com). IDE store `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` (Windows `%APPDATA%\Qoder`, Linux `~/.config/Qoder`; honors `QODER_HOME`, fixture override `VIBE_USAGE_QODER_DB`) gives real tokens from `chat_message.token_info` (prompt includes cached; split out) with `model_key` usually a routing tier, reported as `qoder-auto` / `qoder-ultimate` / … so it never collides with a priced model id; message content is never selected, and lock/schema failures fall back to a snapshot or `skipped`. CLI + desktop app transcripts `~/.qoder/projects/**/*.jsonl` (honors `QODER_CONFIG_DIR`, fixture override `VIBE_USAGE_QODER_PROJECTS`; sub-agents under `<session>/subagents/`) are credit-billed with every token field at 0, so they contribute sessions only — credits are account funding and are not collected |
| Qoder CN | China edition (qoder.com.cn, separate account). Same two shapes under `~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db` (`QODER_CN_HOME` / `VIBE_USAGE_QODER_CN_DB`) and `~/.qoder-cn/projects/` (`QODERCN_CONFIG_DIR` / `VIBE_USAGE_QODER_CN_PROJECTS`); reported as source `qoder-cn` |
| Devin | `$XDG_DATA_HOME/devin/cli/sessions.db` (default `~/.local/share/devin/cli/sessions.db`; fixture override `VIBE_USAGE_DEVIN_DB`). Devin CLI and Devin Desktop share this one WAL store. Reads only allow-listed fields from `message_nodes.chat_message` via `json_extract` — per-request `metadata.metrics` token counters on assistant messages, `generation_model`, `is_user_input`, timestamps — joined to `sessions.working_directory`/`model`; message content and the session credit/ACU billing fields are never selected. Cache writes fold into input, cache reads stay separate. The node forest stores some logical messages at several nodes, so rows are deduplicated by session + message id. Synthetic user records (cache keepalives) are not counted as human prompts |

### Kiki setup and compatibility-collector migration

For a relocated Kiki home, set `KIKI_HOME` before installing the background service; reinstall an existing service to capture a changed home. A home already collected by Kimi Code is not collected again as Kiki. Server deployment must register `kiki` with display name **Kiki** before this support is published; an unregistered source is reported in `dropped.unknownSources`, not retried under `kimi-code`. This collects token usage, not a Kiki subscription balance.

If you used a compatibility collector that uploaded Kiki as `kimi-code`, **keep its `state.json`, hostname and project-upload setting**. On the first independent Kiki upload, matching legacy bucket/session keys pause Kiki only; other tools continue and overlapping old Kimi buckets are not overwritten with smaller Kimi-only totals. The legacy match recognises both the CLI's own bucket coordinates and the published collector's identity: Kiki's `kap-server` export (`vibe-kimi-bucket-v1`) uploaded source `kimi-code` with `project: 'unknown'` and `hostname: kiki-<stream_id>`, which never equals the session project and machine hostname this CLI writes, so a row with the same model and half-hour window but a different project/hostname and a different recorded hash also triggers the guard. An unchanged Kimi-only bucket does not trigger it. An unrelated Kimi history does not trigger it. Missing state or changed identity cannot prove whether cloud history overlaps; resolve that with the maintainer before importing history.

Choose an explicit UTC half-hour cut **T** with no compatibility uploads at or after T. Finish and verify the old collector's coverage below T, stop that collector, then configure the new CLI before its first sync:

```bash
npx @vibe-cafe/vibe-usage config set kikiStartAt 2026-10-05T12:30:00Z  # replace with your verified cut
```

A cut (or the guard) withholds real Kiki history and freezes the overlapping old `kimi-code` rows, so those server cells stop following local growth. `sync` reports this on stderr even in quiet/daemon runs: the withheld bucket/session counts and time range, the frozen row counts, and both remedies. If the cut overlaps recorded legacy buckets, Kiki stays paused; set a later verified cut. Kiki tokens at/after T are sent as `kiki`; old mixed buckets below T remain untouched under `kimi-code`. Sessions starting before T retain their old timing identity, even if their later tokens are in new Kiki buckets.

Once independent Kiki uploads are recorded, the cut cannot be changed to a *different* time by `config set`. It can always be cleared with:

```bash
npx @vibe-cafe/vibe-usage config set kikiStartAt none  # only if you are certain no compatibility collector ever ran
```

`none` deletes the cut and re-admits the previously withheld pre-cut Kiki history under `kiki`; if a legacy collector had in fact run, that history double counts, so only use it when you know it never did. Do not run both collectors for the same interval, delete state to bypass the check, or use a whole-account reset as a migration shortcut.

To relabel old history, the maintainer needs the old bucket keys, raw per-tool token contributions, the cut and the target account/device. A hash of a mixed Kimi/Kiki bucket cannot be split client-side. This CLI neither deletes cloud rows nor copies that history into a second source.

## How It Works

- Parses local session logs from each AI coding tool
- Aggregates token usage into 30-minute buckets
- Extracts session metadata where the source safely exposes user/assistant timing: active time (AI generation time, excluding queue/TTFT wait), total duration, and message counts. Alma intentionally emits buckets only; Cindy's daily-ledger augmentation adds no timing data to the native Codex/pi sessions because doing so would require reading Cindy chat records.
- Uploads buckets + sessions to your VibeCafé dashboard (always gzip-compressed, ~94% smaller)
- Incremental upload: every parser emits a complete local snapshot, then only buckets/sessions that are new or changed since the last successful upload are sent — a quiet machine uploads nothing. Upload state remains in `~/.vibe-usage/state.json`; failed or still-indexing parsers retain their prior state, while deleted local logs are pruned. Deleting the state file triggers a one-time full re-upload, and `reset` clears it automatically after deleting cloud data
- Incremental Codex parsing: a versioned, disposable cache under `~/.vibe-usage/cache/codex/` stores per-rollout aggregate results and parser continuation state. Unchanged rollouts require no raw-log reads; an ordinary append reads only the new tail; forks, sub-agents, replacements, truncations, and failed safety checks fall back to the full correctness path. Multi-file sessions have a combined cache that rebuilds when any segment changes. A bounded rolling audit occasionally re-reads one historical file or continuation group. Very large first-time indexes checkpoint before the Mac app timeout and resume on the next sync instead of restarting
- Interactive `sync` shows a live status line (`正在读取上传设置` → `正在扫描本地日志 12/35 · 已用时 2m10s`) while it reads backend settings and scans/indexes local logs. A first sync, a cold Codex index rebuild, or a Cursor account with a long event history can take minutes, so that line is what separates a slow sync from a hung one. It is printed only on a TTY — the Mac and Windows apps read the piped stdout as the result text and must keep receiving plain output. Interrupting a sync is safe: finished batches are already committed, and the Codex index checkpoints and resumes on the next run
- The Codex parser cache contains derived aggregates and replay metadata, not raw prompt or response text. It is independent of upload state and can be deleted safely (the next sync rebuilds it). `reset` intentionally keeps it so the required full re-upload does not also require a full disk rescan. Set `VIBE_USAGE_CODEX_CACHE=0` to disable the optimization for diagnosis
- Incremental Claude Code parsing works the same way: `~/.vibe-usage/cache/claude-code/` holds one summary per project transcript (per-call token counts, model, timing, call/request ids, and the byte offset already read), never prompt or response text. An unchanged transcript is not opened, an appended one is read from its last complete line, and a first build checkpoints before the Mac app timeout. Entries of deleted transcripts are removed; the cache can be deleted safely, `reset` keeps it, and `VIBE_USAGE_CLAUDE_CACHE=0` disables it
- Local sync history: `~/.vibe-usage/sync-history.json` keeps the last 10 syncs (who started each one, CLI and runtime version, result, duration, upload counts, and per tool the parsed counts plus fixed warning codes such as `read_failed` or `cursor_token_encrypted`). It holds no paths, directory or project names, warning text, server responses or keys, is written with file mode 0600 on macOS and Linux (an existing `~/.vibe-usage` directory keeps its permissions; on Windows the file inherits your user folder's permissions), is never uploaded, and can be deleted at any time without affecting sync. Terminal and daemon-log warnings are unchanged
- SQLite-backed tools are read via Node's built-in `node:sqlite` on Node ≥ 22.5 — no `sqlite3` binary needed (works on Windows out of the box); on older Node the CLI falls back to the system `sqlite3` executable
- Continuous syncing is on by default: the first run installs a background service (see [Background sync](#background-sync)); the [Vibe Usage Mac app](https://github.com/vibe-cafe/vibe-usage-app) is the menu-bar alternative

## Diagnostics

When something looks wrong (a tool shows no data, syncs time out, the key seems rejected), run:

```bash
npx @vibe-cafe/vibe-usage@latest doctor
```

It prints a short plain-text report you can paste into a chat: system and CLI version, the runtime running it and which SQLite implementation is in use, whether a key is configured and still matches the upload state, a 4-character device tag, whether the server and the npm registry are reachable, the background service, the last 10 syncs (who started each, result, duration, upload counts, failure category), and for every detected or failing tool the last sync's counts plus fixed warning codes such as `read_failed` or `cursor_token_encrypted`. It contains no API key, tokens, conversation content, project names, directory names or hostname. `doctor` only reads local files and makes two unauthenticated connectivity requests; it never reads quotas or tool credentials, writes files or uploads anything. `doctor --json` prints the same data as versioned JSON for the desktop apps ([field reference](docs/doctor-json.md)).

## Cursor 单独登录

新版 Cursor 把本机登录加密保存后，Vibe Usage 读不到它（也不解密它）。这时可以让 Vibe Usage 单独登录一次 Cursor：

```bash
npx @vibe-cafe/vibe-usage login cursor    # 浏览器打开 cursor.com 的确认页，点确认即可
npx @vibe-cafe/vibe-usage logout cursor   # 删除本机保存的这份登录
```

- **以 Cursor 命令行的身份登录，只用来读用量。** 登录走的是 Cursor 给自家命令行准备的浏览器登录（`cursor.com/loginDeepControl`，`redirectTarget=cli`），续期用 Cursor 客户端的公开编号。Cursor 没有开放第三方读取用量的接口，这种用法不在 Cursor 官方支持范围内；Cursor 的使用政策不鼓励自动化访问，目前没有见过因此封号的情况。随时可以退出，并在 cursor.com 设置里的 Active Sessions 撤销这条登录。
- **存在哪：** 只用命令行时存在 `~/.vibe-usage/cursor-login.json`（只有本人能读写，0600）；桌面 App 存在自己的钥匙串 / 凭据管理器里，每次运行时通过标准输入交给 CLI，CLI 不写文件。不上传、不写日志，不碰 Cursor 自己存的任何东西。
- **联网：** 登录时每 2 秒查一次确认结果（`api2.cursor.sh/auth/poll`，最多 5 分钟），确认后读一次账号邮箱（`cursor.com/api/auth/me`，只用来显示是哪个账号）；登录约 60 天有效，到期前 7 天续期一次（`api2.cursor.sh/oauth/token`），续期暂时失败时 6 小时后再试；读用量和额度的请求和以前一样。全部按代理设置走（见下面「代理」），照不了就不发。Cursor 不做出口检测。
- **两份都有时：** 在 Vibe Usage 里的登录优先；没有被加密的 Cursor 用户不用登录，照旧读取 Cursor 本机的登录。同一个账号从一种换到另一种不算换账号，不会重新上传。桌面 App 用自己的 Cursor 登录同步时，终端或后台服务如果读到的是另一个账号，会跳过 Cursor（以 App 为准），避免两个账号的用量写进同一条记录；App 7 天没同步后恢复。
- **系统代理：** CLI 只认代理环境变量。电脑设了系统代理（或 PAC）、终端里却没设代理变量时，`login cursor` 和用这份登录的同步不会发请求（否则会直连），请先 `export HTTPS_PROXY=…`；后台服务没有代理变量，这种机器上它会跳过 Cursor。桌面 App 会自己把系统代理传给 CLI，不受影响。
- `status` 会显示保存的登录是哪个账号、有效期到哪天（不显示凭据本身）。

## Cursor 网络排查

Cursor 用量优先读取 `cursor.com` 的 CSV 导出（模型名最准确）。如果 CSV 为空、表头变化或没有 token 计数，会自动改用仪表盘自己的分页用量事件接口（`/api/dashboard/get-filtered-usage-events`）；该接口较早事件的模型名可能显示为 `default`，但 token 总量正确。CSV 仍可用但最新事件已超过 24 小时（且不超过 7 天）时，会只向事件接口补“CSV 最新事件之后”的增量，不覆盖或重传历史。`Cursor usage export skipped (network: …)` / `Cursor usage request skipped (network: …)` 表示这次请求失败；CLI 会保留 Cursor 的历史同步状态，下次同步重新尝试。

- `ENOTFOUND` / `EAI_AGAIN`：检查 DNS 和终端网络。
- `UND_ERR_CONNECT_TIMEOUT` / `ETIMEDOUT` / `ECONNRESET`：检查到 Cursor 的连接及终端代理。浏览器或 Cursor 应用能联网，不代表 Node.js 使用了相同代理。
- `CERT_*` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 等：检查系统时间和代理或公司网络的 CA 证书配置；自定义 CA 可通过 `NODE_EXTRA_CA_CERTS` 指定。
- `timeout after …ms`：请求超时（每页默认 120 秒）。可用 `VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS=300000` 调大，然后重跑一次 `sync` 补传历史。
- `Cursor session rejected`：在 Cursor 的 Account 设置中重新登录，再同步。
- `新版 Cursor 已加密保存登录凭证`：Cursor 3.27 起会分批把本地登录凭证改为加密保存（`cursor-safe-storage:` 开头），Vibe Usage 不解密它。运行 `npx @vibe-cafe/vibe-usage login cursor`（或在 App 设置里登录 Cursor）单独登录一次即可恢复，暂停期间的用量会在之后的同步里自动补回（前提是 cursor.com 还保留记录）；在 Cursor 里重新登录不能解决（[#144](https://github.com/vibe-cafe/vibe-usage/issues/144)）。
- `Cursor 登录已失效`：在 Vibe Usage 里登录的那一份被 Cursor 结束了（比如在 cursor.com 撤销了这条登录），重新运行 `login cursor` 即可。
- 数据停在某一天、或刚换过 Cursor 账号：运行 `npx @vibe-cafe/vibe-usage status`。它会显示 Cursor 当前登录账号（本地脱敏标签）和最新事件时间；如果最新事件超过 48 小时且你最近用过 Cursor，通常是客户端仍登录旧账号。切换账号后 Cursor 的本地 `state.vscdb` 会更新，重新同步即可。如果这时本机 Cursor 凭证已是加密格式，`status` 改为显示上一条的加密说明，不再提示核对账号。
- X 订阅（The X Subscription）账号的用量由 Cursor 与 Grok 共享：如果 Cursor 仪表盘本身没有新事件，请到 `grok.com/dashboard` 的 Usage 查看；CLI 只能读取 Cursor 仪表盘返回的 Cursor 事件。
- 只有 X Premium+ / Grok 订阅、但 Cursor 里显示 `Free`：X Premium+ 不会自动把 Cursor 计划升级，需要在 `cursor.com/unify` 合并到 The X Subscription 后，Cursor 用量才进入共享池。`cursor.com/api/dashboard/get-sand-usage-status` 返回 `includedUsageSuperGrokPlan: "x-premium-plus"` 且 `cursorPlanName: "Free"` 就是这种状态。

**代理**：环境变量里设了代理时，CLI 的请求都照着走，包括同步到我们服务器的请求（例外见本段末尾）。读法和 curl 一致：每种协议先看自己的变量（`HTTPS_PROXY` / `HTTP_PROXY`，大小写均可），再看 `ALL_PROXY`；只设 `HTTP_PROXY` 时 https 也走它（兼容做法，Node 的 fetch 本来如此）；没写协议头的地址（`127.0.0.1:7890`）按 `http://` 处理；`NO_PROXY` / `no_proxy` 按 Node 的规矩小写优先；本机回环地址不走代理。Node.js 能自己照着走时（24.14+ 自动启用；22.21+ / 24.5+ 设了 `NODE_USE_ENV_PROXY=1` 并写成完整的 `HTTPS_PROXY`，见 [Node.js 官方说明](https://nodejs.org/en/learn/http/enterprise-network-configuration)）就交给它；照不了时——代理是 SOCKS5，Node.js 版本较旧，或代理只写在 `ALL_PROXY` 里——CLI 用自带的隧道（HTTP CONNECT / SOCKS5，支持用户名密码）照样走代理。走 SOCKS5 时只把主机名交给代理，不在本机解析厂商域名；代理连得上、但 15 秒内建不起隧道（比如代理的出口断了）时，请求失败，不会卡住；跳转到别的网站时不带上原来的登录凭据。开了 `NODE_USE_ENV_PROXY=1` 时请把代理写成带协议头的完整地址：Node.js 24 在 CLI 启动之前就会拒绝没写协议头的地址，也会拒绝写在 `HTTPS_PROXY` 里的 `socks5h://`（这种情况请把 SOCKS 地址写在 `ALL_PROXY` 里，CLI 的隧道会接手）。只有 SOCKS4 这类无法识别的代理，或在 Bun 下运行且代理不是完整的 `HTTPS_PROXY=http://…` 时，CLI **不会让带厂商账号的请求改走直连**：Cursor 同步和 Kimi / ZCode / OpenCode Go / Cursor 配额会跳过并说明原因，其他工具照常同步（要访问的地址都写在 `NO_PROXY` 里的，按你的直连规则照常读取；这里从严理解：`example.com` 只算它本身，子域名要写 `.example.com`，带端口的只算那个端口）；这两种情况下，同步到我们服务器的请求和 `doctor` 的连通探测仍按运行环境原样发出，可能直连（不带厂商账号）。以下为 macOS/Linux 终端示例，代理地址须替换为实际地址：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npx @vibe-cafe/vibe-usage sync
```

这些环境变量只影响当前命令；已经运行的桌面应用和后台服务有各自的进程环境（后台服务目前不带代理变量）。持续失败时，请提供完整的 Cursor 报错、操作系统、`node -v` 和 CLI 版本，以便区分具体原因。

**出口检测**：读 Antigravity 的额度要用你的 Google 登录。没检测到代理时（环境变量里没有代理，或 Google 的地址写在 `NO_PROXY` 里；TUN、路由器上的代理这类本机看不到的情况也算），CLI 先用同一条线路、不带任何账号、Cookie 和令牌，访问一次 `https://chatgpt.com/cdn-cgi/trace`，只读其中的国家代码。Google 的地址没有这个页面，所以用 `chatgpt.com` 代替；它要走代理而 Google 直连时改用 `api.anthropic.com`，两个都走代理就算无法确认。出口在中国大陆、香港、澳门，或者确认不了，就不启动 `agy`、不请求 Antigravity 桌面版，额度结果是 `unsupported`，`pauseReason` 写明原因（`egressRegionUnsupported` 附 `egressRegion`，或 `egressUnconfirmed`），下次读取时重新检测。检测结果按当前网络缓存在 `~/.vibe-usage/egress-checks.json`：出口在支持地区缓存 10 分钟，其他结果 1 分钟，网卡地址变了就重新检测。Cloudflare（这些厂商的 CDN）会看到你的出网 IP，但看不到账号。Kimi、ZCode、OpenCode Go、Cursor 不做这个检测。两个环境变量可以改变做法，桌面应用也用它们把设置转给 CLI：

- `VIBE_USAGE_EGRESS_CHECK=0`：不检测，没检测到代理时直接读取。
- `VIBE_USAGE_REQUIRE_PROXY=1`：这台电脑靠本机代理软件上网。没检测到代理时一律暂停（`pauseReason: proxyNotDetected`），也不发检测请求。

只开了系统代理、没设代理环境变量时，在终端里运行的 CLI 看不到系统代理，会按直连检测，而 Antigravity 桌面版自己走系统代理，所以可能误判而暂停。设上 `HTTPS_PROXY` 即可。

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

## Magpie model attribution

Claude Code, Codex, Pi, Oh My Pi, and OpenCode can record a Magpie routing
group instead of the model that answered. Vibe Usage matches their calls to
Magpie's local `$XDG_CONFIG_HOME/magpie/usage.jsonl` (default:
`~/.config/magpie/usage.jsonl`) and restores the model only on an exact,
unambiguous match. Correct concrete names, including reasoning suffixes such
as `:high`, stay unchanged. Missing or conflicting matches keep the original
name. Magpie is not a separate usage source.

The reader uses only timing, caller/provider/model, served model/tier, token
counts, status, response/request/session identifiers, and the exclusion fields
`handed_on`, `source`, and `computer`. It excludes handed-on attempts
(`handed_on: true`), reported calls (`source: "reported"`), and other computers'
calls (nonempty `computer`). It does not retain account details, key names,
or error text, and never uploads ledger records or identifiers. Only the model
name changes in existing usage buckets. Other computers' `usage-others/`
ledgers and portable Magpie installations are not read.

Restored names use `magpie/<provider>/<model>`, with `-priority`, `-fast`, or
`-flex` when Magpie reports that served tier. The dashboard may therefore show
two names for the same model; their costs and model families use the actual
model. With Claude subscription bridging, a background Claude Code session is
excluded only when a ledger row has provider `claude`, an exact nonempty request
ID in that session, and caller `claude`, `codex`, `pi`, `omp`, or `opencode`.
Other callers, such as Zed, retain the Claude Code session. If you manually
take over a background bridge session, that entire session remains excluded,
including your later work.

`magpieStartAt` protects uploaded history. An absent key means attribution has
not started. On first use, Vibe Usage saves the end of the latest uploaded
half-hour for these tools, or the literal `none` if they have no uploaded
history. A Key/account rebound that clears upload state uses the end of the
current half-hour instead. Records before a dated cut retain their original
names and continue updating; records at or after it can be restored. `init`
preserves the cut. An established cut cannot be moved to another time.

**Upgrade every collector and keep `state.json` before upgrading.** If a
background service is installed, only a sync from the daemon itself can set
the automatic cut. After upgrading, restart it or reboot your computer:

```bash
npx @vibe-cafe/vibe-usage daemon restart

# Optional explicit cut: must be a UTC half-hour boundary
npx @vibe-cafe/vibe-usage config set magpieStartAt 2026-11-06T12:30:00Z
```

`config set magpieStartAt none` is always allowed and saves `none` as a value.
Use it only if this machine has never uploaded the original model names:
otherwise restoring historical names can double-count usage. To rebuild
history, `reset` first deletes cloud data, then clears local upload state and
the cut, and finally re-uploads available logs. With an installed service, the
immediate re-upload uses original names until the daemon sets a new cut.

For windows that still contain at least one current row, if a previously
uploaded `magpie/` row disappears, or a new one would replace a missing original
row, the whole tool/project/device/half-hour window is held at its last uploaded
value. Entirely vanished windows follow normal local-state pruning. Recent
unmatched Magpie requests wait up to ten minutes; ledger read failures hold
post-cut windows until a later sync.
One summary per reason reports the window count, tools, earliest/latest window
starts, and recovery steps on stderr, including in daemon logs.
Restore the ledger, upgrade all collectors, and check its location. In
particular, a service may not inherit your `XDG_CONFIG_HOME`; this can cause
held windows until the service can see the same ledger. Uninstalling Magpie
with ledger deletion also holds already-restored windows; new windows retain
their original names.

For less reliance on the ledger, set Magpie's `replyModel` to `member`. Claude
Code records the actual provider/model directly, and Pi records it in
`responseModel`, which Vibe Usage prefers. These paths work without a ledger.
We verified this in command-line (`-p`) mode without warnings; Claude Code's
interactive UI has not been verified. Codex, Oh My Pi, and OpenCode are
unaffected by this setting and still need the ledger. Changing it does not
double-count: Claude Code's new usage uses the concrete name without the
`magpie/` prefix and may appear as another model row; a conflicting existing
window is held by the guard.

## Development

Run the Node test suite locally with `npm test`. CI covers Node 20 and 22 on Ubuntu and macOS.

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
| `apiUrl` | Server URL (default: `https://vibefriends.com`; a stored `https://vibecafe.ai` is rewritten to it) |
| `hostname` | Stable device name for usage tracking (set at init, reused across syncs) |
| `codexExtraHome` | Optional additional Codex Home scanned together with `$CODEX_HOME` / `~/.codex` |
| `kikiStartAt` | Explicit UTC half-hour cut for migrating a collector that reported Kiki as `kimi-code`; see the Kiki migration steps above. Unset for new installations; `config set kikiStartAt none` clears an existing cut. Re-running `init` keeps it: a re-bind starts from an empty `state.json`, so the cut is then the only thing keeping pre-cut Kiki history from being sent again |
| `magpieStartAt` | UTC half-hour cut for Magpie model attribution, or literal `none`; absent means attribution has not started. See Magpie model attribution above |
| `extraRoots` | Tool-specific additional roots managed by the commands below; currently supports `antigravity`, `claude-code`, `codex`, `grok`, `hermes`, `opencode`, and `pi-coding-agent` |

The `hostname` is captured once during `init` and reused for all future syncs. This prevents macOS mDNS hostname changes (e.g., `MacBook-Pro` → `MacBook-Pro-2`) from creating duplicate device entries. To change it manually:

```bash
npx @vibe-cafe/vibe-usage config set hostname my-device-name
```

Add isolated runtime data without editing JSON by hand:

```bash
# Codex accepts either one direct Codex Home or a Multica container whose
# <workspace>/<task>/codex-home directories are at most three levels below it.
npx @vibe-cafe/vibe-usage config add-root codex /path/to/multica-container

# Claude Code expects a .claude root containing projects/ or transcripts/.
# Use the source id claude-code (not claude).
npx @vibe-cafe/vibe-usage config add-root claude-code /mnt/c/Users/you/.claude

# OpenCode accepts a data root containing opencode.db or storage/message/.
npx @vibe-cafe/vibe-usage config add-root opencode /path/to/other/opencode

# Grok expects a Grok Home containing sessions/.
npx @vibe-cafe/vibe-usage config add-root grok /path/to/grok-home

# Hermes expects a Hermes home containing state.db or profiles/*/state.db.
# This is in addition to ~/.hermes and $HERMES_HOME, not a replacement.
npx @vibe-cafe/vibe-usage config add-root hermes /path/to/hermes-home

# Antigravity expects an alternate HOME containing .gemini/antigravity*/conversations/.
npx @vibe-cafe/vibe-usage config add-root antigravity /path/to/alternate-home

# Pi accepts a directory that holds session .jsonl files directly, or a Pi
# agent directory containing sessions/. Use this when a harness starts Pi with
# `pi --session <file>`: that path is recorded nowhere Pi's own settings can
# report, so it is invisible to discovery.
npx @vibe-cafe/vibe-usage config add-root pi-coding-agent /path/to/pi-sessions

npx @vibe-cafe/vibe-usage config roots
npx @vibe-cafe/vibe-usage config remove-root grok /path/to/grok-home
```

Default roots are always scanned and existing `codexExtraHome` configurations remain valid. Additional roots are only scanned after they are explicitly added. If a configured root later becomes unavailable, that tool is skipped for the current sync so its incremental upload state is not pruned.

For OpenCode, each root uses its SQLite database when present; only roots without a database use legacy JSON. Copied records across roots are counted once using session/message ids, keeping the most complete copy. A broken database is reported and preserves sync state instead of silently substituting potentially stale JSON. Existing model names take precedence; nested model fields are only a fallback when the old field is absent. Claude Code retains its existing session and request deduplication rules.

## Background sync

The first `npx @vibe-cafe/vibe-usage` run installs a user-level service (systemd on Linux, launchd on macOS, Task Scheduler on Windows — no admin rights needed) that syncs every 30 minutes and starts automatically on login. Nothing else to do.

Switching the CLI to a different account (running `init` again, or `config set apiKey`) rebinds the upload state, so the next sync re-uploads your full local history to the new account instead of treating it as already sent.

换绑账号后（重新 `init` 或 `config set apiKey`），下一次同步会自动全量重传本地历史，不会因为旧账号的同步记录而漏传。

<details>
<summary>Managing the service, and how it is launched</summary>

```bash
npx @vibe-cafe/vibe-usage daemon status
npx @vibe-cafe/vibe-usage daemon stop
npx @vibe-cafe/vibe-usage daemon restart
npx @vibe-cafe/vibe-usage daemon uninstall
npx @vibe-cafe/vibe-usage daemon install    # only needed after --no-daemon, uninstall, or a Node upgrade broke it
```

**How the service starts the CLI.** When you ran the CLI through `npx`, the service is registered as `npx --yes @vibe-cafe/vibe-usage@latest daemon`, so it survives `npm cache clean` and picks up the newest release at every login. When the CLI was installed globally (`npm install -g @vibe-cafe/vibe-usage`) or run from a checkout, the service pins that exact `node <bin> daemon` path instead — upgrade the package and `daemon restart` to pick up a new version. `daemon status` prints which of the two forms a machine has. A service installed by a CLI older than 0.10.25 keeps its pinned npx-cache path; to switch it to the self-updating form run `daemon uninstall` and then the bare command once.

**After upgrading Node.** When your `PATH` has a stable entry pointing at the very same `node` binary — e.g. Homebrew's `/opt/homebrew/bin/node`, which `brew upgrade` re-points — the service is registered with that entry and the `npx` next to it, so an upgrade does not break it. Without such an entry (nvm, fnm, Volta and similar version managers) it still records the versioned path, as does any service installed by an older CLI; removing that Node version then breaks the service. `daemon status` and `doctor` warn when a registered path is gone: the service fails the next time it starts, even if a daemon that was already running keeps syncing until then. 升级 Node 后如果后台同步停了，运行 `npx @vibe-cafe/vibe-usage daemon install` 重新注册。

**Foreground mode** (no service, Ctrl+C to stop):

```bash
npx @vibe-cafe/vibe-usage daemon
```

</details>

## License

[MIT](LICENSE)
