# dsh-auto-handoff · 设计方案

> 状态：v1.2（2026-11-08）
> 对应需求：`REQUIREMENTS.md`
> 对应源码：`lib/index.js`（2347 行）、`lib/claims.js`（209 行）、`lib/docs.js`（182 行），2026-11-08 实测 `wc -l`
> 配套脚本：`tools/handoff-check.mjs`（现网体检）、`tools/handoff-metrics.mjs`（用真实数据反推阈值）

---

## 1. 设计第一原则

**触发判断绝不进入模型上下文。**

这条原则不是风格偏好，而是需求的硬约束（REQUIREMENTS §1.3）。它决定了架构：

- 不能用 `systemPrompt.section()` 写规则 → 插件**没有** `systemPrompt` 依赖
- 不能用模型工具（tool）让模型自己调 → 插件**不注册任何工具**
- 必须挂在宿主事件上，用宿主状态判断

验证：

```bash
grep -n "systemPrompt" lib/index.js    # 无输出
grep -n "export const inject" lib/index.js  # ['commands', 'sessions']
```

---

## 2. 平台事件选型

### 2.1 候选与取舍

| 事件 | 模式 | 返回值 | 能否否决 | 结论 |
| --- | --- | --- | --- | --- |
| `agent/pre-step` | waterfall | `{kind:'reject'} \| {kind:'enter'}` | **能拒绝一步** | 未采用（会打断用户任务） |
| `agent/turn-stopping` | serial | `Promise<void> \| void` | **不能否决** | ✅ 轮末闸采用 |
| `session/event` | emit | `void` | 不能 | ✅ 轮中闸采用 |
| `agent/request-error` | waterfall | `RequestErrorAction` | 能改 | 未采用 |

### 2.2 为什么轮末闸选 `turn-stopping` 而不是 `pre-step`

平台对 `agent/turn-stopping` 的原文定义：

> "The turn is about to close: the model owes no response (no live tool calls, no fresh steering). Awaited before the boundary commits — a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox."

含义：
- 它返回 `void`，**没有否决权**——插件在物理上无法阻止模型请求
- 它想在轮末"反悔"只能 `steer`，那是把轮次**拉长**，不是拦截
- 因此挂在它上面**不可能打断用户任务**

这正是需求 NFR-1（不得阻塞当前轮）的实现基础。

### 2.3 为什么还需要轮中闸

轮末闸有个时序缺陷：**如果某一轮自己跑很久**（例如批量任务在循环里连续调用几百次工具），`turn-stopping` 迟迟不来，阈值早就超了却什么都不发生。

这不是提示词污染问题，是纯粹的等待时机太晚。

因此增加轮中闸：挂 `session/event`，监听 `tool/call`，逐条累加，过线立即交接。

---

## 3. 双闸架构

```
                    ┌─────────────────────────────┐
   每轮结束 ────────►│ 轮末闸                       │
   (turn-stopping)  │ tokenMeter.measure(session)  │
                    │ + toolCallCounts.get(id)     │
                    └──────────┬──────────────────┘
                               │ 任一 ≥ 阈值
   每条 tool/call ──►┌─────────▼──────────────────┐
   (session/event)  │ 轮中闸                       │
                    │ count += 1                  │
                    │ count ≥ toolCallThreshold ?  │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │ reserveClaim(...)           │ ← 落盘占位（防重）
                    │ void async: performHandoff  │ ← 异步执行（不阻塞）
                    └─────────────────────────────┘
```

关键设计点：

1. **同步判定 + 异步执行**
   ```js
   reserveClaim(claimsFile, sessionId, options, Date.now(), false)  // 落盘占位，跨进程有效
   void (async () => { ... })()        // 后台执行，不 await
   ```
   如果直接在监听器里 `await` 摘要（超时 45s），宿主会等 45 秒才关轮。

2. **失败不再撤回占位，改为记 failed + 冷却**
   ```js
   settleClaim(claimsFile, sessionId, { state: 'failed', note: 'prompt-failed: ...' })
   ```
   旧实现失败即 `delete`，导致下一轮立刻重放、连开空会话（18:26–18:28 连开 14 个）。
   现在由 `retryCooldownMs`（10 分钟）与 `maxAttempts`（3 次）兜住。

3. **两闸共享占位集合**，因此两闸共存也只交接一次（AC-13）。

---

## 4. 交接流程

