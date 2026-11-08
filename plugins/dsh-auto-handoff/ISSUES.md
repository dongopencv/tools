# dsh-auto-handoff · 问题清单（需要修复的问题）

> 状态：v1（2026-11-06）
> 分三类：**I = 已修复的历史缺陷**、**O = 当前仍存在的开放问题**、**R = 风险（见 RISKS.md）**

---

## A. 已修复（I 系列）

### I-1 `enforceMidTurn` 配置读取丢失 —— 轮中硬兜底完全失效 【严重·已修复】

**发现于**：2026-11-06 恢复源码后跑测试，`test/midturn.test.mjs` 第一条用例失败。

**症状**：`created=0`，轮中触发一次都没有执行。

**根因**：`resolveOptions()` 里漏了 `enforceMidTurn` 的读取。

```js
// 修复前：Config 里声明了、触发代码引用了，但 resolveOptions 没传出来
return {
  ...
  summaryModel: readText(raw.summaryModel, DEFAULTS.summaryModel),
  // ← 缺 enforceMidTurn
}

// 触发代码
if (options.enforceMidTurn === true && ...)  // 永远是 undefined，永不成立
```

**危害**：这是**双闸里的第二道闸**。它失效意味着：只要某一轮跑得久（批量任务连续调用几百次工具），`turn-stopping` 迟迟不来，阈值早就超了却什么都不发生——正是用户担心的"规则不触发"场景原样复现。

**修复**：

```js
enforceMidTurn: readBool(raw.enforceMidTurn, DEFAULTS.enforceMidTurn),
```

**验证**：`test/midturn.test.mjs` 4/4 通过。

**教训**：这个 bug 是"三处不一致"造成的——`Config` 声明、`DEFAULTS` 定义、`resolveOptions` 读取，三处必须同步。恢复源码时手工拼装极易漏掉中间一环。

---

### I-2 测试链账本路径未隔离 【中·已修复】

**发现于**：同上，`test/integration.test.mjs` 链上限用例失败（`1 !== 0`）。

**症状**：`chainDepth: 8` 的测试数据写进了 `<tmp>/.dsh/handoff/state.json`，而插件从 `~/.dsh/auto-handoff/state.json` 读，读不到，于是照常开新会话。

**根因**：测试还在用旧路径（工作区），代码已外移到用户主目录。

**修复**：测试里加 `USERPROFILE` 指向临时目录，两处（写、读）路径统一到 `.dsh/auto-handoff/state.json`，并在用例结束时恢复环境变量。

**教训**：磁盘状态位置变更时，必须同步更新所有测试夹具。

---

### I-3 新会话未继承 `agentPreset` 【中·已修复】

**症状**：新会话工具集可能与源会话不同，交接文档里写的"用 X 工具继续"落空。

**修复**：读 `session.header.agentPreset`，传给 `controller.create()`。

**验证**：AC-8。

---

### I-4 摘要拿不到模型路由 【中·已修复】

**症状**：`requestContext()` 返回 `undefined` 时直接走本地兜底，用户配了 `modelSummary: true` 却看不到模型摘要。

**修复**：`resolveSummaryRoute()` 五级回退（配置 → requestContext → requestHeader → agentDefaultModel → 末条 assistant source）。

---

### I-5 链账本污染工作区仓库 【中·已修复】

**症状**：`state.json` 原本写在 `<cwd>/.dsh/handoff/`，会被用户 `git add` 带走。

**修复**：外移到 `~/.dsh/auto-handoff/state.json`。

---

### I-6 交接阻塞关轮 【高·已修复】

**症状**：初版把 `turn-stopping` 监听器写成 `async` 并 `await` 摘要（超时 45s），宿主等 45 秒才关轮。

**修复**：同步判定 + 同步占位 + `void (async () => {})()` 后台执行，不 await。

---

### I-7 源文件搬运丢失 【严重·已发生，用户已恢复】

**经过**：11-05 13:30 前后，当年那台机器上的插件目录被清空、另一份目录建成但为空，profile 里的依赖行与符号链接同时消失。全盘 `*handoff*` 的 `.js`/`.mjs` 一度为零。当时那个盘位（`D:\PC0`，本机现已不存在）不是 git 仓库，无提交可回滚。

**现状（2026-11-08 收口）**：源码已迁到 `D:\proj\PC1\plugins\dsh-auto-handoff`，纳入 `dongopencv/tools` 仓库（git 提交 + 远端），I-7 的「丢失无法回滚」这一半已经消除。迁移步骤与验证见 README「源码位置」。

**残留问题**：无（原 O-1 / O-2 / O-3 已关闭，见下）。

