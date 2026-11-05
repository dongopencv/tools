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

## 本机网络限制（重要）

**`github.com` 的 HTTPS（443）被墙**，直连 100% 超时。可达的只有：

- `api.github.com` — `gh` CLI 走这条，不受影响
- SSH `github.com:22`（约 4/5 成功率）与 `ssh.github.com:443`（5/5）— 这是唯一的 `git push` 通道

因此：

- **`git clone` / `git push` 一律用 SSH**：`git@github.com:owner/repo.git`。HTTPS 写操作在本机三条路全死（直连被墙 / 本地 8899 MITM 反代只读 / 镜像不转发写）。
- 所有 GitHub 操作（API / 下载 / clone / push）统一走仓库里的网关脚本 `tools/github.sh`，别手搓 `curl`/`gh` 直连，也别用 `gh release download`：
  `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>`
  用法见 `tools/README.md`；背景与踩坑见 `C:\Users\Admin\.skills-vault\download\SKILL.md` 的「GitHub 唯一入口」一节。

## 实测网络速度（2026-11-06）

上行 140–200 KB/s，下行同时段约 90 KB/s。20 MB 的 push 约 1.5–2.5 分钟。**大于 50 MB 的东西不要用 git push 传**，改用 release 资产。

复测方法与完整选路策略见 `docs/network-baseline.md`。

## agent 沙箱与交互终端不一样（重要）

在 DSH agent 会话里，本机这套工具的行为和你在终端里手敲有实质差别，下面每条都实测过：

| 操作 | 沙箱内 | 说明 |
|---|---|---|
| `gh issue/list/api ...` | ✅ 可用 | 但**必须带 `-R dongopencv/tools`** 或 `GH_REPO=` 环境变量，否则报 `failed to run git: pipe: Access is denied` |
| `gh api ...` | ✅ 可用 | 路径里自带 owner/repo，不需要推断，仓库目录里也能跑 |
| `gh issue view <n> --comments` | ❌ 静默返回空 | 退出码 0 但没有输出；正文和评论改用 `gh api .../issues/<n>` 与 `.../comments` |
| `curl` 任意 HTTPS | ❌ 全废 | `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，不是网络问题 |
| `node -e` 的 `fetch` | ✅ 可用 | 沙箱内唯一可靠的出网方式 |
| `git` 本地操作 | ✅ 可用 | commit / branch / worktree / diff / log 都正常 |
| `git` 远端操作 | ❌ 全废 | `fetch/push/ls-remote` 一律 `cannot create standard input pipe for ssh: Permission denied` / `fatal: unable to fork` |
| `ssh -T git@github.com` | ✅ 可用 | 单独的 ssh 进程能通（`Hi dongopencv!`）；只有 git 要 fork 它时被拦 |

含义：**agent 能读写 issue、能改文件、能本地提交，但不能把提交推上去**。push 得由人在非沙箱终端跑 `bash tools/github.sh push dongopencv/tools <ref>`，或由人直接 `git push`。

## 凭据纪律

- token 只存在 `C:\Users\Admin\.skills-vault\download\scripts\.github-token`，**不进仓库、不进 issue 正文、不进任何被 git 跟踪的文件**。
- `.workbuddy/` 整个目录不提交。它的 `memory/` 里天然会出现明文口令、PIN、token——这类文件只该留在本机。
- 提交前自查：`git diff --cached | grep -iE 'ghp_|pin|password|token'` 应为空。

## Agent skills

### Issue tracker

Issues live as GitHub issues in `dongopencv/tools`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.
