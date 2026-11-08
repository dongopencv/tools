# PC1 工具与工作区

这台机器（台式机 1，DESKTOP-OGBQE3B，192.168.1.38）上长期使用的工具、脚本与工作区相关文件。

## 目录

| 路径 | 用途 |
|---|---|
| `tools/` | 这台机器的工具与脚本（本仓库的主体内容） |
| `elevate/` | 提权辅助脚本（不提交，见 `.gitignore`） |
| `work/` | 临时工作区，大量实验产物（不提交） |
| `out/` | 截图、导出物（不提交） |
| `docs/agents/` | 工程技能（matt pocock skills deck）需要的配置 |
| `docs/network-baseline.md` | 本机出网带宽与选路规则（#4 落地） |
| `docs/log/` | 每日状态记录：一天一行，推进了什么 / 卡在哪 / 明天第一件事 |
| `docs/pending-issues/` | 写好但发不出去的东西：待建票草稿、待发评论、待做的收尾写操作 |

## GitHub 通道（只有两条）

`api.github.com` 与 `git@github.com` 是本机到 GitHub 的全部通道。没有别的路：**没有代理、没有镜像、没有中转站、没有 fallback 链路**。发现某个脚本里还留着这种东西，删掉它，不要修它。

| 用途 | 通道 |
|---|---|
| 读 API、改 issue/评论、读仓库内容、下载 release 资产 | `gh api` / `api.github.com`（302 到 `release-assets.githubusercontent.com`） |
| `git clone` / `git fetch` / `git push` | SSH：`git@github.com:owner/repo.git`，22 不通就 `ssh://git@ssh.github.com:443/owner/repo.git` |

- `github.com` 的 443 时通时不通，**这不影响干活**：读走 `api.github.com`，写走 SSH。不要为此加通道。
- `~/.ssh/config` 必须同时有 `Host github.com` 与 `Host ssh.github.com`（后者带 `Port 443`），否则走 443 时不带密钥、报 `Permission denied (publickey)`。
- SSH 报 `Permission denied (publickey)` = 账号上没有这把公钥。加公钥**只能人工**在 https://github.com/settings/keys 操作：`gh api user/keys` 用细粒度 PAT 是 403，写不了。
- 所有 GitHub 操作走 `tools/github.sh`，别各处手搓 `curl`/`gh`/`git`：`bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>`。用法见 `tools/README.md`。
- 传输器顺序固定：`gh` → `curl` → `node fetch`。失败时如实说是哪一层失败，不要把传输器问题栽给 token。

## 上行带宽（2026-11-06 实测）

上行 58–364 KB/s，按 **150 KB/s** 估工期。20 MB 的 push 约 1.5–2.5 分钟；**大于 50 MB 不要用 git push**，改用 release 资产。

## agent 会话的能力边界（取决于文件策略，不是机器属性）

同一台机器，DSH 会话的**文件策略不同，命令行为天差地别**。动手前先探明：

```bash
gh issue view 3 --json number   # 成功 = 宽策略；报 pipe: Access is denied = workspace-write 沙箱
```

| 操作 | 宽策略（danger-full-access） | workspace-write 沙箱 |
|---|---|---|
| `gh issue` / `gh list` 不带 `-R` | ✅ 自己从 git remote 推断 | ❌ `failed to run git: pipe: Access is denied.`，须加 `-R owner/repo` 或 `GH_REPO=` |
| `gh api …` | ✅ | ✅ 路径自带 owner/repo，不需要 fork git |
| `gh issue view <n> --comments` | ✅ | ❌ 退出码 1、stdout 空、stderr `failed to run git: pipe: Access is denied.`（**不是**静默返回空） |
| `curl` 任意 HTTPS | ✅ | ❌ `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` |
| `node -e` 的 `fetch` | ✅ | ✅ 沙箱内最稳的出网方式 |
| `git` 本地操作 | ✅ | ✅ commit / branch / worktree / diff / log 都正常 |
| `git fetch` / `push` / `ls-remote` | ✅ | ❌ `cannot create standard input pipe for ssh: Permission denied` |
| `ssh -T git@github.com` | ✅ | ✅ 单独的 ssh 进程能通，只有 git 要 fork 它时被拦 |

含义：**沙箱会话里能改文件、能本地 commit、能读写 issue，但推不上去**——push 交给宽策略会话或人在终端跑。
反过来，**别把某一种策略下的观察当成这台机器的固有事实写进文档**：本仓库上一版就把沙箱的限制写成了「本机缺陷」，逐条复测后全部推翻（见 #3）。

## 复用与自研：不要重复造轮子

**判断一个东西是不是轮子，只看它有没有被大量测试过、并把测试暴露的问题修掉。**
看着能跑、代码漂亮、AI 现写的——都不算轮子，自娱自乐而已。

- 有批量验证（高 star + 生产使用 + 持续维护，至少两项可查）→ 直接复用，别自己写。
- 没有批量验证 → 不管它多合理，都不要当基础件；自己写更不该当基础件。
- 自研只允许出现在"确实没人做过"的空白处，且必须先证明空白存在（搜过、比对过、留证据）。

## token（唯一真身 + 一次事故的前因后果）

**三处同一个值，换就一起改：**

| 位置 | 用途 |
|---|---|
| `C:\Users\Admin\.skills-vault\download\scripts\.github-token` | `tools/github.sh` 首选读取 |
| 同目录 `github.env` 的 `GITHUB_TOKEN=` | 给别的脚本用 |
| `gh` keyring | `gh api` 用 |