```
performHandoff(session, trigger, signal)
  │
  ├─ 1. resolveSessionCwd(ctx, session)      工作目录（workingDirectory → header.cwd → process.cwd）
  ├─ 1. resolveSessionCwd(ctx, session)      工作目录（workingDirectory → header.cwd → process.cwd）
  ├─ 2. measureTokens(ctx, session)          token 压力，返回 {tokens, reason}；reason 非空 = 读数不可信
  ├─ 2b. effectiveTokenThreshold(...)        阈值 = 绝对值 或 ratio × requestContext().contextWindow
  ├─ 3. collectFacts(session, maxFiles)      从日志抽事实（注入判据：data.source.kind 优先）
  ├─ 4. resolveTitle(ctx, session)           会话标题
  ├─ 5. chainFor(sessionId) + countActiveHops 链深度（claims 优先，回退 state.json）+ 同 cwd 同伴棒
  ├─ 6. requestModelSummary(...)             模型摘要（失败→兜底摘要，兜底必须自带「## 下一步」节）
  ├─ 7. reviewHandoff(...)                   三条 block 规则，verdict ∈ ok / warn / block
  ├─ 8. renderIndex + renderFacts + renderDoc 三份产物（index.md / facts.jsonl / full.md）
  ├─ 9. mkdir + 三个 writeFile               ← 这里之前已经落盘，下面任一分支都能查
  ├─ 9a. if (nextDepth > maxAutoHops)        → stopped + rename + chain.json.stopped（必须排在 9b 之前）
  ├─ 9b. if (review.blocked)                 → failed{review-block} + rename，不建会话
  ├─ 9c. if (siblings >= maxConcurrentHops)  → deferred{deferredUntil} + rename，下一轮自动重试
  ├─ 10. sessionController.create({cwd, agentPreset})
  ├─ 11. sessionController.prompt(request, AbortSignal)  简报首行是链元信息
  └─ 12. 更新 claims.json（prompt 之前先写 inflight，失败写 failed + rename 孤儿，成功写 done/genesis）
```

**9a / 9b / 9c 的顺序是有约束的，不能换**：`chain-limit` 本身就是一条 block 规则，若 9b 排在前面，
到顶那一棒会先落 `failed`（可重试）而永远到不了正确的终态 `stopped`。这条顺序有专门的回归测试
（`test/integration.test.mjs` 的「链到顶三件事」）。

### 4.1 事实抽取（`collectFacts`）

只读日志，不重放、不执行任何工具：

| 事实 | 来源 | 用途 |
| --- | --- | --- |
| `firstUser` | 首条 `user/message` 经 `unwrapGoal` 还原到链根 | 原始目标 |
| `recentUsers` | 最后两条 `user/message` | 校准方向 |
| `recentAssistant` | 最后两条 `assistant/message` | 校准进度 |

**助手消息的正文不等于 `text` 块**：当前 provider（`trae-enterprise` / `DeepSeek-V4.1-Flash`）下 80 条 `assistant/message` 的 block 统计是 `{"reasoning":71,"tool-call":80,"text":1}`——一条消息常常只有「一段思考 + 一个工具调用」。所以 `assistantText()` 按 `text` → `reasoning`/`thinking` 的顺序取正文，再追加 `（调用工具：name）` 摘要；只有工具名、没有正文的消息单独进 `assistantDigests`，仅当整段会话一条正文都取不到时才兜底使用。用户消息仍走 `messageText()`（只认 `text`，注入型消息都从这条路径过滤）。详见 ISSUES I-13。

**首条用户消息也不等于原始目标**：链上每一棒的首条 `user/message` 都是上一棒注入的**整份交接简报**（首行 `[自动交接] 上一会话 … 已把进度写入 \`<path>\``）。旧实现直接 `clampText(…, 1200)` 写进「原始目标」，于是每深一层就多嵌一层旧文档：实测 depth 6 那份只剩 693 字、本身又以 `[自动交接]` 开头，用户真正那句话（含 13 项验收清单）在第 2 层就没了。`unwrapGoal()` 按两条路下钻：① 读盘——从简报首行解析出上一棒文档路径，读全文再取它的「## 原始目标」，一路跳到链根（注入副本被 `docMaxChars` 截断，只靠正文递归第二层就断）；② 读不到盘时退回正文找该节。防环靠「读过哪些文档路径」（`seenDocs`），**不能**用文本指纹——链上相邻两棒的目标长度与尾部经常完全相同。上限由 `goalMaxChars`（默认 4000）控制。详见 ISSUES I-14。
| `toolCounts` | 所有 `tool/call` 按 name 聚合 | 工具轨迹 |
| `files` | 从工具参数 JSON 递归抽路径 | 触及文件 |
| `toolErrors` | `tool/result.data.error` 存在 | 风险提示 |

路径抽取用白名单键（`file_path`/`path`/`paths`/`target`/`source`/`destination`/`cwd`），深度限 4，并排除 URL 与超长串。

### 4.2 模型路由五级回退（`resolveSummaryRoute`）

历史 bug：摘要拿不到 provider/model 时静默退回本地摘要，用户看不到"模型摘要"那个分支。

修复后按可靠性递减依次尝试：

1. 配置显式指定 `summaryProvider` + `summaryModel`
2. `session.requestContext()`
3. `session.requestHeader().config`
4. `agentDefaultModel.currentSelection()`
5. 日志里最后一条 `assistant/message` 的 `source`

任一步拿到完整的 `(provider, model)` 即返回；全失败才返回 `undefined` 走兜底。

### 4.3 新会话必须继承 `agentPreset`