**教训**：
1. 长期维护项目的源码目录**必须**纳入版本控制。
2. 迁移目录时应 `git mv` 或先复制再删除，不能"先删后建"。

---

### I-8 「下一步」被两级 clamp 整节砍掉 【严重·已修复 2026-11-08】

**现象**：随机抽 8 份真实交接文档，**4 份没有 `## 下一步` 这一节**——交接的核心产物丢了，新会话拿到的是"没有方向的进度报告"。

**根因（两级叠加）**：
1. `requestModelSummary` 末尾 `clampText(parts.join(''), options.summaryMaxChars=1600)`。`buildSummaryPrompt` 要求模型输出的三节顺序是 进度概述 → 关键决定与坑 → **下一步**，所以「下一步」永远在字符串末尾，1600 字一刀切必然先砍它。砍完还会补 17 字符标记 `…（已截断）`，故被砍文档的摘要段长度恰好 1617。
2. `renderDoc` 把摘要整段放在文档最末，注入副本按 `docMaxChars=6000` 截断时又先砍它。

**修法**：
- 新增 `splitSummarySections` / `hasNextStep` / `ensureNextStep` / `orderSummary`：按 `## ` 切节，把含「下一步」的节**提到最前**再裁剪；模型漏写时用 `fallbackSummary` 补一节。
- `renderDoc` 段落重排：摘要（`## 进度与下一步`）与 `## 交接前 REVIEW` 提到文档前部，注入副本里它们不再是被砍的那一端。
- 新测试：`long-summary`（1800 字摘要，「下一步」写最后，断言连注入副本都保住关键字）、`no-next-step`（模型只写一节，本地补「下一步」）。

**教训**：任何「先拼接再整体截断」的流水线，都必须显式声明**哪一段可以牺牲**。默认牺牲的永远是最末尾那一段，而最末尾往往正是最要紧的那一段。

---

### I-9 交接后父会话不停，父子同时烧 token 【高·已修复 2026-11-08】

**现象**：`session-74352d08`（depth=0 父会话）在交接 70 分钟后仍以每 30 秒 +11 KB 的速度写盘，末帧解出来是 `step/start turn 7 step 346`——**它活着，并且在烧 token**。子会话 `138525f5` 同时活跃。5 分钟窗口内 5 条会话合计 84 次 tool/call。

**根因**：DESIGN §9 当时写「不 cancel 旧会话」，理由是「取消用户正在跑的任务风险更大」。这个判断在**手工交接**下成立，在**自动交接**下不成立：自动交接的前提就是「这一棒已经跑不动了，接力棒交出去」。

**修法**：新增配置 `cancelParentAfterHandoff`（默认 `true`）。简报送达后调 `sessionController.cancel({ sessionId })`（宿主实现 `agent.cancel({kind:'user'},{keepInbox:true})`，停当前轮、保留队列）。手动 `/handoff` 明确不取消——调用方就是那个会话自己。`session/not-found` 视为父会话已自然结束，记 INFO 继续。

**剩余**：`cancel` 只停当前轮。用户回到旧会话继续打字，它照样会跑（见 RISKS R-37）。

---

### I-10 轮中闸刷屏：926 行 / 95% 的日志是同一条 【中·已修复 2026-11-08】

**现象**：`auto-handoff.log` 926 行里 878 行是 `轮中触发被占位拦下（done），不重复交接`，约每 4 秒一条持续 76 分钟。真交接只有 6 次，全被噪声埋掉。

**根因**：占位是终态 `done` 时，代码仍然为**每一次工具调用**记一行 INFO。终态挡住的只是「再建一个会话」，挡不住「再记一行日志」。叠加「父会话交接后不关」（I-9），一个过线会话只要还在动，就每条调用一行。

**修法**：新增 `terminalSeen` 集合。终态（`done`/`stopped`）命中时只记**一条**证据行
`[sessionId] 已交接（done），但该会话仍在产生工具调用：交接不会关掉父会话。`，
随后 `toolCallCounts.delete(sessionId)` 并静默返回；`inflight`/`cooldown`/次数用尽等真正需要人看的 reason 仍然逐条记。所有日志行加上 `[sessionId]` 前缀（旧日志不含会话 id，无法归因，这是排查时最大的障碍）。

**副产物**：那一条证据行本身成了 I-9 的观测手段——它出现就说明父会话没停。

---

### I-11 摘要被输出预算截断：`maxTokens: 1200` 撑不住 1600 字中文 【严重·已修复 2026-11-08】

**现象**：v1.1.1 修完按节裁剪（I-8）之后，真实宿主里跑出来的「下一步」仍然是**半句话**就断了：

