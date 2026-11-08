# dsh-auto-handoff · 长会话自动交接

一个针对「长会话把上下文和额度吃光」这个问题的 DeepSeek Harness 插件。

它做的事只有一件：**改会话边界，而不是压缩历史**。

## 四阶段流水线

| 阶段 | 做什么 | 代码位置 | 稳定性判据 |
| --- | --- | --- | --- |
| ① 检测与强制执行 | token / 工具调用双阈值，轮中硬兜底 + 轮末兜底，任一命中即交接 | `ctx.on('session/event')` 里的 `tool/call` 分支、`ctx.on('agent/turn-stopping')` | 真实长会话里不误触发、不重复触发、不漏触发 |
| ② 记忆与归档 | 抽事实 → 写**三段式产物**：`index.md`（注入）+ `facts.jsonl`（机读）+ `full.md`（人看） | `collectFacts` → `renderIndex`/`renderFacts`/`renderDoc` | index 六节齐全、「下一步」在第二节且非空；facts 每行可 parse；注入里没有宿主注入与伪路径 |
| ③ 交接前 REVIEW | 开新会话**之前**用确定性规则自检这一棒能不能用，结论写进文档、简报首行与 facts | `reviewHandoff` → `renderReview` | 三条 block 规则真能拦住（no-goal / no-next-step / chain-limit）；不是模型审（会漂移、要等 30–60 秒） |
| ④ 开新会话续作 | `sessionController.create` 建同 cwd 新会话 → `prompt` 投递简报 → 记账 → 取消父会话当前轮 | `performHandoff` | 简报首行是「链：第 N 棒 / 上限 M」；新会话能再交接（genesis 而非 done）；到顶与并发超限都看得见 |

## 为什么值得存在（它补的是空白）

横评 Claude Code / Codex CLI / Cline / Aider / claude-mem / Letta / mem0 / LangGraph 后的结论：
**前三段各家都有成熟做法，第四段（换会话续作）整列是空白**。
压缩（`/compact`、auto-compact）保留同一会话，缓存前缀被重写、整段重新计费；
换会话是清零，代价是「简报必须足够好」。两者互补，不该二选一——本插件补的是后者。
## 触发条件

任一命中即交接：

| 条件 | 默认值 | 配置键 |
| --- | --- | --- |
| 会话 token 压力占模型窗口的比例 | 0.45（1M 窗口 ≈ 450,000） | `tokenThresholdRatio` |
| 会话 token 压力绝对值 | `0`（= 走比例） | `tokenThreshold` |
| 会话工具调用次数 | 80 | `toolCallThreshold` |

写死绝对值会在窗口变化后失效：同一份配置在 200K 窗口上永远不触发、在 1M 窗口上又偏早。
比例从 `session.requestContext().contextWindow` 取；取不到时按 1,000,000 兜底并在 `/handoff-status` 明确告警。

两个检查点：

- **轮中硬兜底**（`enforceMidTurn: true`）：`tool/call` 累计过线就地触发，不等本轮结束。
- **轮末兜底**：`agent/turn-stopping` 时再判一次，覆盖「工具调用没超但 token 超了」的情况。

两条路径共用同一份**落盘占位**（`claims.json`），所以不会同一轮触发两次。

## 交接产物长什么样

v1.2 起每会话一个目录：`<工作目录>/.dsh/handoff/<sessionId>/`。

| 文件 | 给谁看 | 说明 |
| --- | --- | --- |
| `index.md` | 新会话（注入） | 六节，**顺序即裁剪优先级**；frontmatter 十一键 |
| `facts.jsonl` | 机器（不注入） | 一行一 JSON，`{id,type,at,text,ref}`，type ∈ user/assistant/file/tool/error/decision |
| `full.md` | 人 | 完整七节，用来核对简报被裁掉了什么 |

`index.md` 的六节与预算：

| 顺序 | 小节 | 预算 | 必留 |
| --- | --- | --- | --- |
| 1 | `## 目标` | 600 | 是 |
| 2 | `## 下一步` | 1200 | 是 |
| 3 | `## 约束与禁区` | 500 | 否 |
| 4 | `## 未决问题` | 400 | 否 |
| 5 | `## 交接前 REVIEW` | 400 | 否 |
| 6 | `## 档案索引` | 300 | 否 |

