# dsh-auto-handoff · 长会话自动交接

一个针对「长会话把上下文和额度吃光」这个问题的 DeepSeek Harness 插件。

它做的事只有一件：**改会话边界，而不是压缩历史**。

## 四阶段流水线

| 阶段 | 做什么 | 代码位置 | 稳定性判据 |
| --- | --- | --- | --- |
| ① 检测与强制执行 | token / 工具调用双阈值，轮中硬兜底 + 轮末兜底，任一命中即交接 | `ctx.on('session/event')` 里的 `tool/call` 分支、`ctx.on('agent/turn-stopping')` | 真实长会话里不误触发、不重复触发、不漏触发 |
| ② 记忆与归档 | 抽事实（目标 / 最近指令 / 助手输出 / 触及文件 / 工具轨迹）→ 渲染交接文档落盘 | `collectFacts` → `renderDoc` → `writeFile` | 文档里没有宿主注入、没有伪路径、末尾的「下一步」不能被截断 |
| ③ 交接前 REVIEW | 开新会话**之前**用确定性规则自检这一棒能不能用，结论写进文档与简报 | `reviewHandoff` → `renderReview` | 每条结论可枚举、可复现；不是模型审（会漂移、要等 30–60 秒） |
| ④ 开新会话续作 | `sessionController.create` 建同 cwd 新会话 → `prompt` 投递简报全文 → 记账 | `performHandoff` | 新会话第一条 assistant 输出必须引用文档里的「下一步」 |

## 为什么值得存在（它补的是空白）

横评 Claude Code / Codex CLI / Cline / Aider / claude-mem / Letta / mem0 / LangGraph 后的结论：
**前三段各家都有成熟做法，第四段（换会话续作）整列是空白**。
压缩（`/compact`、auto-compact）保留同一会话，缓存前缀被重写、整段重新计费；
换会话是清零，代价是「简报必须足够好」。两者互补，不该二选一——本插件补的是后者。
## 触发条件

任一命中即交接：

| 条件 | 默认值 | 配置键 |
| --- | --- | --- |
| 会话累计 token 压力 | 300,000 | `tokenThreshold` |
| 会话工具调用次数 | 80 | `toolCallThreshold` |

两个检查点：

- **轮中硬兜底**（`enforceMidTurn: true`）：`tool/call` 累计过线就地触发，不等本轮结束。
- **轮末兜底**：`agent/turn-stopping` 时再判一次，覆盖「工具调用没超但 token 超了」的情况。

两条路径共用同一份**落盘占位**（`claims.json`），所以不会同一轮触发两次。

## 交接文档长什么样

`<工作目录>/.dsh/handoff/<sessionId>.md`，YAML 头 + 六节：

- **原始目标** —— 会话最早那条真实用户指令
- **最近的用户指令 / 最近的助手输出** —— 用最近两轮校准方向
- **触及的文件** —— 从工具参数里抽出来、并且**在磁盘上真的存在**的路径
- **工具轨迹** —— 每个工具被调用了多少次
- **进度与下一步** —— 模型摘要（`modelSummary: true`），或零成本本地兜底。**排在文档前部**，
  因为它最要紧，而注入副本会按 `docMaxChars` 截断、排在后面的先被砍
- **交接前 REVIEW** —— 这一棒交出去会缺什么，逐条标注 ⛔ / ⚠️ / ℹ️

### 落盘与注入是两份长度

盘上写全文（上限 `max(docMaxChars × 4, 40000)` 字），注入新会话的那一份才裁到 `docMaxChars`。
旧实现用同一份裁剪结果两处复用，结果排最后的「进度与下一步」被整段砍掉——全篇最有用的部分反而最先丢。

### 事实采集的三条硬规矩

1. **宿主注入不是用户指令。** `system-reminder`、压缩段、时间戳采样、后台任务完成回执都带固定前缀，
   命中即丢弃并计数（`INJECTED_PREFIXES`）。否则「最近的用户指令」抓到的会是宿主的时间戳。
2. **路径必须真实存在。** 只保留 `statSync` 能读到的路径，文件排在目录前；全部不存在时退回原列表，
   避免把「文件被删了」误报成「没识别到文件」。
3. **路径可能藏在代码正文里。** `run_code` / `bash` 这类工具的路径在 `arguments.code` 里，
   只按白名单键（`file_path`/`path`）抓会全军覆没。
### 摘要的四道截断闸，缺一道「下一步」就没了

「下一步」是被四条独立的截断来源轮流砍掉的，2026-11-08 才全部堵上：