历史 bug：新会话不带 `agentPreset`，导致工具集可能与上一棒不一致，交接文档里写的"用 X 继续"会落空。

```js
const preset = typeof session.header?.agentPreset === 'string' ? session.header.agentPreset : undefined
const created = await controller.create(preset === undefined ? { cwd } : { cwd, agentPreset: preset })
```

---

## 5. 状态管理

### 5.1 内存状态

| 结构 | 生命周期 | 用途 |
| --- | --- | --- |
| `toolCallCounts: Map<sessionId, number>` | 进程内 | 轮中闸计数 |
| `claims.json`（`~/.dsh/auto-handoff/`） | **跨进程持久** | 防重复交接；进程重启 / 新会话都不失效 |
| `chainState: Map<sessionId, {root, depth}>` | 进程内 + 懒加载磁盘 | 链深度 |

进程重启后 `toolCallCounts` 清零——这是已知限制（见 RISKS R3），但轮末的 token 闸不受影响，所以不会永远不触发。

### 5.2 磁盘状态

**`~/.dsh/auto-handoff/state.json`**，不是工作区。

历史 bug：最初写在 `<cwd>/.dsh/handoff/state.json`，会污染用户 git 仓库。已外移到用户主目录。

```json
{
  "sessions": { "<sessionId>": { "root": "<rootId>", "depth": 1 } },
  "updatedAt": "2026-11-05T17:00:51.369Z"
}
```

策略：最多保留 200 条，写入前 `mkdir -p`，写失败只 warn 不影响交接。

---

## 6. 降级矩阵

| 缺失/异常 | 检测点 | 行为 | 测试 |
| --- | --- | --- | --- |
| `tokenMeter` | `measureTokens` try/catch | 返回 `{tokens:0, reason}`，靠工具计数；`reason` 会进 `gate/skip` 事件与 `/handoff-status` | integration「tokenMeter 缺失」 |
| `requestContext` 无窗口 | `contextWindowOf` | 比例阈值按 `FALLBACK_CONTEXT_WINDOW`(1,000,000) 算并在日志标明 | integration「比例阈值」 |
| `sessionController` | `performHandoff` 早退 | 只写文档 + 撤回占位 | AC-7 |
| `llm` | `requestModelSummary` 早退 | 本地兜底摘要 | AC-4 |
| 模型摘要超时 | `AbortSignal.timeout` | 本地兜底摘要 | — |
| 模型摘要抛错 | try/catch | 本地兜底摘要 | — |
| 摘要空串 | `text === ''` | 本地兜底摘要 | — |
| `sessionTitle` | try/catch | `会话 <id 前8位>` | — |
| `workingDirectory` | try/catch | `header.cwd` → `process.cwd()` | — |
| 链深度超限 | `nextDepth > maxAutoHops` | 只写文档 + 占位 `stopped` + 标题改名 + `chain.json.stopped` | integration「链到顶三件事」 |
| REVIEW 判 block | `review.blocked` | 不建新会话，父会话 `failed` + 标题改名，等人工 | integration「REVIEW block」 |
| 同 cwd 并发超限 | `siblings >= maxConcurrentHops` | 落 `deferred` + 标题改名，`deferredUntil` 后自动重试 | integration「并发 deferred」 |
| 简报投递失败 | prompt 抛错 | 子会话进 `chain.json.orphans[]` 并改名 `[孤儿·无简报]`，**不 cancel** | integration「孤儿会话」 |
| 任何监听器异常 | 最外层 try/catch | `logWarn` 吞掉 | AC-7 |

---

## 7. 配置设计

23 个配置项，全部有默认值，全部可经 schemastery schema 校验：

| 键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；false 时不注册任何监听（只留 `/handoff-status`） |
| `tokenThreshold` | int ≥0 | `0` | token 压力**绝对值**；非 0 则优先于比例并打 warn |
| `tokenThresholdRatio` | num 0.1–0.95 | `0.45` | 按 `requestContext().contextWindow` 的比例触发 |
| `toolCallThreshold` | int ≥5 | `80` | 工具调用阈值 |
| `handoffDir` | string | `.dsh/handoff` | 产物目录（相对 cwd），三份文件在 `<sessionId>/` 下 |
| `modelSummary` | boolean | `true` | 是否用模型写摘要 |
| `maxAutoHops` | int ≥1 | `8` | 自动续作链最多几棒（`chainLimit` 是旧名，仍认） |
| `maxConcurrentHops` | int ≥0 | `2` | 同 cwd 同时最多几棒在跑 |
| `concurrentWindowMs` | num ≥60000 | `1800000` | `deferred` 多久后自动重试 |
| `summaryMaxChars` | num ≥400 | `1600` | 摘要字符上限（与 token 预算成函数关系，见 §2026-11-08 第三轮） |
| `briefMaxChars` | num ≥1000 | `6000` | 注入的 `index.md` 硬上限 |
| `briefTargetChars` | num ≥500 | `3000` | `index.md` 目标长度，超了从最末非必留小节往前丢 |
| `goalMaxChars` | num ≥400 | `4000` | 「原始目标」还原上限 |
| `summaryTimeoutMs` | num ≥5000 | `45000` | 摘要超时 |
| `maxTrackedFiles` | int ≥1 | `40` | 文件列表上限 |
| `summaryProvider` | string | `''` | 摘要 provider（空=自动） |
| `summaryModel` | string | `''` | 摘要 model（空=自动） |
| `enforceMidTurn` | boolean | `true` | 轮中硬兜底开关 |
| `claimTtlMs` | num ≥60000 | `86400000` | `inflight` 占位多久算死 |
| `retryCooldownMs` | num ≥0 | `600000` | `failed` 后多久能重试 |
| `maxAttempts` | int ≥1 | `3` | `failed` 自动重试次数上限 |
| `cancelParentAfterHandoff` | boolean | `true` | 交接成功后 cancel 父会话当前轮（保留 inbox） |
| `modelReview` | boolean | `false` | L2 模型审：只留配置，v1.2 未实现 |
| `reviewBlockOn` | string[] | `['no-goal','no-next-step','chain-limit']` | 哪些 L1 规则判 block |
| `toolErrorWarnRatio` | num 0.05–1 | `0.2` | 工具报错占比超过它就 warn |