裁剪**落在节边界**，不切半句；超 `briefTargetChars` 时从最末一个非必留小节往前丢，丢了会在文末写出
「（预算不足，以下小节请到完整文档查：…）」；超 `briefMaxChars` 才硬切。旧实现按 6000 字从尾部一刀切，
实测把最贵的 `## 触及的文件`（40 条路径、1611–1856 字）留在前面，而「进度与下一步」只剩 73–77 字。

`full.md` 的七节：

- **原始目标** —— 会话最早那条真实用户指令。**不是**首条 `user/message` 的原文：
  链上每一棒的首条消息都是上一棒注入的整份简报，直接抄会层层嵌套（ISSUES I-14）。
  现在由 `unwrapGoal` 顺着简报首行的「已把进度写入 `<path>`」**读盘**一跳一跳回到链根
- **最近的用户指令 / 最近的助手输出** —— 用最近两轮校准方向。助手输出按 `text` → `reasoning` → `（调用工具：…）` 递减取值：
  当前 provider 的助手消息常常只有 reasoning + tool-call 块，只认 `text` 会恒为空（ISSUES I-13）
- **触及的文件** —— 从工具参数里抽出来、并且**在磁盘上真的存在**的路径
- **工具轨迹** —— 每个工具被调用了多少次
- **进度与下一步** —— 模型摘要（`modelSummary: true`），或零成本本地兜底。**排在文档前部**，
  因为它最要紧，而注入副本会按字数上限截断（v1.1 的 `docMaxChars`，v1.2 起是 `briefMaxChars`）、排在后面的先被砍
- **交接前 REVIEW** —— 这一棒交出去会缺什么，逐条标注 ⛔ / ⚠️ / ℹ️

### 落盘与注入是两份长度

盘上的 `full.md` 写全文（上限 `max(briefMaxChars × 4, 40000)` 字），注入新会话的是 `index.md`，
按 `briefTargetChars`/`briefMaxChars` 裁。旧实现用同一份裁剪结果两处复用，结果排最后的「进度与下一步」
被整段砍掉——全篇最有用的部分反而最先丢。

### 事实采集的三条硬规矩

1. **宿主注入不是用户指令。** 主判据是 `data.source.kind === 'user'`（宿主自己标了来源），
   十项前缀白名单（`INJECTED_PREFIXES`）只作兜底。实测前景：真用户轮白名单误杀 0，注入轮**漏 42 条**
   （ptc-mode / agent-message-relay / subagent-settled / model-selection / repeat-tool-reminder / user-approval）。
2. **路径必须真实存在。** 只保留 `statSync` 能读到的路径，文件排在目录前；全部不存在时退回原列表，
   避免把「文件被删了」误报成「没识别到文件」。
3. **路径可能藏在代码正文里。** `run_code` / `bash` 这类工具的路径在 `arguments.code` 里，
   只按白名单键（`file_path`/`path`）抓会全军覆没。
### 摘要的四道截断闸，缺一道「下一步」就没了

「下一步」是被四条独立的截断来源轮流砍掉的，2026-11-08 才全部堵上：

| # | 位置 | 现象 | 修法 |
| --- | --- | --- | --- |
| 1 | `requestModelSummary` 的 `clampText(summaryMaxChars)` | 摘要 1600 字一刀切，第三节整节消失 | 先按节重排（`orderSummary`）把「下一步」提到最前，再裁剪 |
| 2 | `renderDoc` 把摘要放在文档最末 | 注入副本按字数上限截断（旧名 `docMaxChars`），先砍到它 | 摘要在文档里前移，紧跟标题 |
| 3 | 模型漏写「下一步」 | 模型自觉不可靠 | `ensureNextStep` 用本地兜底补一节 |
| 4 | `maxTokens: 1200` 输出预算 | **生成到一半就断**，句子没写完 | `summaryTokenBudget` 按字数折算（默认 3600） |

前三条靠读代码就能发现，第四条只有在**真实宿主里跑 e2e** 才暴露——离线测试的假 llm 一次吐出整段文本，永远不受输出预算限制。

## 交接前 REVIEW 判什么