```
## 下一步
1. 先恢复/确认完整 7 条命令及 `step7.txt` 的准确追加内容，尤其第 3-7 条。
2. 逐条调用 bash 执行追加，每条单独一次工具调用，      ← 句子没写完
```

**怎么发现的**：不是读代码看出来的，是**在真实 DSH 宿主里跑 e2e** 才暴露的。离线测试的假 `llm.stream` 一次吐出整段 `modelText`，永远不受输出预算限制——所以 15 条测试全绿，缺陷照样存在。这是本项目第 3 次栽在「假件比真件宽松」上（前两次：`prompt` 少传 signal、`sessionController.create` 不返回 id）。

**根因**：`requestModelSummary` 的 `maxTokens: 1200` 是写死的常数，而 `summaryMaxChars` 默认 1600。中文约 1.5–2 token/字，1600 字要 2400–3200 token。模型写到 1200 token 就被截断，而「下一步」偏偏是最需要展开的一节。

**为什么之前的修法没兜住**：I-8 的 `orderSummary` 把「下一步」提到最前，只能保证它**排在前面**；输出预算不够时，它仍然会被生成到一半。重排序解决「谁被裁剪」，解决不了「模型没写完」。

**修法（三处一起）**：

1. `buildSummaryPrompt` 把三个小节的**顺序改成「下一步」第一**，并明确要求「三个小节都要写，每节不超过 350 字」——让模型先写最要紧的，且总量落在预算内。
2. 新增 `summaryTokenBudget(summaryMaxChars)`：`min(max(ceil(chars*2)+400, 800), 8000)`，`maxTokens` 改为它的返回值。默认 1600 字 → 3600 token。
3. `test/integration.test.mjs` 的假 llm 记录请求参数，新增断言 `maxTokens >= 3200`。

**验证**：同一套 e2e 探针重跑，摘要段 1026 字、四节齐全、无截断标记、「下一步」是完整的可执行命令序列。

**教训**：**离线测试只能证明代码逻辑，不能证明契约**。凡是对接宿主能力的参数（token 预算、超时、signal），必须有一条在真宿主里跑的 e2e，否则「测试全绿 + 现网残缺」会反复发生。

### I-12 「被拦一下」被当成「永远不用管」：链在静默中停摆 【严重·已修复 2026-11-08】

**现象**：v1.1.2 已经加载进现网（HMR 05:18:20.463Z 实测生效），本会话随后又产生了 **118 次工具调用**（阈值 80），却**一次都没有再触发交接**。日志里一条 `轮中触发` 都没有，看上去「很安静、没问题」。

**根因**：轮中闸抢占位失败时，无论失败原因是什么，都无条件执行了 `midTurnFired.add(id)`：

```js
if (!reserved.reserved) {
  midTurnFired.add(id)   // ← 无论 reason 是 done / inflight / cooldown / attempts-exhausted
  logInfo(...)
  return
}
```

`midTurnFired` 的本意是「这一棒已经交接过了，别再重复开」。但它被用成了「这一会话不要再管了」：
- `done` / `stopped` 是**真终态**，确实不该再管；
- 而 `inflight`（另一棒正在交接）、`cooldown`、`attempts-exhausted` 都是**暂时**状态——占位过一会儿就会放开。

一旦把「暂时」写进 `midTurnFired`，放开之后也没有任何代码把它清掉，于是这个会话剩下的整段生命周期都不会再检查一次。**链条停摆，日志全绿**。

**为什么测试没拦住**：原 `midturn.test.mjs` 的每个场景都是「一次触发、一个终态」，没有任何一个场景是「先被拦、后放开、再触发」。这正是**缺少时序**而不是缺少分支。

**修法**：
1. 把「日志去重」和「是否还能再试」彻底分开：新增 `blockedNoted: Set`（键 `sessionId + '|' + reason`），只用于**日志**去重，绝不参与触发判断。
2. 轮中闸的 `!reserved.reserved` 分支删除 `midTurnFired.add(id)`；终态（done/stopped）仍只留一条证据行并 `toolCallCounts.delete(id)`。
3. 抢到占位时 `blockedNoted.clear()`——新一棒开始，旧的去重记录作废。
4. 轮末闸的「阈值已过但占位拦下」同样按 `sessionId + '|turn|' + reason` 去重。

**验证**：`test/midturn.test.mjs` 新增场景 6——预写 `inflight` 占位 → 灌 85 次工具调用（被拦，只应记 1 条日志）→ 占位改为 `genesis` → 再灌 85 次 → 断言**开出了 1 个新会话**、写出了文档。两条断言：`PASS 被 inflight 拦下后，占位一放开仍能交接（不会永久静默）`、`PASS 被占位拦下的日志按「会话+原因」去重，不随工具调用刷屏`。midturn 5 → 7 条，合计 40 条。