---

## 8. 测试设计

### 8.1 为什么要在临时目录重写 import

插件 `import z from '@deepseek-ai/schemastery'`。在宿主进程里能解析，但测试从工作区裸跑 Node 解析不到。

**不采用**往包目录塞 `node_modules` 的方案——那会污染宿主对 schemastery 的真实解析。

**采用**：复制源码到临时目录，只把那一行 import 替换成 `globalThis.__SCHEMASTERY_STUB__`，用简易链式桩替代 schema DSL。测试跑的是真实实现（除 schema 定义外）。

### 8.2 测试隔离的关键点

链账本在 `~/.dsh/auto-handoff/`，测试必须把 `USERPROFILE` 指向临时目录，否则会读写真实账本、互相污染。

**这个修复曾经丢失过**，导致 `chainDepth` 用例假失败（写到了工作区却读用户主目录）。恢复记录见 `ISSUES.md` I-2。

### 8.3 71 条断言 / 6 个文件

| 文件 | 断言数 | 覆盖 |
| --- | --- | --- |
| `test/integration.test.mjs` | 23 | 轮末闸 AC-1 ~ AC-9、「下一步」的四道截断闸、`cancelParentAfterHandoff` 三态、只有 reasoning + tool-call 块时也取得到正文（I-13）；v1.2 新增：链到顶三件事、REVIEW block（不建会话）、并发 deferred、孤儿 rename、简报首行链元信息、比例阈值、tokenMeter 降级事件、`claim/settle` 十一键与闸门计数 |
| `test/midturn.test.mjs` | 7 | 轮中闸 AC-10 ~ AC-13，外加「已交接会话继续跑时只留一条证据行」「被 inflight 拦下后占位放开仍能交接（I-12）」「被拦日志按会话+原因去重」 |
| `test/chain.test.mjs` | 8 | 链深推进、`maxAutoHops` 到顶落 `stopped`、最新一棒不是 `done` |
| `test/claims.test.mjs` | 10 | 占位六态（含 `genesis`/`deferred`）与 TTL/冷却/次数、落盘读回、坏文件降级 |
| `test/docs.test.mjs` | 14 | `clampSectionBody` 按行边界 + 尾注行数反算、`renderIndex` 六节顺序与两级裁剪、`renderFacts` 逐行可 parse、`renderBriefMeta`/`stripBriefMeta` 往返 |
| `test/goal.test.mjs` | 9 | `unwrapGoal` 的下钻 / 防环 / 截断 / 降级：单跳、6 层多跳、注入副本被截断时靠读盘救回、相邻两棒同形不误判成环、真环 A→B→A 能停、文档缺失退回正文、`goalMaxChars` 截断、`DEFAULTS` 与 `resolveOptions` 默认值、端到端文档不含简报壳（I-14） |

轮中闸的核心是**只灌 `session/event`、完全不发 `turn-stopping`**，模拟"这一轮永远不结束、模型完全不理规则"。

统计断言数必须用 `grep -cE '^\\s*PASS '`：integration 的输出行带前导空白，`grep -c '^PASS '` 会得 0。

---

## 9. 已知边界（必须让后续维护者知道）