| 检查项 | 级别 | 为什么要有 |
| --- | --- | --- |
| 规则 | 级别 | 可配置 | 为什么要有 |
| --- | --- | --- | --- |
| `no-goal` 没有捕获到原始目标 | **⛔ block** | 是 | 新会话不知道要干什么，交出去等于放飞 |
| `no-next-step` 摘要里没有可执行的「下一步」 | **⛔ block** | 是 | 新会话只能从头猜；判的是**实质字符数**，一句「继续」不算 |
| `chain-limit` 自动续作已到第 N/M 棒 | **⛔ block** | 是 | 再交也是白交，该人工介入 |
| 没有识别到任何触及的文件 | ⚠️ | 否 | 新会话没有锚点，只能靠文字复述找现场 |
| 工具报错占比 > `toolErrorWarnRatio`(0.2) | ⚠️ | 是 | 先确认是已解决还是被绕过，别把失败的当成完成 |
| 待办清单还有未勾选项 | ⚠️ | 否 | 长任务最常见的坑：清单没勾就换棒 |
| 没有捕获到助手输出 | ⚠️ | 否 | 缺少「已经做到哪」的判断依据 |
| 交接链剩余棒数 ≤ 1 | ⚠️ | 否 | 再往下就停 |

结论四档语义：`ok` / `warn`（照常交接，warn 项进简报首行）/ `block`（**不建新会话**，父会话落
`failed{note:'review-block'}`、标题改成 `[REVIEW 未通过]`，等人工 `/handoff`）。
三条 block 规则由 `reviewBlockOn` 配置，也可以全关。

> 2026-11-08 之前的实现里 `block` **在数学上不可达**（`grep -c "add('block'"` = 0，日志 6 次 REVIEW 全是 warn），
> 所以「判不通过怎么办」根本没有触发路径。现在有。

## 安全边界

- 交接失败只记日志，**不抛进当前轮**。
- 占位落盘在 `~/.dsh/auto-handoff/claims.json`，**杀进程 / 新会话都仍然有效**；
  旧实现是进程内 `Set`，进程一重启就失效，同一会话被重写 5 次以上、连开 14 个空会话。
- 状态语义：`inflight`（进行中，`claimTtlMs` 内拦住重复派发）/ `done`（已交接）/ `failed`（`retryCooldownMs` 后可重试，`maxAttempts` 用尽后不再自动重试）/ `stopped`（终态）/ `genesis`（新会话首次登记，**还能再交接**）/ `deferred`（同目录并发超限，排队而非失败，`deferredUntil` 后自动重试）。
- `maxAutoHops`（默认 8，旧名 `chainLimit` 仍认）限制自动续作链深度。到顶三件事同时做：
  文档 `## 未决问题` 写死「自动续作已到第 N/M 棒，需人工 /handoff」、会话标题改成 `[链到顶 N/8] <原标题>`、
  占位落 `stopped{stoppedReason:'chain-limit'}` + `chains/<root>.json` 标 `stopped:true`。
- `maxConcurrentHops`（默认 2）限制同 cwd 同时几棒在跑；超限落 `deferred` 并把标题改成 `[排队交接 N/M]`。
- 简报投递失败留下的空壳子会话记进 `chains/<root>.json` 的 `orphans[]` 并改名 `[孤儿·无简报]`，**不 cancel**（它可能已经开始干活了）。
- 抽事实只读会话日志，不重放、不执行任何工具。
- 日志双轨：人读 `~/.dsh/auto-handoff/auto-handoff.log`（超 1 MB 轮转一份 `.1.log`）；
  机读 `~/.dsh/auto-handoff/events.jsonl`（一行一 JSON，9 类事件，5 MiB 轮转留 5 份）。
  `gate/skip` 每会话**首次才记**——旧实现每次工具调用一行，实测 1454 / 1468 行是噪声（98.8%）。
- 链账本 `~/.dsh/auto-handoff/chains/<root>.json`：`{root,cwd,startedAt,limit,hops[],orphans[],stopped}`，
  只记完成的棒，冷热路径分离（每轮闸门读的是 `claims.json`，不碰它）。

## 手动触发

```
/handoff          # 立即交接（人工强制，跳过冷却与次数限制，但不打断进行中的那一次）
/handoff-status   # 只看当前会话离阈值还有多远，不触发任何动作
```
## 配置