**教训**：**「暂时」和「永久」不能共用同一个标志位**。凡是记录「这件事已经处理过」的地方，都要问一句：这件事会不会有第二次机会？会的话，标志就必须带过期或带清零点，否则它就从优化变成了绊索——而且**绊索不会报错，只会安静**。

### I-13 `messageText` 只读 `text` 块：交接文档里「最近的助手输出」恒为空 【严重·已修复 2026-11-08】

**现象**：连续 6 棒交接文档的「## 最近的助手输出」一节要么写「（未捕获）」，要么整节缺失；每次 REVIEW 都带一条 warn『没有捕获到助手输出』。摘要请求里那一段也一直是「（无）」——**新会话唯一一条「上一棒做到哪」的依据就此消失**，只能从「触及的文件」和「下一步」里反推。

**根因（实测，不是推断）**：`messageText()` 只认 `block.type === 'text'`：

```js
if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
```

而当前 provider（`trae-enterprise` / `DeepSeek-V4.1-Flash-1017`）的助手消息**几乎不带 text 块**。解压真实会话日志统计 block 类型：

| 会话 | assistant/message | reasoning | tool-call | text |
| --- | --- | --- | --- | --- |
| `session-5ddd6bb5` | 80 | 71 | 80 | **1** |
| `session-9ee68a8f` | 80 | 71 | 80 | 1 |

一条助手消息的典型形状就是「一段 reasoning + 一个 tool-call」，没有 text。于是 `assistantTexts` 永远是空数组（80 条消息里最多命中 1 条），`recentAssistant` 必然为 `[]`。

**为什么之前的排查方向是错的**：一度怀疑「provider 不给助手输出」。实测证明 provider 给得很足——80 条消息里 71 条有 reasoning 正文，只是**块类型不是 `text`**。问题在解析，不在数据源。

**修法**：
1. 新增 `assistantText(message)`，与 `messageText` 并存（用户消息仍走后者）：优先 `text` 块，没有就退到 `reasoning` / `thinking` 块，末尾追加 `（调用工具：name、name）` 摘要。
2. `collectFacts` 里把「只有工具名、没有一句正文」的消息单独进 `assistantDigests`——它是最后兜底，不能和正文混在一条队列里。
3. 取值改为 `assistantTexts.length > 0 ? assistantTexts : assistantDigests`，再 `slice(-2)`。**有正文时绝不用纯工具名**：交接文档要回答「做到哪」，一串工具名答不了。

**验证**（真实日志回放，非桩件）：探针 `work/probe-facts-real.mjs` 把真实 `lib/index.js` 的 schemastery import 换成桩、追加内部导出，喂真实会话事件：

```
session-5ddd6bb5: toolCalls=80 toolErrors=1 injected=5 files=40  recentAssistant.length=2
  >>> "Now design the fix. Key decision: how to produce ... when assistant messages have only reasoning blocks."
  >>> "Now let's implement the fix. Read the relevant source sections first.\n（调用工具：run_code）"
```

修复前同一份日志 `recentAssistant.length=0`。`node --test test/*.test.mjs` 4/4 全绿。

**遗留取舍**：reasoning 是模型的内部独白，中位数 5000+ 字符，直接塞进交接文档会又长又散（已由 `clampText(…, 1200)` 截断）。目前取「最后 2 条 × 1200 字」。更好的做法是让摘要请求自己提炼，但那要等 O-5 的结构化日志落地后再一起做。

**教训**：**「字段存在」不等于「这个字段会被填充」**。`messageText` 写的时候只想到用户消息（都是 text 块），复用到助手消息上时就静默返回空字符串——不抛错、不报警，只是让一份文档少了一节。凡是把「给 A 用的解析器」拿去解析 B，必须先数一遍 B 的块类型分布。


### I-14 「原始目标」层层嵌套：链深 6 之后文档里装的是上一份文档，不是用户原话 【严重·已修复 2026-11-08】

**现象**：一份 `chain-depth: 6` 的交接文档，「## 原始目标」那一节的开头是
「`[自动交接] 上一会话 session-xxxx 达到阈值（…），已把进度写入 \`D:\\proj\\PC1\\.dsh\\handoff\\session-xxxx.md\`。下面是同一份交接文档的全文…`」
——**不是用户的话，而是上一棒的简报壳**。用户真正那句「@AI 流程编排师 @AI 工程师 /wayfinder 请帮我处理一个需求…」
连同它后面的 13 项 `- [ ]` 验收清单一并消失。

**取证（真实日志回放，不是推断）**：探针 `work/probe-goal-final.mjs` 喂 zstd 解出的真实事件：

