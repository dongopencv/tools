# Superagent 研究笔记（滚动更新）

对 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的长期跟踪结论。
目标不是转述源码，而是**支撑「搬不搬」的判断**。每加一条结论，都要能追到源码位置或一次实测。

最后更新：2026-11-07 ｜ 对应 map [#41](https://github.com/dongopencv/tools/issues/41)

---

## 一、它是什么、不是什么

**是**：一个**单仓库**的主动式编码 agent。听 GitHub（可选飞书），当被允许的人请求工作时开一张 Ticket，在**自己的 Session 和自己的目录**里干，回到原对话回答（通常是提 PR）。一个 Web 面板只显示「需要人动手的」。

**不是**：
- 不是官方产品（README 首行：*Research prototype for reference only, not an official DeepSeek product*），自陈含 bug、风格不一致。
- **不是多 agent 协作框架**。没有群聊、没有委派、没有辩论、没有任务分解。协作拓扑是固定的双角色串行派活。
- 不是通用 issue 看板。它只有一个仓库、没有 DAG、没有 Web 提需求入口。

> 一句话：它的价值不在「多 agent 怎么协作」，而在**「怎么让一个会干活的 agent 少占用人的注意力」**。

---

## 二、机制地图

| 层 | 它怎么做的 | 位置 |
|---|---|---|
| 入口 | 只有两种 Source：GitHub（轮询 60–3600s，默认 60）、飞书。**没有表单、没有 cron** | `src/sources/` |
| 授权 | Policy 允许名单 + addressed 判定 + 准入矩阵 → Eval 出 Decision → accept 才铸**不可变 Mandate** | `src/policy.ts` `gate()`、`src/admission.ts` |
| 工作项 | Ticket 只有 open/ended，**没有「进行中」**；`pending→running→ended` 是 Assignment 的 | `src/core/tickets.ts`、`src/core/model.ts:277` |
| 执行 | 一票一 Session（`worker-<ticketId>`）+ 独占目录（`git worktree add`）+ 分支，权限 full-access | `src/executor/dsh.ts` |
| 反馈 | worker report → 主 Session 仅 relay → outbox 投回原 Thread（5s 起翻倍到 300s，同票保序） | `src/app/outbox.ts`、`src/app/notices.ts` |
| 存储 | 单文件 SQLite，`SCHEMA_VERSION=11`、`OLDEST_SCHEMA=10`，只升不降 | `src/app/migration.ts` |

### 执行链（实际发生的顺序）

```
人类(IM/GitHub) → Trigger → Eval(Decision) → 主Session(accept/attach/ignore/stop + 回帖)
                                                    ↓ 一个 Ticket
                                        worker-<ticketId> 独享 worktree + 目录
                                                    ↓ report(progress/waiting/ready/blocked/failed/dropped)
                                        主Session 仅 relay，合入/关闭由 Source(PR) 与人定
```

---

## 三、守门员清单（13 层）

结论：**这不是装饰，是一套对得上威胁模型的防御**。威胁是「外部不可信输入驱动一个有写权限的 agent」。搬到单人场景才变摩擦——因为威胁模型变了。

| 层 | 位置 | 防什么 |
|---|---|---|
| 来源 Scope | `src/sources/feishu.ts:54-59`、`src/core/intake.ts:25-29` | 全公司群消息一律接单 |
| 机器门（bots 名单） | `src/policy.ts:171-188` | webhook/CI 以 inferred 强度改真实仓库 |
| 准入矩阵 | `src/policy.ts:193-211`、`src/admission.ts:9-13` | 陌生人 @ 一下就能开工 |
| Eval 裁定 + 评估契约 | `src/policy.ts:40-61`、`src/app/assessment.ts:21-34` | 把讨论中的设计问题直接变 PR；事后篡改评估 |
| policyVersion 漂移 | `src/core/evals.ts:284-287` | 改名单后旧评估仍按旧名单开票（TOCTOU 越权） |
| Mandate 复检 | `src/policy.ts:213-240` | 移出名单后旧票继续写和推 |
| Eval 超时重排 | `src/core/evals.ts:60-69` | assessor 卡死时票据永久悬挂 |
| 重复开票/幂等 | `src/core/intake.ts:23`、`src/core/evals.ts:86-90` | 一条评论开两张票，两个工人改同一分支 |
| 工人工具白名单 | `src/app/sessions.ts:61-62,289-297` | 工人自派子 agent 扩张权限；票关后继续推 |
| 主 Session 工具收敛 | `src/app/sessions.ts:263` | 聊天助手直接 write/edit 源码，绕过全部授权 |
| noWait guard | `src/app/sessions.ts:70-86` | 值守式轮询把 turn 挂死 |
| 槽位/暂停/派工授权 | `src/executor/dsh.ts:171-199` | 多工人改同一仓互相覆盖 |
| 凭据与命令边界 | `src/infra/environment.ts:45-58` | 工人拿宿主 token 推任意仓库 |

**冗余 3 处**：「这票还算不算被授权」判定了四遍（`evals.ts:285` / `policy.ts:213-240` / `tickets.ts:113` / `policy.ts:144-165`）；machineGate 与 gate 过滤条件重复、矩阵语义三处定义；重复开票拦三处、票结束拦两处。

**单人场景的纯摩擦**：准入矩阵（只有「我 @ 它」一条路径，unlisted 两格永不命中）、eval 全量规则裁定（默认 observe，白跑一轮）、四重授权复检（不改名单时恒真）、noWait 默认打断。

**真正最贵的一层**：主 Session 只有 `bash/read`，想顺手改一行也得走完评估→开票→worker，**没有单人旁路**。

---

## 四、「AI 军团」这个印象从哪来（以及它错了）

常见判断：「它整合了一个公司架构，需要产品经理，再派几个 agent 干活」。
**核验结论：产品经理这一层不存在。**

证据：
- 派活工具只有四种动词 `accept/attach/ignore/stop`（`src/app/tools/main.ts:48`），**没有建子工单的能力**。
- Ticket 数据模型无 children/parent（`src/core/model.ts:277`）；`Tickets.create` 一次 accept 只生成一票一派工，不递归（`src/core/tickets.ts:37-56`）。
- Prompt 明令禁止规划：`prompts/dispatch.md`「Do not expand a request's scope, add implementation plans, acceptance criteria…」
- 全仓 "child ticket / decompos* / breakdown / agent team" **0 命中**。

错觉的三个来源：
1. **阶段名像部门**。`docs/007-architecture.md` 的 Engine 分 Intake/Evals/Tickets/Assignments/Replies，读起来像「接单→立项→派工→交付→回访」，实际是同一状态机的阶段。
2. **`prompts/team/` 的员工手册语气**。100 词上限、PR 需 Before+After、何时暂停自主开发——像多角色协作协议，其实约束的是**同一个 worker**。
3. **Mandate 的合规感**。`{strength, policyVersion, basis, actor, scope}` 像立项审批单，但它管「能不能干、干多大」，不管「谁派活给谁」。而 scope 定义几乎**反 PM**：只允许 small internal change，超界就 report blocked/dropped。

**推论**：如果你的需求是「一个 PM 带几个 agent 干活」，这个原型给不了——它把澄清与分解**显式推回人类**（`docs/000-philosophy.md:14`）。

---

## 五、「长期验证过」成立吗

**结论：长期验证成立，但验证的是 X 而不是 Y。**

- **X = 把人当瓶颈的授权机制与注意力预算如何用代码 + prompt 强制** → 成立，它确实在真实团队日常开发里跑过。
  硬证据：三代前身名 `dsh-tag`/`dsh-go`/`dsh-freelancer` 全线重写（`migration.ts:243,271`）；16 条改名表连**用户已保存的 prompt 正文**都要迁移（`migration.ts:254-282`）；部署文档 25+ 条真实报错原文的症状表；测试 14960 行 ≈ 源码 15205 行、794 个 `it`。
- **Y = 多 agent 应该怎样协作的通用范式** → 不成立。拓扑是固定双角色串行派活。

**可证伪点**：若内部历史只有数周，或从未迁移过真实用户的 prompt/settings，则倒向「一次性实验」。

**公开仓为什么看着新**：只有一个 squash 提交（`8c32a9d`，2026-10-31 20:05:39 +0800）；schema 已到 11 但迁移链在发布时被主动截断（`OLDEST_SCHEMA=10`，更旧直接拒绝）。**仓库的新 ≠ 代码的新。**

**与业界对照**：像 MetaGPT 的 SOP 文本化、像 CrewAI 的可编辑角色 prompt；**不像** AutoGen（无群聊/委派/共识）；只有一半像 LangGraph（本质是持久化工作流，更接近 Temporal）。

**证据缺口**：仓库内零效果度量（grep benchmark/dataset/ablation/success rate 全无命中）；还差内部 git 历史、文章评测章节、真实部署的前后对比。

---

## 六、采纳清单（含失效条件）

| 机制 | 结论 | 失效条件（什么时候这条不成立） |
|---|---|---|
| **注意力纪律**：先列等人动手的，健康状态不占空间；只在「人须行动或结果可用」时说话 | **搬，立刻** | 若你需要的是「全量巡检」而非「等人处理」，隐藏健康状态会让你漏看 |
| **Mandate 的结构**（范围/依据/授权人/失效条件），抄形不抄壳 | **搬** | 单人自用且无外部输入时，写全这套字段只是仪式；一旦有第二个人的输入就立刻必要 |
| **observe 档**：自动化先只记「本来会做什么」 | **搬** | 高频低风险动作上，observe 期本身就是纯延迟 |
| **worktree 隔离** | **半搬**：taskboard 执行隔离从 `none` 改 `worktree` | 若任务本来就是单点改动且要立刻在主工作区看效果 |
| Ticket/Assignment 两层 | **不搬** | 若将来真出现「一票多执行器并行」的需求，这条要重估 |
| 事件驱动自动接活 | **不搬（当前）** | 若需求开始来自**别人**且量大到你不想手动搬，重估 |
| 专用 GitHub 账号 + tmux daemon | **不搬** | 若要 7×24 无人值守接活，才值得算这笔账 |

**顺序**：先搬注意力（零依赖、当天见效、失败成本为零），再搬 Mandate 结构（习惯改造，需要前一条做前提）。反过来只会让每张票的正文更长。

---

## 七、待验证问题（滚动）

- [ ] 若引入事件入口，准入矩阵该怎么取值？（本机现在完全没有「什么算需要处理」这一层）
- [ ] 「注意力纪律」搬到本机后，怎么验证它真的减少了打断？（需要一个可观察指标）
- [ ] 主 Session 无写权限这一摩擦，在本机是优点还是缺点？
- [ ] 它的 human_action 结构化提问（因为没有 ask_user_question 工具）是否比自由问答更省注意力？