在 profile 的 `cordis.patch.yml` 里改（默认值见 `lib/index.js` 的 `DEFAULTS`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册任何监听，只保留 `/handoff-status` |
| `tokenThreshold` | `0` | token 压力**绝对值**；填非 0 则优先于比例并打 warn |
| `tokenThresholdRatio` | `0.45` | 按 `requestContext().contextWindow` 的比例触发；窗口读不到按 1,000,000 兜底并告警 |
| `toolCallThreshold` | `80` | 工具调用次数阈值；不依赖任何可选服务 |
| `enforceMidTurn` | `true` | 轮中硬兜底，过线就地交接，不等本轮结束 |
| `handoffDir` | `.dsh/handoff` | 相对会话 cwd 的交接文档目录 |
| `maxAutoHops` | `8` | 自动续作链最大棒数（旧名 `chainLimit`），超限只写文档并可见地停住 |
| `maxConcurrentHops` | `2` | 同 cwd 同时最多几棒在跑，超限落 `deferred` 排队 |
| `concurrentWindowMs` | `1800000` | 排队多久后自动重试（毫秒） |
| `modelSummary` | `true` | 是否让模型写「进度与下一步」；失败自动降级到本地兜底 |
| `summaryProvider` / `summaryModel` | `''` | 摘要用的模型；空则用宿主默认路由 |
| `summaryMaxChars` | `1600` | 模型摘要字数上限 |
| `summaryTimeoutMs` | `45000` | 摘要超时，超时即降级 |
| `briefMaxChars` | `6000` | 注入新会话的 `index.md` 硬上限 |
| `briefTargetChars` | `3000` | `index.md` 目标长度，超了从最末非必留小节往前丢 |
| `goalMaxChars` | `4000` | 「原始目标」一节的字符上限。比 `summaryMaxChars` 大得多是刻意的：它要装得下**链根**那句用户原话（含验收清单） |
| `maxTrackedFiles` | `40` | 「触及的文件」最多记几个 |
| `claimTtlMs` | `86400000` | 占位有效期，超时视为上一次交接已死 |
| `retryCooldownMs` | `600000` | 失败后多久才允许重试 |
| `maxAttempts` | `3` | 同一会话最多自动尝试几次，用尽后停止自动重试 |
| `cancelParentAfterHandoff` | `true` | 交接成功后取消父会话当前轮（保留未处理队列）。关掉它就退回「不打扰旧会话」，但父会话会和子会话同时烧 token。手动 `/handoff` 永远不取消 |
| `modelReview` | `false` | L2 模型审：多一次模型调用，只提醒不刹车。默认关（L1 已能真刹车） |
| `reviewBlockOn` | `['no-goal','no-next-step','chain-limit']` | 哪些 L1 规则判 block |
| `toolErrorWarnRatio` | `0.2` | 工具报错占比超过它就 warn |

## 依赖的宿主服务

| 服务 | 必需性 | 缺失时的行为 |
| --- | --- | --- |
| `sessions` | 必需（`inject` 声明） | 插件不加载 |
| `commands` | 必需（`inject` 声明） | 插件不加载 |
| `sessionController` | 可选 | 只写交接文档，不建新会话（`state: stopped`） |
| `tokenMeter` | 可选 | token 闸失效 → 只剩工具调用闸。**v1.2 起会显式告警**（旧实现静默 `return 0`） |
| `llm` | 可选 | 摘要降级为本地兜底 |

## 交接时到底发生了什么

1. 阈值命中 → `reserveClaim` 抢落盘占位（抢不到直接返回，这是唯一的去重点）。
2. `resolveSessionCwd` 定位工作目录 → `measureTokens` + 工具调用计数。
3. `collectFacts` 抽事实：过滤宿主注入、抽路径并校验存在性、统计工具轨迹与报错数。
4. `reviewHandoff` 自检 → 渲染 `index.md`/`facts.jsonl`/`full.md` → **三份都落盘**。
5. `chainFor` 读链深 → 超 `maxAutoHops` 就停在这里（落 `stopped` + 改名 + 事件）。
   → 紧接着 REVIEW `block` 分支（**顺序不能反**：chain-limit 本身是 block 规则之一，block 先命中会落 failed，到顶的 stopped 就永远不可达）
   → 再判同 cwd 并发（超限落 `deferred`）。
6. `controller.create` 建同 cwd 新会话（preset 取会话事件里最后一次 `agent-preset/selected`）。
7. `controller.prompt(request, signal)` 投递简报（**必须传 AbortSignal**，宿主第一行就是 `signal.throwIfAborted()`）。
   简报第一行是链元信息：`链：第 N 棒 / 上限 M ｜ 根 <root> ｜ 触发 <trigger>（X tokens / Y calls）｜ 同伴棒：K 个`。
