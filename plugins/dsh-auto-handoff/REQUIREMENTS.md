# dsh-auto-handoff · 需求文档

> 状态：v1.2（2026-11-08：源码位置定稿 + N2 按实测订正）
> 项目定位：**长期维护项目**，唯一权威源码目录 `D:\proj\PC1\plugins\dsh-auto-handoff`（纳入 `dongopencv/tools` 版本控制，见 `README.md` 的「源码位置」一节）
> 这份文档回答"要什么"，不回答"怎么做"（怎么做见 `DESIGN.md`）

---

## 1. 背景与痛点

### 1.1 触发这件事的原始场景

用户在单个长会话里跑长任务，一次吃掉了约 2 亿 token（用户口径）。单个会话上下文单调膨胀，每一轮都把全部历史重新发送，所以 token 消耗随轮数近似平方增长。

### 1.2 实测复盘的真正成因（2026-11-06 取证）

对两个真实会话做了日志解压统计：

| 会话 | 请求数 | 工具调用 | Σ inputTokens | 峰值单次 input |
| --- | --- | --- | --- | --- |
| `session-5c53971e` | 95 | 128 | 1,200,318 | 415K |
| `session-0a1d53a3` | 298 | 290 | 22,154,347 | 530K |

关键发现（`0a1d53a3`）：

```
seq 1503-1537   每轮 input≈500 tokens，cacheRead≈47万   ← 缓存有效，极便宜
seq 1544        turn/end
seq 1551        system/message      ← 系统提示被重写
seq 1552-1554   user/message × 3    ← 群聊/团队消息接入
seq 1557        input=489,418  cacheRead=215            ← 缓存全废，整份重付
```

此后每 2–3 个请求重复一次缓存失效：

```
seq 1882  input=526,599  cache=128   ← 全额重付
seq 1894  input=527,921  cache=128   ← 全额重付
seq 1922  input=530,354  cache=128   ← 全额重付
```

1557 之后 58 个请求里 **38 个是冷请求**，光这一段消耗 **2,051 万 token**。

**结论：真正的浪费不是"上下文太长"，而是 prompt cache 反复失效后的重复全额付费。**
这一点直接决定了本项目的需求边界——见 1.4。

### 1.3 为什么"写规则让模型自己切"不可行

在长上下文里，任何写在提示词里的规则（AGENTS.md、系统提示词、skill 提醒）都会被稀释、被后文覆盖、被模型忽略。用户在最初的需求里就明确担心："即使写到规则，在任务过程中它是不执行的，因为上下文被污染了。"

**因此本项目的硬性前提：触发判断不得进入模型上下文，不得依赖模型配合。**

### 1.4 需求边界（重要）

| 本插件负责 | 本插件不负责 |
| --- | --- |
| 会话因"越跑越长"导致的线性/平方增长 | prompt cache 失效导致的重复全额付费 |
| 在阈值处把接力棒交给新会话，**并 cancel 父会话的当前轮**（保留未处理队列） | 删除/归档旧会话（不 delete，历史仍可读） |
| 提供可审计的交接文档 | 修复 agent-teams 重写 system prompt 的行为 |

第 2 列的问题是 1.2 里实测到的真正大头，但它属于另一个故障域。是否纳入本项目见「待决问题 P1」。

---

## 2. 目标与非目标

### 2.1 目标

- **G1** 会话达到阈值时，自动产出交接文档并开启新会话续作，全程不需要模型"同意"。
- **G2** 触发判断完全在宿主进程内完成，与上下文长度、模型状态无关。
- **G3** 交接失败不得影响当前轮次，不得让用户任务中断。
- **G4** 可控：能关、能调阈值、能限链深、能审计。
- **G5** 长期可维护：结构清晰、测试可离线跑、无隐藏状态。

### 2.2 非目标（当前版本明确不做）

- **N1** 不替代平台自带压缩（`compaction-basic`，当前 profile 里是 `enabled: false`）。
- **N2（2026-11-08 订正）** 不删除、不归档旧会话；但**会**调 `sessionController.cancel({sessionId})` 停掉父会话的当前轮（`keepInbox` 保留队列）。
  原判是「不 cancel」，理由是「取消用户正在跑的任务风险更大」——实测推翻：父会话交接后仍跑了 70 分钟、与子会话同时烧 token（`ISSUES.md` I-9）。手动 `/handoff` 不 cancel（调用方就是那个会话自己），`cancelParentAfterHandoff: false` 可退回旧行为。