| # | 位置 | 现象 | 修法 |
| --- | --- | --- | --- |
| 1 | `requestModelSummary` 的 `clampText(summaryMaxChars)` | 摘要 1600 字一刀切，第三节整节消失 | 先按节重排（`orderSummary`）把「下一步」提到最前，再裁剪 |
| 2 | `renderDoc` 把摘要放在文档最末 | 注入副本按 `docMaxChars` 截断，先砍到它 | 摘要在文档里前移，紧跟标题 |
| 3 | 模型漏写「下一步」 | 模型自觉不可靠 | `ensureNextStep` 用本地兜底补一节 |
| 4 | `maxTokens: 1200` 输出预算 | **生成到一半就断**，句子没写完 | `summaryTokenBudget` 按字数折算（默认 3600） |

前三条靠读代码就能发现，第四条只有在**真实宿主里跑 e2e** 才暴露——离线测试的假 llm 一次吐出整段文本，永远不受输出预算限制。

## 交接前 REVIEW 判什么

| 检查项 | 级别 | 为什么要有 |
| --- | --- | --- |
| 没有识别到任何触及的文件 | ⚠️ | 新会话没有锚点，只能靠文字复述找现场 |
| 本轮有工具报错 | ⚠️ | 先确认是已解决还是被绕过，别把失败的当成完成 |
| 待办清单还有未勾选项 | ⚠️ | 长任务最常见的坑：清单没勾就换棒 |
| 没有捕获到助手输出 | ⚠️ | 缺少「已经做到哪」的判断依据 |
| 交接链剩余棒数 ≤ 1 | ⚠️ | 再往下就会停在只写文档、不开新会话 |
| 已滤除宿主注入 | ℹ️ | 让新会话知道简报里少了什么、为什么少 |

结论三档：`ok` / `warn` / `block`。`warn` 不阻止交接，但会写进文档与简报第一段，
新会话开工前必须先核对这几条。

## 安全边界

- 交接失败只记日志，**不抛进当前轮**。
- 占位落盘在 `~/.dsh/auto-handoff/claims.json`，**杀进程 / 新会话都仍然有效**；
  旧实现是进程内 `Set`，进程一重启就失效，同一会话被重写 5 次以上、连开 14 个空会话。
- 状态语义：`inflight`（进行中，`claimTtlMs` 内拦住重复派发）/ `done`（已交接）/ `failed`（`retryCooldownMs` 后可重试，`maxAttempts` 用尽后不再自动重试）/ `stopped`（终态）/ `genesis`（新会话首次登记）。
- `chainLimit`（默认 8）限制自动续作链深度；超限后只写文档不再自动开新会话。
- 抽事实只读会话日志，不重放、不执行任何工具。
- 日志双写控制台与 `~/.dsh/auto-handoff/auto-handoff.log`（超 1 MB 自动轮转一份 `.1.log`）。

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
| `tokenThreshold` | `300000` | token 压力阈值；`tokenMeter` 服务缺失时该项静默失效 |
| `toolCallThreshold` | `80` | 工具调用次数阈值；不依赖任何可选服务 |
| `enforceMidTurn` | `true` | 轮中硬兜底，过线就地交接，不等本轮结束 |
| `handoffDir` | `.dsh/handoff` | 相对会话 cwd 的交接文档目录 |
| `chainLimit` | `8` | 自动续作链最大深度，超限只写文档 |
| `modelSummary` | `true` | 是否让模型写「进度与下一步」；失败自动降级到本地兜底 |
| `summaryProvider` / `summaryModel` | `''` | 摘要用的模型；空则用宿主默认路由 |
| `summaryMaxChars` | `1600` | 模型摘要字数上限 |
| `summaryTimeoutMs` | `45000` | 摘要超时，超时即降级 |
| `docMaxChars` | `6000` | 注入新会话那份的裁剪上限（落盘是它的 4 倍） |
| `maxTrackedFiles` | `40` | 「触及的文件」最多记几个 |
| `claimTtlMs` | `86400000` | 占位有效期，超时视为上一次交接已死 |
| `retryCooldownMs` | `600000` | 失败后多久才允许重试 |
| `maxAttempts` | `3` | 同一会话最多自动尝试几次，用尽后停止自动重试 |
| `cancelParentAfterHandoff` | `true` | 交接成功后取消父会话当前轮（保留未处理队列）。关掉它就退回「不打扰旧会话」，但父会话会和子会话同时烧 token。手动 `/handoff` 永远不取消 |

## 依赖的宿主服务

| 服务 | 必需性 | 缺失时的行为 |
| --- | --- | --- |
| `sessions` | 必需（`inject` 声明） | 插件不加载 |
| `commands` | 必需（`inject` 声明） | 插件不加载 |
| `sessionController` | 可选 | 只写交接文档，不建新会话（`state: stopped`） |
| `tokenMeter` | 可选 | token 闸归零，只剩工具调用闸 |
| `llm` | 可选 | 摘要降级为本地兜底 |

## 交接时到底发生了什么