| 边界 | 原因 | 后果 |
| --- | --- | --- |
| ~~不 cancel 旧会话~~（v1.1.1 已改） | 原判：取消用户正在跑的任务风险更大 | 实测父会话交接后仍跑了 70 分钟、与子会话同时烧 token。现默认 `cancelParentAfterHandoff=true`，简报送达后 `cancel({sessionId})`（停当前轮、`keepInbox` 保留队列）；手动 `/handoff` 不取消 |
| 纯对话轮无工具时轮中闸无效 | 没有 `tool/call` 可计数 | 只能靠轮末 token 闸 |
| 进程重启后工具计数清零 | 内存 Map | 该会话的轮中闸失效，轮末闸仍有效 |
| 不解决缓存失效 | 属另一故障域 | 见 `REQUIREMENTS.md §1.4` |
| 子代理会话不统计 | `origin === 'subagent'` 跳过 | 子代理的消耗不受本插件管 |
| `tokenMeter` 的读数无法离线复算 | 语义是「请求+响应压力」，含回放与路由定价 | 比例阈值只是「同一把尺子」，不是精确窗口占用；实测四种算法两两对不上 |
| 同 cwd 并发判定靠占位状态推断 | 插件读不到别的会话「当前轮是否在跑」 | 只能数 `state ∈ {genesis, inflight}` 的同伴棒，不是精确并发数 |
| L2 模型审未实现 | 默认 `modelReview:false` | 想开的人会发现配置项存在但没接线（v1.3 候选） |
| 阈值绝对值仍无实据 | 真实交接样本 13 次（门槛 20） | 默认 0.45 是「按同一把尺子量」的起点，不是结论 |

---

## 10. 后续演进建议

按收益排序：

1. ~~加结构化日志~~（v1.2 已完成：`events.jsonl` 九类事件）。剩下的是**攒够样本后用真实数据定阈值**——`node tools/handoff-metrics.mjs --verify` 第 ⑦ 条要求 ≥20 次真实交接。
2. **启用 `compaction-basic`**，与换会话互补，解决窗口上限（不冲突：压缩保留会话、换会话清零，两者叠加）。
3. **缓存命中率观测**（只观测不动作），验证 §1.2 的假设。
4. ~~整合"压缩 + 归档 + 开新会话"为一个可配置流水线~~（v1.2 已完成前三段；压缩仍归 billionaire-context）。
5. ~~审核环节~~（v1.2 已完成 L1 确定性 REVIEW 与 block；L2 模型审待实现）。
6. **一旦有第二个工作区用起来**，把 `claims.json` 的并发判定换成读 `chains/<root>.json`（现在是冷热分离的权宜）。

---

## 2026-11-08 修订（v1.1.0）

本轮修的是**契约级**缺陷，全部有现网证据支撑：

1. **`controller.prompt(request, signal)` 少传第二参数。** 宿主实现第一行就是 `signal.throwIfAborted()`，少传即 TypeError。后果：全量 86 个会话里「首条 user 消息是交接简报」命中 0 条，新会话全是 4 帧空壳。修法：`promptSignal(signal)` 补一个真 AbortSignal。
2. **占位是进程内 `Set`。** 进程重启即失效，同一会话被重写 5 次以上；失败分支里 `delete` 又让下一轮立刻重放，18:26–18:28 连开 14 个空会话。修法：落盘占位 `claims.json` + `claimTtlMs` / `retryCooldownMs` / `maxAttempts`。
3. **账本写在 prompt 之后。** prompt 必抛，所以 `state.json` 从未被写过（恒 197 字节），链深恒为 1，`chainLimit` 从未生效。修法：prompt 之前写 inflight，失败写 failed + 原因，成功写 done。
4. **事实采集把宿主注入当成用户指令。** `system-reminder` 就是一条独立的 `user/message`。修法：前缀黑名单 + 计数。
5. **路径只按白名单键抽。** `run_code` 的路径在 `arguments.code` 里，白名单抓不到，文档写「（未识别到文件路径）」。修法：`pathsFromCode` + `pickExistingPaths`。
6. **落盘与注入共用同一份裁剪结果。** `docMaxChars=6000` 小于文档实际长度，排最后的「进度与下一步」被整段砍掉。修法：落盘用 4 倍上限，只裁注入副本。
7. **新增交接前 REVIEW**（`reviewHandoff` / `renderReview`），确定性规则，不用模型。
8. **测试假件改成真实签名。** 旧假件单参数、永不抛，比真实宿主宽松，契约级 bug 离线 100% 漏过。

---

## 2026-11-08 第二轮修订（v1.1.1）

v1.1.0 让流水线跑通了，但有三处在真实数据里仍然不成立：

1. **「下一步」照样会丢。** v1.1.0 只放宽了**落盘**那份（`docMaxChars*4`），但摘要本身在 `requestModelSummary` 里就已经被 `clampText(…, summaryMaxChars=1600)` 砍过一刀。模型被要求按「进度概述 → 关键决定与坑 → **下一步**」的顺序输出，所以被砍的永远是「下一步」。实测 8 份文档 4 份整节消失，摘要段长度恰好 1617（1600 + 17 字符截断标记）。
   修法：**按节裁剪**。`orderSummary` 把含「下一步」的节提到最前再裁；`ensureNextStep` 在模型漏写时用兜底补一节；`renderDoc` 把摘要与 REVIEW 移到文档前部，让注入副本（`docMaxChars=6000`）先砍的是历史事实而不是方向。
   设计含义：**任何「整体截断」都必须显式声明牺牲顺序**，否则牺牲的永远是最后写入的那一段。

