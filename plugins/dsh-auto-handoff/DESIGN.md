# dsh-auto-handoff · 设计方案

> 状态：v1（2026-11-06）
> 对应需求：`REQUIREMENTS.md`
> 对应源码：`lib/index.js`（1360 行，2026-11-08 实测 `wc -l`）

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
  ├─ 2. measureTokens(ctx, session)          token 压力（失败返回 0）
  ├─ 3. collectFacts(session, maxFiles)      从日志抽事实
  ├─ 4. resolveTitle(ctx, session)           会话标题
  ├─ 5. chainFor(sessionId)                  读链深度（优先 claims.json，回退 state.json）
  ├─ 6. requestModelSummary(...)             模型摘要（失败→undefined）
  ├─ 7. renderDoc(...) + clampText(docMaxChars)
  ├─ 8. mkdir + writeFile(docPath)
  ├─ 9. if (depth > chainLimit) return       只写文档，不续作
  ├─ 10. sessionController.create({cwd, agentPreset})
  ├─ 11. sessionController.prompt({mode:'queue', 文档全文})
  └─ 12. 更新 claims.json（prompt 之前先写 inflight，失败写 failed）
```

### 4.1 事实抽取（`collectFacts`）

只读日志，不重放、不执行任何工具：

| 事实 | 来源 | 用途 |
| --- | --- | --- |
| `firstUser` | 第一条 `user/message` | 原始目标 |
| `recentUsers` | 最后两条 `user/message` | 校准方向 |
| `recentAssistant` | 最后两条 `assistant/message` | 校准进度 |
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
| `tokenMeter` | `measureTokens` try/catch | 返回 0，靠工具计数 | — |
| `sessionController` | `performHandoff` 早退 | 只写文档 + 撤回占位 | AC-7 |
| `llm` | `requestModelSummary` 早退 | 本地兜底摘要 | AC-4 |
| 模型摘要超时 | `AbortSignal.timeout` | 本地兜底摘要 | — |
| 模型摘要抛错 | try/catch | 本地兜底摘要 | — |
| 摘要空串 | `text === ''` | 本地兜底摘要 | — |
| `sessionTitle` | try/catch | `会话 <id 前8位>` | — |
| `workingDirectory` | try/catch | `header.cwd` → `process.cwd()` | — |
| 链深度超限 | `depth > chainLimit` | 只写文档 | AC-5 |
| 任何监听器异常 | 最外层 try/catch | `logWarn` 吞掉 | AC-7 |

---

## 7. 配置设计

12 个配置项，全部有默认值，全部可经 schemastery schema 校验：

| 键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；false 时不注册任何监听 |
| `tokenThreshold` | int ≥1000 | `300000` | token 压力阈值 |
| `toolCallThreshold` | int ≥5 | `80` | 工具调用阈值 |
| `handoffDir` | string | `.dsh/handoff` | 文档目录（相对 cwd） |
| `modelSummary` | boolean | `true` | 是否用模型写摘要 |
| `chainLimit` | int ≥1 | `8` | 续作链深度上限 |
| `summaryMaxChars` | num ≥400 | `1600` | 摘要字符上限 |
| `docMaxChars` | num ≥1000 | `6000` | 文档字符上限 |
| `summaryTimeoutMs` | num ≥5000 | `45000` | 摘要超时 |
| `maxTrackedFiles` | int ≥1 | `40` | 文件列表上限 |
| `summaryProvider` | string | `''` | 摘要 provider（空=自动） |
| `summaryModel` | string | `''` | 摘要 model（空=自动） |
| `enforceMidTurn` | boolean | `true` | 轮中硬兜底开关 |

---

## 8. 测试设计

### 8.1 为什么要在临时目录重写 import

插件 `import z from '@deepseek-ai/schemastery'`。在宿主进程里能解析，但测试从工作区裸跑 Node 解析不到。

**不采用**往包目录塞 `node_modules` 的方案——那会污染宿主对 schemastery 的真实解析。

**采用**：复制源码到临时目录，只把那一行 import 替换成 `globalThis.__SCHEMASTERY_STUB__`，用简易链式桩替代 schema DSL。测试跑的是真实实现（除 schema 定义外）。

### 8.2 测试隔离的关键点

链账本在 `~/.dsh/auto-handoff/`，测试必须把 `USERPROFILE` 指向临时目录，否则会读写真实账本、互相污染。

**这个修复曾经丢失过**，导致 `chainDepth` 用例假失败（写到了工作区却读用户主目录）。恢复记录见 `ISSUES.md` I-2。

### 8.3 13 条用例

`test/integration.test.mjs`（8 条，轮末闸）：
AC-1 ~ AC-8，见 `REQUIREMENTS.md §6`。

`test/midturn.test.mjs`（4 条，轮中闸）：
AC-10 ~ AC-13。核心是**只灌 `session/event`、完全不发 `turn-stopping`**，模拟"这一轮永远不结束、模型完全不理规则"。

---

## 9. 已知边界（必须让后续维护者知道）

| 边界 | 原因 | 后果 |
| --- | --- | --- |
| 不 cancel 旧会话 | 取消用户正在跑的任务风险更大 | "接力棒递出去了"，但旧会话若仍在跑照样烧 token |
| 纯对话轮无工具时轮中闸无效 | 没有 `tool/call` 可计数 | 只能靠轮末 token 闸 |
| 进程重启后工具计数清零 | 内存 Map | 该会话的轮中闸失效，轮末闸仍有效 |
| 不解决缓存失效 | 属另一故障域 | 见 `REQUIREMENTS.md §1.4` |
| 子代理会话不统计 | `origin === 'subagent'` 跳过 | 子代理的消耗不受本插件管 |

---

## 10. 后续演进建议

按收益排序：

1. **加结构化日志**（`handoff/trigger`、`handoff/skip`、`handoff/done`），供后续用真实使用数据定阈值。见 `ISSUES.md` 待办。
2. **启用 `compaction-basic`**，与换会话互补，解决窗口上限。
3. **缓存命中率观测**（只观测不动作），验证 §1.2 的假设。
4. **整合"压缩 + 归档 + 开新会话"**为一个可配置流水线。
5. **审核环节**：新会话首轮对上一棒做"需求核对 + 发散提问"，见用户 4 条优先级中的第 3 条后半。

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