- **N3** 不做跨机器/跨 profile 的协调。
- **N4** 不做 UI 面板（当前只提供斜杠命令）。

---

## 3. 用户故事

| ID | 故事 | 验收 |
| --- | --- | --- |
| US-1 | 作为长任务用户，我希望会话跑到一定规模自动切换，避免单会话无限膨胀 | 阈值命中后新会话被创建且收到交接文档 |
| US-2 | 作为用户，我不希望插件在某一轮跑到一半就强行打断我 | 交接动作不阻塞、不否决当前轮 |
| US-3 | 作为用户，我希望即使这一轮永远不结束，交接也要发生 | 不触发 `turn-stopping` 时仍能交接（轮中硬兜底） |
| US-4 | 作为用户，我希望随时能看到离阈值还有多远 | `/handoff-status` 输出 token/工具调用/百分比 |
| US-5 | 作为用户，我希望想切就立刻切 | `/handoff` 立即交接 |
| US-6 | 作为用户，我希望插件不会无限自我续作 | `maxAutoHops`（旧名 `chainLimit`）生效，到顶只写文档且**可见地停住**（标题改名 + 占位 `stopped` + `chain.json.stopped`） |
| US-7 | 作为维护者，我希望改动后能离线验证 | **71 条断言**（integration 23 / chain 8 / claims 10 / docs 14 / goal 9 / midturn 7）可 `node` 直接跑 |
| US-8 | 作为用户，我不希望插件自己烧钱 | 可 `modelSummary: false` 完全零模型调用 |

---

## 4. 功能需求

### FR-1 双闸触发

| 闸 | 挂载点 | 触发条件 | 特点 |
| --- | --- | --- | --- |
| 轮末闸 | `agent/turn-stopping` | token ≥ 阈值 或 工具调用 ≥ 阈值 | 默认路径，一轮结束时检查 |
| 轮中闸 | `session/event`（`tool/call`） | 工具调用累计 ≥ 阈值 | **不等本轮结束**，过线立即交接 |

- FR-1.1 两闸共享同一份**落盘**占位（`~/.dsh/auto-handoff/claims.json`），同一会话只交接一次；杀进程重启后仍然有效。
- FR-1.2 轮中闸由 `enforceMidTurn`（默认 `true`）控制开关。
- FR-1.3 统计只针对根会话，跳过 `header.origin === 'subagent'`。
- FR-1.4 同 cwd 并发上限 `maxConcurrentHops`（默认 2）：超限不判失败，落 `deferred{deferredUntil}` 并在下一轮自动重试。

### FR-2 阈值判定

- FR-2.1 判定式为 `if (tokens < threshold && toolCalls < toolCallThreshold) return`，即**任一命中即触发**。
- FR-2.2 token 值来自 `tokenMeter.measure(session).totalTokens`，是压力估算，不是账单。
- FR-2.3 **生效阈值** = `tokenThreshold` 非 0 时用绝对值；否则 `tokenThresholdRatio`（默认 0.45）× `session.requestContext().contextWindow`；
  窗口拿不到时按 `FALLBACK_CONTEXT_WINDOW`(1,000,000) 算并**在日志与事件里标明**。
- FR-2.4 token 测量失败不再静默返回 0：返回 `{tokens, reason}`，`reason` 进 `gate/skip` 事件，`/handoff-status` 打「⚠️ token 读数不可信」。
- FR-2.5 `toolCalls` 判定用**闸门计数**（`toolCallCounts.get(id)`，轮中累加），日志与事件也记这个值——不是 `collectFacts` 的历史累计。

### FR-3 交接文档

- FR-3.1 路径：`<会话工作目录>/.dsh/handoff/<源会话id>/`，三份产物：
  `index.md`（注入新会话，六节，顺序即裁剪优先级）/ `facts.jsonl`（机读事实，不注入）/ `full.md`（人看的全文，八节）。