2. **父会话交接后不停。** DESIGN §9 原写「不 cancel 旧会话」，在手工交接下成立，在自动交接下不成立——自动交接的前提就是「这一棒跑不动了」。实测 `session-74352d08` 交接 70 分钟后仍在 `step/start turn 7 step 346`。
   修法：`cancelParentAfterHandoff`（默认 true）+ `sessionController.cancel({sessionId})`；手动路径不取消。

3. **轮中闸把日志埋了。** 926 行日志里 878 行是同一条 INFO。终态挡住的是「再建会话」，挡不住「再记一行」。
   修法：`terminalSeen` 集合 + `toolCallCounts.delete`，终态会话只留一条证据行；日志行统一加 `[sessionId]` 前缀（旧日志无会话 id，是本次排查最大的障碍）。
   附带设计原则：**证据行只记「状态与预期不符」的那一次**，正常路径不产生重复日志。

## 2026-11-08 第三轮修订（v1.1.2）

v1.1.1 的三条修法在**离线测试里全部通过**，但装进真实 DSH 宿主后，「下一步」仍然是半句话就断了：

```
2. 逐条调用 bash 执行追加，每条单独一次工具调用，      ← 句子没写完
```

这一轮修的是截断的**第四个来源**，也是唯一一个离线测不出来的：

4. **输出预算与字数上限脱钩。** `requestModelSummary` 里 `maxTokens: 1200` 是写死的常数，而 `summaryMaxChars` 默认 1600。中文约 1.5–2 token/字，1600 字要 2400–3200 token。I-8 的 `orderSummary` 只能保证「下一步」**排在前面**，它保证不了模型**写得完**——重排序决定「谁先被裁剪」，输出预算决定「谁能被生成」。
   修法：`summaryTokenBudget(summaryMaxChars) = min(max(ceil(chars*2)+400, 800), 8000)`（默认 1600 字 → 3600 token）；`buildSummaryPrompt` 同时把「下一步」改成第一节、要求每节 ≤350 字，让总量落在预算里。
   设计含义：**凡是「上限」类参数，必须成对出现并有函数关系**（字数上限 ↔ token 预算、超时 ↔ 重试次数）。只写一个，另一个就是隐含的、无人审视的硬约束。

### 为什么必须有一条真宿主 e2e

同一套代码，离线 15 条 integration 全绿，真宿主里「下一步」断了。差别只在假件：

| 契约 | 真宿主 | 假件 |
| --- | --- | --- |
| `controller.prompt(request, signal)` | 第一行 `signal.throwIfAborted()` | 旧假件单参数、永不抛 → 简报 0/86 |
| `controller.create()` | 必返回 `{sessionId}` | 可能返回空 → 空壳会话疯涨 |
| `llm.stream({maxTokens})` | 真按预算截断 | 一次吐出整段 → 「下一步」半句 |

三次都栽在同一个模式上：**假件比真件宽松**。所以 e2e 不是「可选的高成本验证」，它是唯一能验契约的东西。

做法（可复用）：`~/.dsh/profiles/zz-handoff-e2e/`（bundles = base + headless + auto-handoff，`node_modules/dsh-auto-handoff` 用 junction 指向 `D:\\tools\\dsh-auto-handoff`），阈值压到 token 1000 / 工具 5，跑：

```bash
cd "C:/Users/Admin/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin"
DEEPSEEK_API_KEY=<key> cmd //c "dsh.cmd --profile zz-handoff-e2e --json '<让模型连续调 8 次工具的任务>'"
```

产出落在 CLI 进程的 cwd 下 `.dsh/handoff-e2e/`。headless profile 的 `sessionController` 不可用，所以它只写文档、不开新会话——**这正好是验证文档质量的最小闭环**。

## 2026-11-08 第四轮修订（v1.1.3）

v1.1.2 的三个截断源全修好、真宿主 e2e 也验过了，但装进桌面版之后链条**静默停摆**：本会话重载后又跑了 118 次工具调用（阈值 80），一次都没有再触发，日志里安静得像一切正常。

5. **「暂时被拦」被当成「永久不用管」。** 轮中闸抢占位失败时，不管 reason 是 `done`/`stopped`（真终态）还是 `inflight`/`cooldown`/`attempts-exhausted`（暂时），都无条件 `midTurnFired.add(id)`。占位放开之后没有任何代码清掉这个标记，于是这个会话剩下的整段生命周期都不再检查。
   修法：`midTurnFired` 只表示「这一棒已交接」，不再兼任「这一会话不要管了」；新增 `blockedNoted: Set`（键 `sessionId + '|' + reason`）**只做日志去重**，绝不参与触发判断；抢到占位时 `blockedNoted.clear()`。
   设计含义：**「暂时」和「永久」不能共用同一个标志位**。凡记「这件事处理过」的地方都要问一句「它会不会有第二次机会」，会的话标志必须带过期或清零点。这类缺陷不会抛错、不会告警，只会让链路安静地停下来——**最难发现的一类故障，恰恰是「一切看起来正常」**。