| 会话 | 首条 user 长度 | 结果 | 以 `[自动交接]` 开头 | 清单项 |
| --- | --- | --- | --- | --- |
| `session-e6711e9b`（depth 7） | 6013 | **693 字** | 是 | **0** |
| `session-5ddd6bb5`（depth 6） | 6013 | 693 | 是 | 0 |
| `session-74352d08`（链根） | 1489 | 1489 | 否 | 13 |

**根因（两层，缺一不可）**：

1. `collectFacts` 写的是 `firstUser = clampText(userTexts[0], 1200)`——它假设「首条 user 消息 = 用户目标」。
   可是链上每一棒的首条 user 消息都是上一棒**注入的整份交接简报**（`performHandoff` 里 `prompt` 投递的正文字符串）。
   于是每深一层，文档里就多嵌一份旧文档；1200 字钳位又把嵌套的开头当成了全文。
2. 只按「正文递归找 `## 原始目标`」修是不够的：**注入副本被 `docMaxChars=6000` 截断**，
   实测 depth 7 那条 6013 字的简报里 `## 原始目标` 只出现 1 次（offset 2200），它内嵌的上一层文档**只有开头、
   没有自己的「## 原始目标」**——递归到第二层就拿到空串，`unwrapGoal` 只能停在第 1 跳。

**修法**：

1. 新增 `unwrapGoal(text, maxChars)`：文本以 `[自动交接]` 开头时，从首行 `已把进度写入 \`<path>\`` 解析出上一棒文档路径 →
   **读盘**（`goalFromDocPath`：`statSync` 判存在 → `readFileSync` 读全文 → `goalSection` 取该节）→ 继续下钻，
   直到遇到不以该前缀开头的文本（= 链根真用户话）。读不到盘就退回正文 `goalSection`，两条都拿不到新内容就停，最多 12 层。
2. 防环用 `seenDocs`（已读文档路径的 Set）而**不是**文本指纹——见下「为什么第一版修法无效」。
3. 新增配置项 `goalMaxChars`（默认 4000），替代写死的 `clampText(…, 1200)`。
   链根目标实测 1489 字，1200 装不下；4000 足够装下十几轮堆叠后的验收清单，又不至于让文档失控。
4. `goalSection(text)`：按行找**精确等于** `## 原始目标` 的那一行，收集到遇到 `===== 交接文档结束 =====`
   或下一个已知小节标题（`DOC_SECTION_TITLES`）为止。**不能**用「下一个 `##` 任意标题」当边界——
   用户目标本身就可能带 Markdown 标题（链根那份里就有 `# 关键决定与坑`）。

**为什么第一版修法无效（这一条值得单记）**：第一版 `unwrapGoal` 用「文本长度 + 尾 64 字」当防环指纹。
链上相邻两棒的「原始目标」**长度与尾部完全相同**（都是同一处截断留下的嵌套开头），指纹在第一次下钻后就命中，
直接 `break`——症状与没修一模一样（回放仍是 693 字 / 以 `[自动交接]` 开头 / 清单 0 项）。
**「我是否回到过同一个地方」要按「地方」（文档路径）判断，不能按「路过时的风景」（文本内容）判断。**

**验证**（真实日志回放 + 离线回归）：

- 回放：`session-e6711e9b` 693 → **1206 字 / 不以 `[自动交接]` 开头 / 清单 13 项**；`session-5ddd6bb5` 同；
  链根 `session-74352d08` 保持 1489 / 13（本来就对）。下钻 6 跳：`e6711e9b → 5ddd6bb5 → 6f3c471f → 9ee68a8f → 87b7046c → 138525f5 → 74352d08`。
- 离线：新增 `test/goal.test.mjs` 9 条断言（单跳 / 6 层多跳 / 注入副本被截断时靠读盘救回 / 相邻两棒同形不能误判成环 /
  真环 A→B→A 能停 / 文档被删时退回正文 / `goalMaxChars` 截断 / `DEFAULTS` 与 `resolveOptions` 的默认值 /
  端到端生成的文档里该节不含简报壳且清单不丢）。`node --test test/*.test.mjs` = 5 文件 50 条断言全绿。

**与 E 节「顺带发现的文档隐患」的关系**：E 节记录的是同一个缺陷的**观察面**（同一份文档里出现两组互斥的 REVIEW 数字，
因为「原始目标」栏里嵌着上一棒整篇文档）。本条是它的**根因与修法**，E 节那段保留原样，作为「当时只记了症状」的证据。

**教训**：**「这个字段有值」不等于「这个字段是对的」**。`firstUser` 一直有值、一直非空、从来没抛过错——
它只是**装着别人家的文档**。凡是把「上游产物」当成「下游输入」的地方，都要问一句：这份输入是原话，还是上一跳的转述？