- FR-3.2 `index.md` 六节与预算：目标 600（必留）/ 下一步 1200（必留）/ 约束与禁区 500 / 未决问题 400 / 交接前 REVIEW 400 / 档案索引 300。
  总长超 `briefTargetChars`(3000) 时从最末非必留小节往前丢并写明去处；超 `briefMaxChars`(6000) 才硬切。裁剪必须落在**节边界**。
- FR-3.2.2 `facts.jsonl` 每行 `{id,type,at,text(≤1000),ref}`，`type ∈ {user,assistant,file,tool,error,decision}`。
- FR-3.2.1 「原始目标」必须是**链根**那句用户原话，不是首条 `user/message` 的原文——后者是上一棒注入的整份简报，
  直接收录会层层嵌套。由 `unwrapGoal` 顺简报首行的文档路径读盘下钻还原（见 ISSUES I-14）。
- FR-3.3 摘要来源：模型生成（默认）或本地兜底（`modelSummary: false` 或模型不可用）。
- FR-3.4 上限：`briefMaxChars`（6000）、`briefTargetChars`（3000）、`summaryMaxChars`（1600）、`goalMaxChars`（4000）、`maxTrackedFiles`（40）。
- FR-3.5 用户指令与宿主注入的区分以 `user/message` 的 `data.source.kind === 'user'` 为准；前缀白名单降为兜底（实测注入轮白名单漏 42 条）。
- FR-3.6 交接前 REVIEW 三层，只有 L1 能刹车：`block` 时不建新会话，父会话落 `failed{note:'review-block'}` 并改名 `[REVIEW 未通过]`；
  `warn` 照常交接但 warn 项写进简报首行；REVIEW 结论进 `index.md` 第 5 节、`facts.jsonl`、以及 `review/verdict` 事件。

### FR-4 新会话续作

- FR-4.1 通过 `sessionController.create({ cwd, agentPreset })` 创建，**必须继承源会话的 `agentPreset`**。
- FR-4.2 通过 `sessionController.prompt(request, signal)` 投递；**signal 必传**（宿主第一行就是 `signal.throwIfAborted()`）。
- FR-4.3 投递内容 = 链元信息行 + `[自动交接] 上一会话 …` + REVIEW 结论 + `===== 交接文档开始/结束 =====` 包裹的 `index.md`。
- FR-4.4 投递失败：新会话进 `chain.json.orphans[]` 并改名 `[孤儿·无简报]`，**不 cancel**（它可能已经开始干活）。

### FR-5 链深度控制

- FR-5.1 账本路径：`~/.dsh/auto-handoff/claims.json`（**不进工作区仓库**）；旧 `state.json` 只作兼容读。
- FR-5.2 记录 `{ root, depth }`，新会话入账时 `depth + 1`。
- FR-5.3 `nextDepth > maxAutoHops`（默认 8，旧名 `chainLimit`）时只写文档、不创建新会话，并同时做三件事：
  文档写死「自动续作已到第 N/M 棒，需人工 /handoff」、会话改名 `[链到顶 N/8]`、占位落 `stopped{stoppedReason:'chain-limit'}` + `chain.json.stopped=true`。
- FR-5.4 链账本 `~/.dsh/auto-handoff/chains/<root>.json` = `{root,cwd,startedAt,limit,hops[],orphans[],stopped}`，只记完成的棒（冷热路径分离）。
- FR-5.5 分支顺序固定：**链到顶 → REVIEW block → 并发 deferred → 缺 controller 降级**。顺序反了会让终态 `stopped` 不可达。

### FR-6 命令

| 命令 | 行为 | 是否触发交接 |
| --- | --- | --- |
| `/handoff` | 立即交接，报告新旧会话 id 与文档路径 | 是 |
| `/handoff-status` | 输出 token 压力（含阈值来源与窗口）/工具调用/距阈值/同 cwd 同伴棒/链第几棒/token 读数不可信告警 | 否（纯只读） |

### FR-7 降级

| 缺失项 | 行为 |
| --- | --- |
| `tokenMeter` | 只用工具调用计数触发，并写 `gate/skip` 事件、`/handoff-status` 显式告警 |
| `sessionController` | 只写文档，不创建会话；占位落 `stopped{note:'no-session-controller'}`，等人工 |
| `llm` | 走本地兜底摘要 |
| 摘要超时/报错/空串 | 走本地兜底摘要 |