8. 取消父会话当前轮：`sessionController.cancel({ sessionId })`。宿主实现是 `agent.cancel({kind:'user'},{keepInbox:true})`，
   只停当前那一轮、不丢队列；父会话已经自然结束时会抛 `session/not-found`，按正常情况处理。
   **父会话不会因为交接自己停下**——实测它能继续跑 70 分钟，和子会话一起烧 token，这一步就是治它的。
9. 记账：父会话写 `done`（终态，保证这一棒只交一次），新开的一棒写 `genesis`（链深已登记、还能再交接）；失败写 `failed` + 原因，等冷却后重试；同 cwd 并发超限写 `deferred`（非终态，`deferredUntil` 后自动重试）；到 `maxAutoHops` 那一棒写 `stopped`。

## 已知边界

- **改代码不会自动生效，但通常不用人重启。** Node ESM 有模块缓存，光改文件不会进运行中的宿主；
  DSH 自带 `dsh-hmr`，它监听 profile 的 `package.json` 与 `cordis.patch.yml`，改动即触发一次
  profile 重组（recomposition），把「被改动过的 linked 包」整体换掉。本插件正是 profile 里的
  `link:` 包，所以改完只要碰一下这两个文件之一，就会在数秒内生效（实测 3 秒）。
  最轻量的做法是往 profile 的 `cordis.patch.yml` 末尾加一行注释，改前先备份。
  判据不要用文件 mtime，用日志：`auto-handoff.log` 里出现新格式行（带 `[sessionId]` 前缀）
  或新一条「已启用：…交接目录 .dsh/handoff…」，即说明新模块已加载。
  `node tools/handoff-check.mjs` 的「代码版本」一项就是按这个判据算的。
- `tokenMeter.measure()` 返回的是估算值（“请求+响应压力”，不是单次 usage 也不是累计账单），
  插件侧**无法离线复算**。所以比例阈值只是「按同一把尺子量」的做法，不代表精确窗口占用。
  实测 6 份会话的 `logged` / `textChars/4` / `Σ(in+out)` / `Σtotal` 四种算法两两都对不上。
- 「下一步」与「最近的用户指令」在信息上有重叠——v1.2 起两者落在**不同文件**（前者进 index.md，
  后者进 full.md 与 facts.jsonl），不再互相挤占预算。
- **摘要按节裁剪，不是一刀切。** 模型把「下一步」写在第三节，旧实现 `clamp(1600)` 直接从尾部砍，
  实测 8 份真实文档里 4 份整节丢掉「下一步」。现在 `orderSummary` 先把含「下一步」的那节提到最前再裁剪，
  模型漏写时 `ensureNextStep` 用本地兜底补一节；文档里「进度与下一步」也移到了注入副本靠前的位置
  （注入副本按字数上限截断，排最后的最先被砍）。
- **摘要输出预算跟着字数走。** `maxTokens` 旧值写死 1200，而中文 1600 字要 2400–3200 token，
  模型会在第三节中途被截断——「下一步」只剩半句。现在由 `summaryTokenBudget` 按字数折算（默认 3600）。
  这一条**离线测试测不出来**：假 llm 一次吐出整段文本，不受输出预算限制。
- 已交接（`done`/`stopped`）的会话若继续产生工具调用，只记**一条**证据行并清掉它的内存计数，
  不再逐个调用刷「占位拦下」。这行日志本身就是证据：父会话仍在跑。
- **「暂时抢不到占位」不等于「以后都不管」。** `inflight`（另一棒正在交接）、`cooldown`、`次数用尽`
  都是**暂时**状态，占位放开后本会话必须还能再触发。v1.1.2 之前轮中闸无论什么原因抢占位失败都
  `midTurnFired.add(id)`，等于把「暂时」当「永久」——链条会静默停摆，日志却一切正常（ISSUES I-12）。
  现在 `midTurnFired` 只表示「这一棒已交接」，日志去重另有 `blockedNoted`，两者不共用。
- 只支持 root 会话；`header.origin === 'subagent'` 一律跳过。

## 测试