---

## B. 当前开放问题（O 系列）

### O-1 源码路径唯一化 【已关闭 2026-11-08】

**决定的方案**：源码进仓库（当年列的方案 A 的变体）。

| 路径 | 角色 |
| --- | --- |
| `D:\proj\PC1\plugins\dsh-auto-handoff` | **唯一权威源码**，进 git（`dongopencv/tools`） |
| `D:\tools\dsh-auto-handoff` | 过渡期的运行副本；profile 仍 `link:` 到这里 |

为什么不是「把 `link:` 直接改成仓库路径」：`Dsh` 的 profile 依赖表在 `~/.dsh/profiles/<name>/package.json`，四份 profile（desktop / zz-audit / zz-caps / zz-desktop-probe）都写着 `link:D:/tools/dsh-auto-handoff`，且 desktop 的 `pnpm-lock.yaml` 把同一行固化在 26–28 行。改 profile 必须连 lockfile 一起改，而本机**没有 pnpm**（`which pnpm` 为空），改完无法用 `pnpm install` 重建 `node_modules` 符号链接——只能手改 package.json + 手建链接，风险高于收益。

所以分两段：**先在仓库里立住权威源码**（这一段已完成），**再一次性切 `link:`**（清单见下）。
不用等宿主重启：改 profile 的 `package.json` 本身就是 `dsh-hmr` 的监听输入，改完即触发 profile 重组。

**切换清单（一次性）**：

1. 改四份 profile 的 `package.json` 依赖行：`"dsh-auto-handoff": "link:D:/proj/PC1/plugins/dsh-auto-handoff"`。
2. 改 `profiles/desktop/pnpm-lock.yaml` 的 26–28 行（`specifier` 与 `version` 两处都要改）。
3. 重建 `node_modules/dsh-auto-handoff` 符号链接（用 `cmd /c mklink /D`，**不要** `ln -s`——本机 `ln -s` 在 `node_modules` 里建出的是 junction，`readlink` 不可用且删的时候 `rm` 删不掉，只能 `rmdir`）。
4. 跑 `node tools/handoff-check.mjs --deep`，确认「代码版本」通过；没通过就看 `~/.dsh/auto-handoff/auto-handoff.log` 有没有新的「已启用」行。

验证方式（不触发重载也能做）：

```bash
node --preserve-symlinks -e "import('dsh-auto-handoff').then(m=>console.log(Object.keys(m)))"
# 在 profile 目录下跑，能列出 Config/DEFAULTS/apply/inject 即表示链接与 peer 依赖都对得上
```

---

### O-2 文档行号与源码对齐 【已关闭 2026-11-08】

`DESIGN.md:5` 原写「`lib/index.js`（938 行）」，实测 **1360 行**，已改。`REQUIREMENTS.md:4` 的 `D:\PC0` 路径已改成权威路径。

对齐后的目录结构：

```
plugins/dsh-auto-handoff/
  README.md REQUIREMENTS.md DESIGN.md ISSUES.md RISKS.md
  package.json cordis.patch.yml
  lib/index.js (1360) lib/claims.js (146)
  test/{integration,midturn,claims,chain}.test.mjs
  icons/icon.svg  locale/{en,zh}.json
```

行号引用只在 `DESIGN.md` 一处出现（已改），其余文档用函数名而非行号，避免每次改动都要重排。

---

### O-3 版本控制 【已关闭 2026-11-08】

插件源码现位于 `D:\proj\PC1\plugins\dsh-auto-handoff`，随 `dongopencv/tools` 一起提交与推送。`D:\tools` 下那份是过渡期运行副本，**不再是权威**；等 O-1 的切换清单执行完即可删除。

---

### O-4 阈值默认值缺乏实测依据 【中】

实测数据显示 `session-0a1d53a3` 峰值单次 input 已达 **530K**，而默认 `tokenThreshold` 是 300K。理论上应在膨胀前切走，但**没有真实运行数据验证**这个阈值在日常使用中是否合适。

**建议**：先加日志（见 O-5），用真实数据定阈值。

---

### O-5 缺少结构化日志 【中·用户列为第 2 优先级】

目前只有 `console.log/warn` 的自然语言行，无法机器统计。

用户要求："更新插件的日志，然后根据我的使用情况（日志）确定后续修复方案、需求更新方案。"

**需要的字段**：`sessionId`、`trigger`（threshold/mid-turn/manual）、`tokens`、`toolCalls`、`depth`、`docPath`、`newSessionId`、`durationMs`、`summaryUsed`、`outcome`（ok/skip/fail）。