---

## 5. 非功能需求

| ID | 要求 | 当前实现 |
| --- | --- | --- |
| NFR-1 | 不得阻塞当前轮 | 轮末闸同步判定 + `void async` 后台执行 |
| NFR-2 | 不得抛错进主流程 | 所有监听器 try/catch，只 logWarn |
| NFR-3 | 每事件开销 O(1) | 工具计数为 Map 自增 |
| NFR-4 | token 测量 O(surface) | `tokenMeter.measure` 每轮末各一次，可接受 |
| NFR-5 | 零外部依赖 | 仅 `@deepseek-ai/schemastery` + Node 内置模块 |
| NFR-6 | 可离线测试 | 71 条断言 / 6 个文件（integration 23 / chain 8 / claims 10 / docs 14 / goal 9 / midturn 7），`node --test test/*.test.mjs` 直接跑 |

---

## 6. 验收标准

- [x] AC-1 未达阈值不产生任何副作用
- [x] AC-2 工具调用达阈值触发交接（写文档 + 开会话 + 投递）
- [x] AC-3 token 达阈值触发交接
- [x] AC-4 无模型摘要时用兜底并照常交接
- [x] AC-5 链深度超限时只写文档，且三件可见的事都做完（改名 / 文档写死 / 占位 stopped + chain.json）
- [x] AC-6 同一会话只交接一次
- [x] AC-7 缺 `sessionController` 时降级为只写文档
- [x] AC-8 新会话继承 `agentPreset`
- [x] AC-9 `/handoff` 与 `/handoff-status` 已注册
- [x] AC-10 **不发 `turn-stopping` 时轮中硬兜底仍能交接**
- [x] AC-11 关闭硬兜底后恢复旧行为（对照组）
- [x] AC-12 硬兜底在阈值以下不触发
- [x] AC-13 两闸共存时不重复交接
- [x] AC-14 `index.md` / `facts.jsonl` / `full.md` 三份产物齐全，facts 每行可 parse
- [x] AC-15 REVIEW 判 block 时不建新会话，父会话 `failed` + 改名，并写 `review/verdict` 事件
- [x] AC-16 同 cwd 并发超限落 `deferred`（非终态），下一轮能自动重试
- [x] AC-17 简报首行是链元信息 `链：第 N 棒 / 上限 M …`，且 `unwrapGoal` 不把它当用户原话
- [x] AC-18 `tokenThresholdRatio` 按 `contextWindow` 换算；tokenMeter 缺失时可见告警
- [x] AC-19 一次成功交接写全 9 类结构化事件中的 5 类，`claim/settle` 条目带十一键且 `toolCalls` 是闸门实值

---

## 7. 待决问题

| ID | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| P1 | 是否把"缓存失效导致的重复付费"纳入本项目？ | 决定项目边界是否扩大到 1.2 的真大头 | 建议**另立项目**，本插件保持单一职责 |
| P2 | 用户说的"2 亿 token"是 token 数还是账单额？实测 Σinput 约 2,360 万、cacheRead 约 1.36 亿 | 影响阈值标定 | 需用户确认口径 |
| P3 | `compaction-basic` 当前被禁用，是否应启用？ | 平台级压缩未开，单靠换会话不解决窗口上限 | 建议评估启用 |
| ~~P4~~ | ~~阈值默认值（30 万 / 80 次）是否需按实测数据下调？~~ | **已决（v1.2）**：`tokenThreshold` 改按窗口比例 `tokenThresholdRatio=0.45`（实测交接窗口占比 p25=22% / p50=37%，13 次样本还不足以定绝对值）；工具阈值 80 保留并继续采样 | 满 20 次真实交接后用 `handoff-metrics.mjs` 重算 |
| P5 | 是否需要新增"缓存命中率闸"？ | 直接针对 1.2 的真问题 | 待 P1 结论 |
| P6 | agent-teams 为什么会重写 `system/message`？ | 是缓存失效的疑因 | 需单独排查 |
| P7 | 子代理会话为何 0 个落盘？ | 影响"交接是否覆盖子代理"的判断 | 需单独排查 |