```
cd D:/proj/PC1/plugins/dsh-auto-handoff
node --check lib/index.js
# 注意：node --test test/ 这种「目录形式」在 Node 24 上会 MODULE_NOT_FOUND，必须写 glob
node --test test/*.test.mjs       # 一次跑全部 6 个文件，共 71 条断言
node test/integration.test.mjs   # 23 个场景（含链到顶三件事 / REVIEW block / 并发 deferred / 孤儿 / 比例阈值 / 事件字段）
node test/midturn.test.mjs       # 7 个场景
node test/chain.test.mjs         # 8 个场景
node test/claims.test.mjs        # 10 个场景
node test/docs.test.mjs          # 14 个场景（index 六节顺序与裁剪 / facts 机读 / 简报元信息往返）
node test/goal.test.mjs          # 9 个场景（「原始目标」还原）
# 合计 71 条断言
```

### 假件必须比真件严格，否则测试全绿也没用

真宿主里踩过的三个坑，离线测试一次都没拦住，原因都是**假件比真件宽松**：

| 契约 | 真宿主 | 旧假件 | 后果 |
| --- | --- | --- | --- |
| `controller.prompt(request, signal)` | 第一行 `signal.throwIfAborted()` | 单参数、永不抛 | 简报 0/86 送达 |
| `controller.create()` | 一定返回 `{sessionId}` | 可能返回空 | 空壳会话疯涨 |
| `llm.stream({maxTokens})` | 真按预算截断 | 一次吐出整段 | 「下一步」半句就断 |
| `z.array()` 存在 | schemastery 有 | 桩里没有 → `TypeError` | 配置校验整个挂掉、插件不加载 |

所以：**凡是对接宿主能力的参数（signal、token 预算、超时），假件必须同样严格地行使它**。
只证明代码逻辑是不够的，还需要一条在真宿主里跑的 e2e（见 `work/e2e-handoff` 的探针做法）。

## 源码位置

**唯一权威源码目录：`D:\proj\PC1\plugins\dsh-auto-handoff`**，随 `dongopencv/tools` 仓库一起版本控制。
改代码只改这里，不要在别处留第二份。

| 路径 | 角色 |
| --- | --- |
| `D:\proj\PC1\plugins\dsh-auto-handoff` | 唯一权威源码（进 git） |
| `D:\tools\dsh-auto-handoff` | 过渡期的**运行副本**，profile 的 `link:` 仍指向它；切换完成后可删 |

### 为什么 profile 还指着 `D:\tools`

四份 profile（`desktop` / `zz-audit` / `zz-caps` / `zz-desktop-probe`）的 `package.json` 都写着
`"dsh-auto-handoff": "link:D:/tools/dsh-auto-handoff"`，`desktop` 的 `pnpm-lock.yaml` 又把同一行固化在 26–28 行。
改 profile 必须连 lockfile 一起改，而本机没有 pnpm，改完没法用 `pnpm install` 重建 `node_modules` 符号链接。
所以分两段：先在仓库里立住权威源码（已完成），再一次性切 `link:`。切换本身不用等重启——
改 profile 的 `package.json` 正好就是 `dsh-hmr` 监听的输入，改完触发一次 profile 重组即可（见上节「已知边界」）。

### 切换清单（一次性）

1. 四份 profile 的 `package.json` 依赖行改为 `"dsh-auto-handoff": "link:D:/proj/PC1/plugins/dsh-auto-handoff"`。
2. `~/.dsh/profiles/desktop/pnpm-lock.yaml` 的 26–28 行（`specifier` 与 `version` 两处）。
3. 重建 `node_modules/dsh-auto-handoff` 链接：用 `cmd /c mklink /D`，**不要 `ln -s`**
   （本机 `ln -s` 在 `node_modules` 里建出的是 junction，`readlink` 不可用、`rm` 也删不掉，只能 `rmdir`）。
4. 跑 `node tools/handoff-check.mjs --deep` 确认「代码版本」这一项通过；没过就看
   `~/.dsh/auto-handoff/auto-handoff.log` 有没有新的「已启用」行（没有说明重组没触发）。

不触发重载也能单独验证链接与 peer 依赖：

```bash
cd /c/Users/Admin/.dsh/profiles/desktop
node --preserve-symlinks -e "import('dsh-auto-handoff').then(m=>console.log(Object.keys(m)))"
# 能列出 Config/DEFAULTS/apply/inject 即正常；报 Cannot find package '@deepseek-ai/schemastery' 说明少了 --preserve-symlinks
```

## 卸载

从 profile 的 `package.json` 依赖与 `bundles` 数组里删掉 `dsh-auto-handoff`，再删 `~/.dsh/auto-handoff/`
（`claims.json` / `auto-handoff.log` / `state.json`）与各项目下的 `.dsh/handoff/`。