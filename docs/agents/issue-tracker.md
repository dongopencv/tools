# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `dongopencv/tools`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## 本机网络限制（重要，会改变上面所有命令的用法）

这台机器（PC1）**`github.com` 的 HTTPS 443 被墙**，`api.github.com` 与 SSH（22/443）可达。因此：

- 上面所有 `gh` 命令在本机**可以直接用**——`gh` 走 `api.github.com`，不受 443 封锁影响，token 已存在 Windows 凭据管理器。
- **`git clone` / `git push` 一律用 SSH**：`git@github.com:owner/repo.git`。HTTPS 写操作在本机三条路全死（直连被墙 / 本地 8899 MITM 反代只读 / 镜像不转发写）。
- 下载 release 资产、raw 文件不要用 `gh release download`，改用网关脚本，它做了镜像选路和 SHA256 校验：
  `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>`
- 详细原因与踩坑记录见 `C:\Users\Admin\.skills-vault\download\SKILL.md` 的「GitHub 唯一入口」一节。

## agent 沙箱里跑 gh 的硬性注意事项（实测，2026-11-06）

在 DSH agent 会话（沙箱 workspace-write）里操作 issue，和人在终端里手动敲是两回事，以下每条都踩过：

### 1. `gh` 必须显式带 `-R`，或者先离开仓库目录

`gh` 会尝试用当前 git 仓库推断 `owner/repo`，而它推断时要 fork 一个子进程读 remote。沙箱禁止 fork 管道，于是直接失败：

```
failed to run git: pipe: Access is denied.
```

**两种可用写法**（任选其一）：

```bash
gh issue list -R dongopencv/tools --state open          # 显式指定仓库
GH_REPO=dongopencv/tools gh issue list --state open     # 环境变量
cd /tmp && gh issue list --state open                   # 离开仓库目录
```

`gh api ...` **不受影响**（路径里已带 owner/repo，不需要推断），在仓库目录里也能跑。

### 2. 读 issue 正文用 `gh api`，别指望 `gh issue view --comments`

`gh issue view <n> --comments` 在沙箱里**静默返回空**（退出码 0、无输出、也不报错），`--json body` 倒是正常。要正文和评论就分两条：

```bash
gh api repos/dongopencv/tools/issues/<n> --jq '.title, .body'
gh api repos/dongopencv/tools/issues/<n>/comments --jq '.[] | "== \(.user.login) ==\n\(.body)"'
```

`gh issue view <n>`（不带 `--comments`）的纯文本输出是好的，还会显示 `parent:` 和 `sub-issues:`。

### 3. 父子与阻塞边都走原生 API

- **子票挂在 map 下**：`gh api repos/dongopencv/tools/issues/2/sub_issues --jq '.[].number'`
- **反查某票的父票**：`gh api repos/dongopencv/tools/issues/<n>/parent --jq '.number'`
- **阻塞关系**：`gh api repos/dongopencv/tools/issues/<n>/dependencies/blocked_by`；写入要 blocker 的**数据库 id**（`gh api repos/<o>/<r>/issues/<n> --jq .id`），不是 `#` 号。
- **汇总**：`gh api repos/<o>/<r>/issues/<n> --jq '.issue_dependencies_summary'`，其中 `blocked_by` 是**未关闭**阻塞者数量，就是活的闸门。

### 4. 写操作

```bash
gh issue comment <n> -R dongopencv/tools --body "..."
gh issue edit  <n> -R dongopencv/tools --add-label "ready-for-agent"
gh issue close <n> -R dongopencv/tools --comment "resolution 见正文 / 上一条评论"
```

`gh issue comment` **没有** `--dry-run`，别试。

### 5. `curl` 在沙箱里是废的；出网用 `node`

```
curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)
```

不是网络问题，是沙箱没给 curl 需要的 TLS 凭据句柄。要发 HTTP 就用 `node -e` 的 `fetch`（实测能出网、api.github.com 200）。同理 **`git fetch/push/ls-remote` 在沙箱里全废**（`cannot create standard input pipe for ssh: Permission denied`），只有本地 git 操作（commit/branch/worktree/diff/log）可用——push 得由人在非沙箱终端执行，或用网关脚本的 git-data 兜底。

### 6. 凭据纪律

token 在 `C:\Users\Admin\.skills-vault\download\scripts\.github-token`。**不要 `cat` 它、不要把内容写进任何被 git 跟踪的文件或 issue 正文**。上面所有命令都让 `gh` 自己从 keyring 取，不需要你碰 token。

