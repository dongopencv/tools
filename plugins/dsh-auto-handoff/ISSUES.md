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

13 条测试都是离线桩测试。**没有**在真实长任务上完整跑过"阈值触发 → 交接 → 新会话接续"的闭环。

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

\n## ISS-010 `prompt` 少传 AbortSignal，交接简报从未送达

**症状**：全量 86 个会话扫描，「首条 user 消息以 `[自动交接] 上一会话` 开头」命中 **0** 条；新会话都建出来了，但解压后只有 4 帧（header / permission / sandbox / approval），312–318 字节。

**根因**：`lib/index.js` 里 `await controller.prompt({...})` 只传一个实参。宿主暴露给插件的实现是 `async prompt(request, signal) { signal.throwIfAborted(); ... }`，第二参数缺失即 TypeError。

**为什么离线测试没抓到**：`test/integration.test.mjs` 与 `test/midturn.test.mjs` 的假件是 `prompt: async (request) => { prompts.push(request) }` —— 单参数、永不抛，比真实宿主宽松。

**修复**：`promptSignal(signal)` 补真 AbortSignal；两处假件改成会校验第二参数的真实签名。