### 为什么这一条离线测试也测不出来

不是假件太宽松，而是**场景缺少时序**：原来的 5 个 midturn 场景都是「一次触发 → 一个终态」，没有任何一个走「先被拦 → 占位放开 → 再触发」。补的场景 6 就是这条时序：预写 `inflight` → 灌 85 次调用（应只记 1 条日志）→ 改成 `genesis` → 再灌 85 次 → 断言开出 1 个新会话。

教训归并成一句：**测试要覆盖「同一个东西被第二次问到」**。状态机的所有 bug 都活在这个间隙里。

## 2026-11-08 第五轮修订（v1.1.5）

v1.1.4 修好了「最近的助手输出」恒为空（I-13），但**「原始目标」还在层层嵌套**：一份 depth 6 的交接文档里，
「## 原始目标」那一栏装的不是用户的原话，而是「[自动交接] 上一会话 … 下面是同一份交接文档的全文」，
真正那句话（含 13 项 `- [ ]` 验收清单）在第 2 层就丢了。

6. **「首条 user/message」不等于「用户说的第一句话」。** 链上每一棒的第一条用户消息都是上一棒注入的整份简报，
   旧实现 `firstUser = clampText(userTexts[0], 1200)` 把简报壳也当成了目标。
   修法：`unwrapGoal()` 认 `[自动交接]` 前缀 → 从首行 `已把进度写入 \`<path>\`` 取上一棒文档路径 → **读盘**取它的
   「## 原始目标」→ 继续下钻，直到遇到不以该前缀开头的文本（= 链根的真用户话）。
   独立的 `goalMaxChars`（默认 4000）取代了那个 1200 的小钳位——1200 装不下链根那份 1489 字的目标。
   设计含义：**注入副本是有损的，盘上原文才是无损的**。凡是需要「跨棒还原」的信息，都应当从盘上读，
   而不是从被 `docMaxChars` 砍过的注入副本里递归——后者第二层就断（实测 693 字处）。

7. **防环不能用文本指纹。** 第一版用「长度 + 尾 64 字」当指纹，结果链上相邻两棒的「原始目标」
   长度与尾部**完全一致**（都是同一处截断的嵌套开头），指纹立刻命中 → 只下钻 1 层就停，症状与没修一样。
   改用「读过哪些文档路径」（`seenDocs`，Set of 绝对路径）之后，6 跳一路读到链根。
   设计含义：**要判断「我是否回到过同一个地方」，就得比「地方」，不是比「路过时的风景」**。

### 验证方式与结果

不是桩件，是**真实会话日志回放**（`work/probe-goal-final.mjs`：schemastery import 换成桩、追加内部导出、
喂 zstd 解出的真实事件，调 `collectFacts(session, 40, 4000)`）：

| 会话 | 修复前 | 修复后 |
| --- | --- | --- |
| `session-e6711e9b`（depth 7） | 693 字 / 以 `[自动交接]` 开头 / 清单 0 项 | **1206 字 / 真用户话 / 清单 13 项** |
| `session-5ddd6bb5`（depth 6） | 693 / 是 / 0 | **1206 / 否 / 13** |
| `session-74352d08`（链根） | 1489 / 否 / 13 | 1489 / 否 / 13（本来就对） |

下钻跳数实测：`e6711e9b → 5ddd6bb5 → 6f3c471f → 9ee68a8f → 87b7046c → 138525f5 → 74352d08`，共 6 跳后停。
还原出的目标头部即链根那句：「@AI 流程编排师  @AI 工程师  /wayfinder 请帮我处理一个需求…」。

离线回归测试 `test/goal.test.mjs` 补了 9 条断言（单跳 / 6 层多跳 / 注入副本被截断 / 相邻两棒同形不能误判成环 /
真环 A→B→A 能停 / 文档被删时退回正文 / goalMaxChars 截断 / 端到端生成的文档里该节不含简报壳），
全部测试 5 个文件 50 条断言全绿。

教训（与前几轮同源）：**「这个字段有值」不等于「这个字段是对的」**。`firstUser` 一直有值、一直非空、
一直没有报错——它只是**装着别人家的文档**。凡是「把上游产物当成下游输入」的地方，都要问一句：
这份输入是原话，还是上一跳的转述？

## 2026-11-08 第六轮修订（v1.2.0）

这一轮不是修 bug，是把地图 #12 里四张定稿票（#29 文档结构 / #17 REVIEW / #18 链与并发 / #20 日志与阈值）
一起落地。四条都来自实测，不是设计推演：