---

### O-6 未验证真实长会话 【中】

50 条断言都是离线桩测试（v1.1.5 起含 goal 9 条）。**没有**在真实长任务上完整跑过"阈值触发 → 交接 → 新会话接续"的闭环。

> 补充（2026-11-08）：I-13 的验证用的是**真实会话日志回放**（`work/probe-facts-real.mjs` 喂真实 zstd 日志给真实 `collectFacts`），比纯桩件强，但仍不是端到端——它证明「事实抽取正确」，不证明「真宿主里交接文档里有这段」。

**建议**：临时把 `toolCallThreshold` 压到 8 做一次实机验证。

---

### O-7 `compaction-basic` 处于禁用状态 【中·平台侧】

`list_plugins` 显示 `include:compaction-basic` 为 `enabled: false`。

后果：平台级压缩未开启，单靠换会话**不解决上下文窗口上限**问题——会话到 530K 时仍可能撞窗。

**建议**：评估启用，与换会话形成互补。

---

### O-8 子代理会话 0 落盘 【低·待查】

全盘 39 个会话，`origin === 'subagent'` 的为 0。但两次会话里 `agent_teams_create` 调了 4 次、`agent_teams_add_member` 5 次。

含义不明：要么团队会话不落盘，要么落在别处。影响"交接是否需覆盖子代理"的判断。

---

### O-9 「2 亿 token」口径不一致 【低·需用户确认】

实测：Σinput ≈ 2,360 万，cacheRead ≈ 1.36 亿。与用户口径的 2 亿差约 8 倍。

可能是账单加权、可能是别的会话。影响阈值标定。

---

## C. 优先级建议

按"对长期维护的阻塞程度"排序：

| 优先级 | 项 | 理由 |
| --- | --- | --- |
| P0 | O-1 + O-3 | 源码位置未定 + 无版本控制，是丢失重演的直接风险 |
| P1 | O-5 日志 | 用户明确的第 2 优先级，且是后续定阈值的数据来源 |
| P2 | O-6 实机验证 | 证明闭环真的能跑通 |
| P3 | O-7 启用压缩 | 补上窗口上限这一环 |
| P4 | O-4 阈值调优 | 依赖 O-5 的数据 |
| P5 | O-8 / O-9 | 待查项，不阻塞主线 |

---

## D. 已核实无需处理

| 项 | 结论 |
| --- | --- |
| `llm-workbuddy` provider 重复声明 warning | 与本插件无关，是既有其它插件的问题 |
| `measureTokens` 是 O(1) 还是 O(surface) | 确认是 O(surface)（`tokenMeter` 文档原文），每轮一次，可接受；早前笔误已纠正 |

---

## ISS-010 `prompt` 少传 AbortSignal，交接简报从未送达

**症状**：全量 86 个会话扫描，「首条 user 消息以 `[自动交接] 上一会话` 开头」命中 **0** 条；新会话都建出来了，但解压后只有 4 帧（header / permission / sandbox / approval），312–318 字节。

**根因**：`lib/index.js` 里 `await controller.prompt({...})` 只传一个实参。宿主暴露给插件的实现是 `async prompt(request, signal) { signal.throwIfAborted(); ... }`，第二参数缺失即 TypeError。

**为什么离线测试没抓到**：`test/integration.test.mjs` 与 `test/midturn.test.mjs` 的假件是 `prompt: async (request) => { prompts.push(request) }` —— 单参数、永不抛，比真实宿主宽松。

**修复**：`promptSignal(signal)` 补真 AbortSignal；两处假件改成会校验第二参数的真实签名。

---

## E. warn 核对结论（2026-11-08，含 08:10 补核）

交接文档里出现过三种报错次数（1 / 2 / 3）与两种注入条数（5 / 6），**全部都对**，不是统计错误——它们分别属于**相邻的不同棒**。
核对方法：把 `~/.dsh/auto-handoff/auto-handoff.log` 的 REVIEW 行，与 `~/.dsh/sessions/--D-proj-PC1--/<sid>/session.v4.jsonl.zstd`
逐帧解压后的事件计数对照（`tool/result` 里 `data.error != null` 记为报错；`user/message` 中非用户输入的宿主注入块记为注入）。

