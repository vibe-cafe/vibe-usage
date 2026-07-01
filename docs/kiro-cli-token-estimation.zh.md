# Kiro CLI Token 估算 — 设计说明

*配套 `kiro.js` 改动:新增 `~/.kiro/sessions/cli/*.jsonl` 原生事件流解析器。
英文版:[`kiro-cli-token-estimation.md`](./kiro-cli-token-estimation.md) ·
HTML:[`kiro-cli-token-estimation.zh.html`](./kiro-cli-token-estimation.zh.html)。*

## 一句话

- **正式版 Kiro CLI** 把每段会话存成 `{version, kind, data}` **事件流**,位于
  `~/.kiro/sessions/cli/<uuid>.jsonl`(同名 `<uuid>.json` 存 `cwd` 和模型)。它**不会**
  写入 `data.sqlite3` 的 `conversations_v2` 表,所以 `858336b` 那条 CLI 路径在这些安装上
  读到的是 **0 行**。
- 本次改动把该事件流作为 Kiro 的**第一数据源**,从文本按 `chars/4` 估算
  input/output/thinking/cache,读不到时再回退到既有的 credit / legacy 路径。
- 数字做了**交叉验证**(输入侧对账到 **99.5%**)。有一个正确性陷阱已处理:
  **thinking 块的加密签名必须从 token 计数中排除**——在真机上它相当于约 148 万"token"
  的噪音,不排除会让 output 虚高 100% 以上。

## 为什么现有 CLI 路径读不到东西

`858336b` 读的是 `data.sqlite3` 里的 `conversations_v2` / `conversations`,外加
`~/.kiro_sessions/*.json` 归档。在一台真实、重度使用的 Kiro CLI 机器上:

| 现有路径读取的位置 | 测试机上的行数 |
|---|---|
| `data.sqlite3` → `conversations_v2` | **0** |
| `data.sqlite3` → `conversations` | **0** |
| `~/.kiro_sessions/*.json` | 目录不存在 |

真实会话数据在 `~/.kiro/sessions/cli/*.jsonl`(测试机两天内有 116 个文件被修改),
是事件流格式,而不是 DB 路径期待的 `history[]` 结构。

## 原生格式

`<uuid>.jsonl` — 每行一个事件 `{version, kind, data}`:

| kind | 载荷 | 对应 |
|---|---|---|
| `Prompt` | `data.content[]`(`text` / `image`);`data.meta.timestamp` = epoch **秒** | 新增输入;**唯一**时间戳来源 |
| `AssistantMessage` | `content[]`:`text`(回复)、`thinking`(`text` + `modelId` + 加密 `signature`)、`toolUse`(`name` + `input`) | 输出 / 推理;模型 id |
| `ToolResults` | `content[]` 工具输出 | 作为下一轮的新增输入 |
| `Compaction` | `summary` | 重置累计上下文大小 |

`<uuid>.json` — 会话元数据:`cwd`(→ 项目)与
`session_state.rts_model_state.model_info.model_id`(模型回退)。

## 估算方式

`token = 字符串叶子字符数 / 4`,只遍历字符串叶子,并**跳过非语言键**
(`signature`、`redactedContent`、`toolUseId`、`modelId`、`message_id`、`format`、`id`)。
每个 assistant 轮次:

- `outputTokens` = assistant `text` + `toolUse`(name/input)
- `reasoningOutputTokens` = `thinking.text`(排除签名)
- `inputTokens` = 用户 prompt + 之前的 `ToolResults`(每张图片 +~1600)
- `cachedInputTokens` = 累计会话上下文(每轮重发)+ 每轮系统提示/工具 schema 开销
- `model` = `thinking.modelId` → 会话 `model_id` → `kiro-token-estimate`
- `timestamp` = 所在 `Prompt` 的时间戳(同轮次的事件继承它)

输出用 assistant **文本**估算,比数 chunk 更贴近真实——而且这个原生格式里根本没有
`time_between_chunks`。

### 两个"每轮重发"项(需 maintainer 定夺)

1. **thinking 签名进 cache**。扩展思考 + 工具调用要求后续每轮回传 thinking 块(含签名),
   所以签名被加进累计上下文(不计入 output)。按 `chars/4` 计,是保守下限
   (base64 分词更差)。
2. **系统提示 + 工具 schema**。每次请求都注入,但从不写日志,所以只看事件流会一个都数不到。
   建模为每轮常量 `KIRO_CLI_SYSTEM_OVERHEAD_TOKENS`(默认 **20000**)。设为 `0` 即只数日志内文本。
   **这块随你改 / 删,你定。**

## 数字是怎么验证的

两份独立编写的计数器跑同一批日志:

- **估算器** — 有状态的轮次遍历 + 选择性字段提取。
- **独立重算** — 单遍累加每个事件里所有字符串叶子,无轮次逻辑、无 cache 模型、不跳字段。

结果:

1. 它**抓到过一个真 bug**:早期版本用 `JSON.stringify` 提取工具结果,把结构开销也算进去
   → **6 倍**虚高(输入 1480 万 vs 250 万)。只有独立实现才能暴露这个。
2. 修复后**输入对账到 99.5%**(2,532,691 vs 2,544,964)。
3. 输出侧的差异被第三次独立测量完全解释:签名 ≈ 148 万 token —— 正好是那个差值。
   不是 bug,是刻意排除。

范围:这验证的是**解析正确性与一致性**,不验证 `chars/4` 比例、也不验证 cache 模型是否等于
厂商真实计费(Kiro 不暴露 ground truth——它按 Credits / `INVOCATIONS` 计量,与 token 非线性)。

## 测试

`test/kiro.test.js` 新增:

- `cliEventsToEntries` — in/out/think 估算、**签名从 output 排除但保留在 cache**、
  碎结构不被 JSON 结构撑大、多个 assistant 轮次继承 prompt 时间戳。
- `parse` — 端到端读取一个原生 `~/.kiro/sessions/cli/*.jsonl` fixture 并聚合成桶。

既有 Kiro 测试全部通过(两个 `parse` 测试把 `KIRO_CLI_SESSIONS_DIR` 指向空目录,
使新的第一优先级源在测试中不生效)。