1. **文档从「一份」变成「三份」。** 旧实现只有 `<sessionId>.md` 一份，落盘与注入是同一份内容的不同裁剪。
   实测病根不是「字太多」，而是**最贵的内容排在最后、被 6000 字硬截断从尾部砍掉**：
   `## 触及的文件` 一节独占 1611–1856 字符（40 条路径），而 `session-305b0163`（总长 7544）与
   `session-5c7d8966`（总长 7540）的「进度与下一步」只剩 **73 / 77 字符**——新会话拿到的「下一步」是半句话。
   修法：拆成 `index.md`（注入，六节顺序即裁剪优先级，裁剪落节边界）/ `facts.jsonl`（不注入，按需查）/
   `full.md`（人看，八节原样）。结构参照 Claude Code auto memory 的 `MEMORY.md`（索引注入、主题文件按需读）
   与 claude-mem 的三段渐进检索（紧凑索引 ~50–100 token/条 → 时间线 → 全文 ~500–1000 token/条）。
   设计含义：**注入预算是有限的，所以要显式规定「先牺牲谁」**；不能用「整体截断」代替优先级。

2. **REVIEW 的 block 从「不可达」变成真能刹车。** 旧实现 `reviewHandoff` 有六条规则，全是 warn/info，
   `const blocking = items.filter(i => i.level === 'block')` 恒为空——`grep -c "add('block'" lib/index.js` = **0**，
   日志里 `REVIEW block` 0 次、`REVIEW ok` 0 次、`REVIEW warn` 6 次。也就是说「判不通过怎么办」此前**根本没有触发路径**。
   修法：三条 block 规则（没有原始目标 / 摘要里没有可执行的下一步 / 链已到顶）+ 判 block 时不建新会话，
   父会话落 `failed{note:'review-block'}`、标题改名 `[REVIEW 未通过]` 等人工。
   附带一个教训：`no-next-step` **不能只判标题存在**——模型会写 `## 下一步` 然后跟一句「继续」。
   现在看的是 `nextStepSubstance()`（去掉列表符号与空白后的正文长度 < 2 才算没有），阈值定 2 是因为
   先用 5 试过，「1. 跑一遍测试」只有 5 字，会把正常交接全判 block。

3. **链条的可见性。** 实测同 cwd 19 分钟内发生 6 次交接、合计 3,762,211 tokens，6 个父会话全都还活着；
   新开的 7 个 root 会话 header 的 `title` **7/7 全为 null**——人在侧栏看到的是一排一模一样的「新会话」。
   修法：到顶三件事（文档写死「已到第 N/M 棒」+ 标题改名 `[链到顶 N/8]` + 占位 `stopped`），
   并发超限落 `deferred` 并改名 `[排队交接 N/M]`，孤儿会话改名 `[孤儿·无简报]`，
   简报首行加链元信息 `链：第 N 棒 / 上限 M ｜ 根 <root> ｜ 触发 <trigger>（X/Y）｜ 同伴棒：K 个`。
   设计含义：**自动运行的系统必须把状态写在人能看见的地方**（标题、文档、事件），否则出问题时
   唯一的症状是「它好像又开了个会话」。**「看不见」和「没发生」在排障时完全等价。**

4. **阈值从写死变成按窗口比例，同时把读数可信度显式化。** 旧实现 `tokenThreshold=300000`，
   而本机模型窗口实测 1,000,000——等于 30% 就满足。实测交接时窗口占比 p25 45% / p50 66% / max 84%，
   说明**真正把交接推迟到 45–84% 的是「轮末才检查」这个时机，不是阈值**。改成 `tokenThresholdRatio × contextWindow`（默认 0.45）。
   同时 `measureTokens` 从「任何异常 return 0、零留痕」改成返回 `{tokens, reason}`，不可信时写
   `gate/skip` 事件并在 `/handoff-status` 打「⚠️ token 读数不可信」。
   设计含义：**静默降级比报错更危险**——它会让人以为闸门在工作，实际上只剩一半。

5. **日志双轨。** 人读 `.log` 保持可读，机读 `events.jsonl` 九类事件（`gate/skip`、`gate/fire`、`doc/write`、
   `review/verdict`、`session/create`、`prompt/deliver`、`claim/settle`、`chain/limit`、`error`），
   5 MiB 轮转留 5 份。`gate/skip` **每会话首次才记**——旧实现每次工具调用一行，实测 1454 / 1468 行是噪声（98.8%），
   真触发只有 3 次。`claim/settle` 的 done 条目记**闸门实值**（`toolCallCounts.get(id)`）而不是 `facts.toolCalls`
   （历史累计），否则日志里的「N 次工具调用」与判定用的那个数永远对不上，等于没法复盘。

### 一个必须记住的分支顺序约束

`chain-limit` 既是「到顶」的判据，也是三条 block 规则之一。如果 REVIEW block 分支排在链到顶分支前面，
到顶那一棒会先命中 block 落 `failed`（可重试），正确的终态 `stopped` 就**永远不可达**，
`chainLimit` 依旧形同废纸。现在顺序固定为：**链到顶 → REVIEW block → 并发 deferred → 缺 controller 降级**，
并由 `test/integration.test.mjs` 的「链到顶三件事」断言把守（同一次运行里 `created.length === 0` 且占位是 `stopped`）。

教训：**同一个条件被两个分支同时消费时，先命中的那个决定终态**。凡是「终态」与「可重试态」共用一条判据，
都要检查分支顺序，而不是只检查条件本身。