| 日志时间（Z） | 会话 | 实测调用 | 实测报错 | 实测注入 | 日志 REVIEW 原文 | 一致 |
| --- | --- | --- | --- | --- | --- | --- |
| 06:27:56 | `session-87b7046c` | 80 | 0 | 6 | 已滤除 6 条宿主注入消息；没有捕获到助手输出 | ✅ |
| 06:47:11 | `session-9ee68a8f` | 80 | 1 | 5 | 本轮有 1 次工具报错；已滤除 5 条宿主注入消息；没有捕获到助手输出 | ✅ |
| 07:12:11 | `session-6f3c471f` | 80 | 2 | 6 | 本轮有 2 次工具报错；已滤除 6 条宿主注入消息；没有捕获到助手输出 | ✅ |
| 07:29:36 | `session-5ddd6bb5` | 80 | 1 | 5 | 本轮有 1 次工具报错；已滤除 5 条宿主注入消息 | ✅ |
| 07:57:28 | `session-e6711e9b` | 129 | 1 | 6 | 本轮有 1 次工具报错；已滤除 6 条宿主注入消息；交接链只剩 1 棒 | ✅ |
| 08:10:46 | `session-ffdd0d4a` | 81 | 3 | 5 | 本轮有 3 次工具报错；已滤除 5 条宿主注入消息；交接链只剩 0 棒 | ✅（调用数日志记 80，实测 81） |

统计口径与插件源码逐字对齐（不是另写一套）：注入判定用 `lib/index.js:591–613` 的 `INJECTED_PREFIXES` +
`isInjectedUserText()`（10 个前缀，含 `[Compressed conversation section]`、`Current runtime context`、
`Time sampled while preparing turn` 等），报错判定用 `lib/index.js:685` 的 `data.error !== undefined && data.error !== null`。
换一套口径（例如把「非 `[自动交接]` 开头且像 note 的 user 消息」都当注入）会得到偏大的数字，那些差值来自**真正的用户消息**
（例如用户手动补的一句话）——不是插件漏计。

唯一一处偏差：`ffdd0d4a` 日志记「80 次工具调用」，实测 `tool/call` 81 条。原因是 REVIEW 取数之后、交接落盘之前
又发生了 1 次调用（同一次轮中触发里计数快照早于落盘）。差 1 次不影响任何判定，属于已知的取数时机差。

**报错逐条原文（全部与插件无关）**：

| 会话 | step | 报文 | 性质 |
| --- | --- | --- | --- |
| `6f3c471f` | 95 | `Expected a semicolon` | run_code 里探针脚本的语法笔误 |
| `5ddd6bb5` | 34 | `Expected ',', got 'ident'` | 同上 |
| `ffdd0d4a` | 34 | `Expected ',', got 'ident'` | 同上 |
| `ffdd0d4a` | 77 | `cannot modify "...REQUIREMENTS.md": file has not been read — read the file, then retry` | 未先读文件就写 |
| `ffdd0d4a` | 79 | `cannot modify "...package.json": file has not been read — read the file, then retry` | 同上，本轮即因此卡住版本号与提交两步 |

全部是 `CodeRunFailedError` / `CODE_RUN_FAILED`（run_code 内的私有失败），**没有一条来自插件逻辑**，也没有一条是「改写被绕过」——三条写失败之后都补了读取再写。

早前两棒都缺助手输出（`5ddd6bb5` 明写；`6f3c471f` 落到文档里的「（未捕获）」一节），根因同为 **I-13**，已在 v1.1.4 修掉；
`e6711e9b` / `ffdd0d4a` 的文档里「最近的助手输出」已有正文（回放实测 `recentAssistant.length=2`）。

**顺带发现的文档隐患（已修复，见 I-14）**：跨棒引用让同一份交接文档里出现两组互斥数字，读者必然当成 bug 去查。根因是「注入副本」把上一份交接文档**全文**又塞进了这一份的「原始目标」一栏。`renderDoc` 的「原始目标」应只保留用户原话，不含上一份文档正文——否则每深一层，文档就多嵌套一份旧文档。本条当时只记了症状；根因与修法（`unwrapGoal` 沿文档路径下钻 + `goalMaxChars`）记在 **I-14**，保留这段原样是为了让「先看到症状、后找到根因」的取证链不断。

**运行态核对（2026-11-08T08:10:49Z 后）**：`claims.json` 无 inflight / 无 cooldown 残留；`state.json` 链根 `session-74352d08`，
链上 `6f3c471f=5`、`5ddd6bb5=6`、`e6711e9b=7`、`ffdd0d4a=8`，当前会话 `6e01ac93` `depth=8`、`state=genesis`（正常）。

**链上限已到顶**：`chainLimit=8`，`lib/index.js:1395` 的 `nextDepth > options.chainLimit` 在本会话下一次触发时成立
（`nextDepth=9`），届时只写文档 + 把占位落成 `stopped`（`note: 'chain-limit'`），**不会再开新会话**。
这正是本棒出生时文首那句「交接链只剩 0 棒」的含义——不是 bug，是设计上的刹车。要接着往下走，只能人工 `/handoff`。

