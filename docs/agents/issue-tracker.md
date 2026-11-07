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

## 本机网络限制

这台机器（PC1）**`github.com` 的 HTTPS 443 被墙**（实测 `curl https://github.com/` 15 s 超时、http_code 000），`api.github.com` 与 SSH（22/443）可达。因此：

- 上面所有 `gh` 命令在本机**可以直接用**——`gh` 走 `api.github.com`，不受 443 封锁影响，token 已存在 Windows 凭据管理器。
- **`git clone` / `git push` 一律用 SSH**：`git@github.com:owner/repo.git`。HTTPS 写操作在本机三条路全死（直连被墙 / 本地 8899 MITM 反代只读 / 镜像不转发写）。
- 下载 release 资产、raw 文件优先走网关脚本（镜像回退 + SHA256 校验 + 断点续传）：
  `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>`
- `gh release download` **不是不能用**：它经 `api.github.com` 302 到 `release-assets.githubusercontent.com`，全程不经 github.com，本机实测可用。网关的价值在镜像回退与校验，不是替代它。
- 详细原因与踩坑记录见 `tools/README.md`（本仓库权威副本）；`C:\Users\Admin\.skills-vault\download\SKILL.md` 是同一套做法的旧说明，命令仍可用但没跟上仓库里的修复。

### API 走网关单入口

#5 的要求是「把 GitHub 访问收敛到 `github.sh` 单入口」，所以**读 API 优先走网关**：
它自带 gh → curl → node 三级选路，还能把「GitHub 返回 4xx/5xx」和「传输器坏了」分开报
（裸 `gh api` 只能给你一个退出码）。

```bash
# 读（等价于 gh api，但错误分类更清楚）
bash tools/github.sh api repos/dongopencv/tools/issues/3 --jq '.title'
# 某个仓库没有 latest release 时报「GitHub 返回错误」，不再报「网络故障」
bash tools/github.sh api repos/<owner>/<repo>/releases/latest
```

裸 `gh api` 仍然可用（它是网关的第一级传输器），但**新写脚本时优先用网关**。
**例外**：issue 的写操作（comment / edit / close / 父子边）走 `gh issue ...` / `gh api --method`，
网关的 `api` 子命令只封装了 GET。

## agent 会话里的行为差异（取决于文件策略，不是机器属性）

DSH 会话的**文件策略不同，同一批命令的结果完全不同**。先探明策略，再决定写哪个命令：

```bash
gh issue view 3 --json number   # 成功 = 宽策略；报 pipe: Access is denied = workspace-write 沙箱
```

| 操作 | 宽策略（danger-full-access） | workspace-write 沙箱 |
|---|---|---|
| `gh issue`/`gh list` 不带 `-R` | ✅ 自动从 git remote 推断 | ❌ `failed to run git: pipe: Access is denied.` |
| `gh api …` | ✅ | ✅ 路径自带 owner/repo，不需要 fork git |
| `gh issue view <n> --comments` | ✅ | ❌ 退出码 1、stdout 空、stderr `failed to run git: pipe: Access is denied.`（**不是**静默返回空） |
| `curl` 任意 HTTPS | ✅ | ❌ `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` |
| `git fetch`/`push`/`ls-remote` | ✅ | ❌ `cannot create standard input pipe for ssh: Permission denied` |
| `node -e` 的 `fetch` | ✅ | ✅ 沙箱内最稳的出网方式 |

**通用写法（两种策略下都能跑）**：显式带仓库，避免依赖推断。

```bash
gh issue list -R dongopencv/tools --state open
GH_REPO=dongopencv/tools gh issue list --state open
gh api repos/dongopencv/tools/issues/3 --jq '.title, .body'
gh api repos/dongopencv/tools/issues/3/comments --jq '.[] | "== \(.user.login) ==\n\(.body)"'
```

## 父子与阻塞边（实测端点，2026-11-06）

- **子票挂在 map 下（读）**：`gh api repos/dongopencv/tools/issues/2/sub_issues --jq '.[].number'`
- **挂载（写）**：`gh api --method POST repos/dongopencv/tools/issues/2/sub_issues -F sub_issue_id=<子票数据库 id>`，返回子票号即成功。
- **摘除（写）**：`gh api --method DELETE repos/dongopencv/tools/issues/2/sub_issue -F sub_issue_id=<子票数据库 id>`。注意是**单数 sub_issue 且 id 走 body**；写成 `/sub_issues/<id>` 会 404。
- **反查父票**：`gh api repos/dongopencv/tools/issues/<n>/parent --jq '.number'`
- **阻塞边读**：`gh api repos/dongopencv/tools/issues/<n>/dependencies/blocked_by`
- **阻塞边写**：`POST repos/<o>/<r>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker 数据库 id>`；删：`DELETE repos/<o>/<r>/issues/<child>/dependencies/blocked_by/<blocker 数据库 id>`。
- **汇总**：`gh api repos/<o>/<r>/issues/<n> --jq '.issue_dependencies_summary'`。字段含义不一样，别混：
  - `blocked_by` = **仍未关闭**的阻塞者数量（活闸门）
  - `total_blocked_by` = 全部阻塞者数量（含已关闭）
  - 删掉阻塞边后 `blocked_by` 立刻归 0；若阻塞者只是被关闭，`total_blocked_by` 仍保留。

## 写操作

```bash
gh issue comment <n> -R dongopencv/tools --body "..."
gh issue edit  <n> -R dongopencv/tools --add-label "ready-for-agent"
gh issue close <n> -R dongopencv/tools --comment "resolution 见正文 / 上一条评论"
```

- `gh issue comment` **没有** `--dry-run`，别试。
- 探针票用完要删干净：关闭只是留着，删除用 `gh api graphql -f query='mutation($id:ID!){deleteIssue(input:{issueId:$id}){repository{name}}}' -f id=<node_id>`；删除后再读该票返回 HTTP 410。

## 凭据纪律

token 在 `C:\Users\Admin\.skills-vault\download\scripts\.github-token`。**不要 `cat` 它、不要把内容写进任何被 git 跟踪的文件或 issue 正文**。上面所有命令都让 `gh` 自己从 keyring 取，不需要你碰 token。
