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

## 本机网络限制（重要）

**`github.com` 的 HTTPS（443）被墙**，直连 100% 超时。可达的只有：

- `api.github.com` — `gh` CLI 走这条，不受影响
- SSH `github.com:22` 与 `ssh.github.com:443`（2026-11-06 03:53 复测：22 端口 6/6 通、443 端口 5/6 通；当天早些时候 22 曾整段不通、443 全通）— 这是唯一的 `git push` 通道。**脚本默认走 22**（`git@github.com:owner/repo.git`），22 不通时改走 `ssh://git@ssh.github.com:443/owner/repo.git`（2026-11-07 实测 22 端口 `Connection reset` 时 443 正常）。`~/.ssh/config` 必须同时有 `Host github.com` 与 `Host ssh.github.com`（后者带 `Port 443`），否则走 443 时不带密钥、报 `Permission denied (publickey)`

因此：

- **`git clone` / `git push` 一律用 SSH**：`git@github.com:owner/repo.git`。HTTPS 写操作在本机三条路全死（直连被墙 / 本地 8899 MITM 反代只读 / 镜像不转发写）。
- 所有 GitHub 操作（API / 下载 / clone / push）优先走网关脚本 `tools/github.sh`，别各处手搓 `curl`/`gh`/`git`：
  `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>`
  用法见 `tools/README.md`（#5 落地）。**只有一份实现：本仓库的 `tools/github.sh`**；`skills-vault` 里那份已于 2026-11-07 收敛成 10 行转发器（`exec` 到本仓库，可用 `GITHUB_GATEWAY` 覆盖路径），不再是副本、也不会再分叉。vault 里保持独立的只有凭据相关的 `setup-gh.sh` 与 `.github-token`（后者也是真身的 token fallback）。
- `gh release download` **本身是可用的**：它走 `api.github.com` 拿 302 跳到 `release-assets.githubusercontent.com`，全程不经 github.com（实测 2.3 MB 资产秒下）。网关的价值是镜像回退 + SHA256 校验 + 断点续传，不是「gh 不能用」。
- **`github.com` 域名的兜底是 8899 中转站**（本地 MITM 反代 → `gh-proxy.com`）：`bash tools/github.sh relay up` 后加 `--via relay`，或给任意进程塞 `HTTPS_PROXY=http://127.0.0.1:8899`。实测 15,721,375 B 资产 25 s / 612 KiB/s（同域直连是 21 s 超时）。它只代理 GitHub 家族域名、只读；登录时由计划任务 `\dsh-gh-proxy` 自启（电池模式不启动），没起就 `relay up`；细节见 `docs/network-baseline.md` 第四节。

## 实测网络速度（2026-11-06）

**上行才是瓶颈**：2026-11-06 实测 58–364 KB/s，随 4G 时段波动很大，按 **150 KB/s** 估工期。下行总体不慢，但分层明显：国际 CDN 2–6 MB/s；`release-assets.githubusercontent.com` 与可用镜像在同一批资产上 1.3–5.1 MiB/s；GitHub 归档（`codeload` / `api tarball`）0.5–1.6 MB/s，小文件被延迟主导可低到 19 KB/s。逐条实测见 `docs/network-baseline.md`——**别用这里的摘要数字当带宽用**，那里才是表格。

- 20 MB 的 push 约 1.5–2.5 分钟 → 单次 push 尽量 ≤ 20 MB。
- **大于 50 MB 的东西不要用 git push 传**（50 MB ÷ 150 KB/s ≈ 5.7 分钟，且失败要整包重传），改用 release 资产。

完整实测表、复测方法与选路策略见 `docs/network-baseline.md`（#4 落地）。

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

## 凭据纪律

- token 只存在 `C:\Users\Admin\.skills-vault\download\scripts\.github-token`，**不进仓库、不进 issue 正文、不进任何被 git 跟踪的文件**。
- `.workbuddy/` 整个目录不提交。它的 `memory/` 里天然会出现明文口令、PIN、token——这类文件只该留在本机。
- 提交前自查（**只匹配真正的凭据形状，不是散文关键词**）：
  ```bash
  git diff --cached | grep -nE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(PIN|pin|password|passwd|token)[[:space:]]*[:=][[:space:]]*[^[:space:]'"'"']{6,}'
  ```
  命中即为闸门失败。旧版本写的是 `grep -iE 'ghp_|pin|password|token'`——这个词表会命中 55 行正常散文
  （"token 文件"、"PIN 码"…），等于永远失败、于是没人看，**不能当校验用**。
- 已经泄露过的口令，删文件不够（历史提交里还在）。处置顺序：先轮换口令，再评估是否改写历史。

## Agent skills

### Issue tracker

Issues live as GitHub issues in `dongopencv/tools`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.

## 仓库的双重定位

这个仓库不只管工具，也管**认知**。两件事都必须持续维护：

| 用途 | 落点 | 说明 |
|---|---|---|
| 工具与脚本管理 | `tools/`、`AGENTS.md`、`docs/*.md`（research 除外） | 这台机器上跑了什么、怎么用、踩过什么坑 |
| 个人认知管理 | `docs/research/` | 对重要外部项目的长期跟踪结论、判断依据，以及**后来被推翻的判断** |

`docs/research/` 的写法要求：

- 结论必须能追到**源码位置（带行号）或一次实测**，不能只写「感觉它很成熟」。
- 每条采纳建议必须写明**适用边界与失效条件**——什么情况下这条不成立。
- 保留被推翻的判断（标出「原以为是 X，证据是 Y」）。认知管理的价值在记录**判断如何变化**，不在只留正确答案。
- 引用外部项目源码时写相对路径（`src/policy.ts`），不写本机绝对路径；临时副本放 `work/`（不提交）。

现有研究笔记：[docs/research/superagent.md](docs/research/superagent.md)——DSH Superagent 原型，长期跟踪中。