### 2026-11-07 的事故（写给以后的我，别重犯）

01:14:15 我把一条 issue 评论发到了公开仓库，正文里有 token 明文。01:14:17 GitHub secret scanning 命中、**自动吊销**，全程没有通知、没有确认、不可撤销。01:16 起票库写操作全线中断——改不了 issue、发不了评论、push 不了，**阻塞约 15 小时**。

真正的原因不是「安全意识不够」，而是**命令写错了**：正文用 `-f body="$(cat body.md)"` 内联进 shell，`$()` 与反引号会被再执行一次，文件内容就那样进了 URL 与日志。

### 因此，写 issue / 评论 / commit message 只有一种写法

```bash
# 对：正文永远走文件，只传路径
gh api -X PATCH repos/OWNER/REPO/issues/N -F body=@/tmp/body.md
gh api -X POST  repos/OWNER/REPO/issues/N/comments -F body=@/tmp/body.md

# 错：任何形式的拼接
gh api -X PATCH ... -f body="$(cat body.md)"     # 再执行一次
gh api -X PATCH ... -f body="...${VAR}..."       # 变量同样会展开
```

发之前跑一遍闸门，它只匹配真实值的形状，不会命中散文：

```bash
bash tools/credential-gate.sh --text /tmp/body.md
```

`.git/hooks/pre-commit` 与 `commit-msg` 已装同一个闸门（`tools/credential-gate.sh --install` 可重装）。被拦时不要 `--no-verify` 糊过去。

### 授权：一次配到底，不要反复人工授权

细粒度 PAT（`github_pat_` 前缀）在 **Repository access → 本仓库** 下把这四项全给 `Read and write`，有效期选 `No expiration`：

`Contents` · `Issues` · `Pull requests` · `Metadata`（`Metadata` 必选，是其它项的前置）

配齐之后 issue 正文、评论、删除评论、push 全部可用，不需要每次再点头。**`gh api user/keys` 除外**——细粒度 PAT 永远读/写不了账号级 SSH 公钥，那是账号设置页的人工操作。

### 不要再做的事

- **不要再写这类分析文档。** 它们一条都没阻止中断，一条都没缩短恢复。要防就改脚本（`tools/credential-gate.sh`），要恢复就换 token。
- **不要把 token 值写进任何被 git 跟踪的文件、issue 正文、评论、commit message。** 要引用就引用路径。
- **不要擅自改动本机环境**：系统/用户环境变量、`gh` 登录态、`~/.ssh/*`、`.git/config`、计划任务、正在运行的进程与服务、其它会话正在跑的任务。要动先问人；改完必须能说清改了哪一处、原值是什么。

## Agent skills

### Issue tracker

Issues live as GitHub issues in `dongopencv/tools`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.

## 仓库的三重定位

这个仓库不只管工具，也管**认知**和**当下状态**。三件事都必须持续维护：

| 用途 | 落点 | 说明 |
|---|---|---|
| 工具与脚本管理 | `tools/`、`AGENTS.md`、`docs/*.md`（research 除外） | 这台机器上跑了什么、怎么用、踩过什么坑 |
| 个人认知管理 | `docs/research/` | 对重要外部项目的长期跟踪结论、判断依据，以及**后来被推翻的判断** |
| 每日状态记录 | `docs/log/` | 一天一行：今天推进了什么、卡在哪、明天第一件事是什么。**不写感想，只写可核对的事实** |

`docs/research/` 的写法要求：

- 结论必须能追到**源码位置（带行号）或一次实测**，不能只写「感觉它很成熟」。
- 每条采纳建议必须写明**适用边界与失效条件**——什么情况下这条不成立。
- 保留被推翻的判断（标出「原以为是 X，证据是 Y」）。认知管理的价值在记录**判断如何变化**，不在只留正确答案。
- 引用外部项目源码时写相对路径（`src/policy.ts`），不写本机绝对路径；临时副本放 `work/`（不提交）。

现有研究笔记：[docs/research/superagent.md](docs/research/superagent.md)——DSH Superagent 原型，长期跟踪中。

## 注意力纪律（2026-11-08）

**用户注意力是唯一稀缺资源。** 票库不是待办清单，是决策记录：每张 open 票要么有一个
明确的下一动作，要么就该关掉。挂着不动是最贵的状态——它每天都在收租，却不产生任何推进。

三条硬规则：

1. **一次会话最多推进一张票**（wayfinder 原话），不并行摊开。摊开的结果是全部停在半路。
2. **开工前先跑 `bash tools/attention.sh`**，只在「等我拍板」和「agent 可接」两段里挑一件。
   「被阻塞」和「沉睡」两段**不是工作队列**，是提醒你去做决定的证据——看一眼，然后回去做第 1 条那件事。
3. **认领 = assign 给自己。** 无人认领的票不会自己前进。停 3 天以上零动静的，要么降级、
   要么合并、要么关掉；不许挂着当「以后再说」。

对应 superagent 的那条纪律：**健康的东西不占空间**。已经在自动运转的（`github.sh`、`attention.sh` 自身）
不需要每天看；每天需要看的只有「等我拍板」那一段，通常不超过 7 张，真正要动手的一般是 1–2 张。

判据：如果连续一周 `attention.sh` 的第 1 段都没变短，说明问题不在票多，在于**不敢做决定**。

> **规则还有很多需要修改的。** 凡是能用脚本卡的（提交前闸门、收尾写操作），一律改成脚本，不要留在文档里当规则。