1. 阈值命中 → `reserveClaim` 抢落盘占位（抢不到直接返回，这是唯一的去重点）。
2. `resolveSessionCwd` 定位工作目录 → `measureTokens` + 工具调用计数。
3. `collectFacts` 抽事实：过滤宿主注入、抽路径并校验存在性、统计工具轨迹与报错数。
4. `reviewHandoff` 自检 → `renderDoc` 渲染六节 → **落盘全文**。
5. `chainFor` 读链深 → 超 `chainLimit` 就停在这里。
6. `controller.create` 建同 cwd 新会话（preset 取会话事件里最后一次 `agent-preset/selected`）。
7. `controller.prompt(request, signal)` 投递简报（**必须传 AbortSignal**，宿主第一行就是 `signal.throwIfAborted()`）。
8. 取消父会话当前轮：`sessionController.cancel({ sessionId })`。宿主实现是 `agent.cancel({kind:'user'},{keepInbox:true})`，
   只停当前那一轮、不丢队列；父会话已经自然结束时会抛 `session/not-found`，按正常情况处理。
   **父会话不会因为交接自己停下**——实测它能继续跑 70 分钟，和子会话一起烧 token，这一步就是治它的。
9. 记账：父会话写 `done`（终态，保证这一棒只交一次），新开的一棒写 `genesis`（链深已登记、还能再交接）；失败写 `failed` + 原因，等冷却后重试；到 `chainLimit` 那一棒写 `stopped`。

## 已知边界

- **改代码不会自动生效，但通常不用人重启。** Node ESM 有模块缓存，光改文件不会进运行中的宿主；
  DSH 自带 `dsh-hmr`，它监听 profile 的 `package.json` 与 `cordis.patch.yml`，改动即触发一次
  profile 重组（recomposition），把「被改动过的 linked 包」整体换掉。本插件正是 profile 里的
  `link:` 包，所以改完只要碰一下这两个文件之一，就会在数秒内生效（实测 3 秒）。
  最轻量的做法是往 profile 的 `cordis.patch.yml` 末尾加一行注释，改前先备份。
  判据不要用文件 mtime，用日志：`auto-handoff.log` 里出现新格式行（带 `[sessionId]` 前缀）
  或新一条「已启用：…交接目录 .dsh/handoff…」，即说明新模块已加载。
  `node tools/handoff-check.mjs` 的「代码版本」一项就是按这个判据算的。
- `tokenMeter.measure()` 返回的是估算值，阈值 300000 是经验值，不是模型窗口的精确比例。
- 「进度与下一步」与「最近的用户指令」在信息上有重叠，属于 #29 待定稿的结构问题。
- **摘要按节裁剪，不是一刀切。** 模型把「下一步」写在第三节，旧实现 `clamp(1600)` 直接从尾部砍，
  实测 8 份真实文档里 4 份整节丢掉「下一步」。现在 `orderSummary` 先把含「下一步」的那节提到最前再裁剪，
  模型漏写时 `ensureNextStep` 用本地兜底补一节；文档里「进度与下一步」也移到了注入副本靠前的位置
  （注入副本按 `docMaxChars` 截断，排最后的最先被砍）。
- **摘要输出预算跟着字数走。** `maxTokens` 旧值写死 1200，而中文 1600 字要 2400–3200 token，
  模型会在第三节中途被截断——「下一步」只剩半句。现在由 `summaryTokenBudget` 按字数折算（默认 3600）。
  这一条**离线测试测不出来**：假 llm 一次吐出整段文本，不受输出预算限制。
- 已交接（`done`/`stopped`）的会话若继续产生工具调用，只记**一条**证据行并清掉它的内存计数，
  不再逐个调用刷「占位拦下」。这行日志本身就是证据：父会话仍在跑。
- 只支持 root 会话；`header.origin === 'subagent'` 一律跳过。

## 测试

```
cd D:/proj/PC1/plugins/dsh-auto-handoff
node --check lib/index.js
node test/integration.test.mjs   # 16 个场景
node test/midturn.test.mjs       # 5 个场景
node test/chain.test.mjs         # 8 个场景
node test/claims.test.mjs        # 10 个场景
```

### 假件必须比真件严格，否则测试全绿也没用

真宿主里踩过的三个坑，离线测试一次都没拦住，原因都是**假件比真件宽松**：

| 契约 | 真宿主 | 旧假件 | 后果 |
| --- | --- | --- | --- |
| `controller.prompt(request, signal)` | 第一行 `signal.throwIfAborted()` | 单参数、永不抛 | 简报 0/86 送达 |
| `controller.create()` | 一定返回 `{sessionId}` | 可能返回空 | 空壳会话疯涨 |
| `llm.stream({maxTokens})` | 真按预算截断 | 一次吐出整段 | 「下一步」半句就断 |

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
