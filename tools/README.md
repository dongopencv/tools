# tools/

这台机器（PC1）的工具与脚本。每个工具一个文件，一个工具只做一件事。

| 文件 | 用途 |
|---|---|
| `github.sh` | GitHub 访问的**唯一入口**：API、release 资产、raw、clone、push、通道体检 |

## github.sh

本机对 github.com 的网络限制很拧巴（`github.com:443` 被墙、`api.github.com` 通、
写操作只能走 SSH），再加上不同会话里的传输器可用性不一样，所以 GitHub 的访问
统一收敛到这一个脚本，而不是各处裸写 `curl` / `gh` / `git`。

### 用法

```bash
bash tools/github.sh <子命令> [参数…]
```

| 子命令 | 作用 | 例 |
|---|---|---|
| `status` | 全通道体检：gh / 传输器 / token / 中转站 / 可达性 / SSH / git 传输 | `bash tools/github.sh status` |
| `api` | 调 GitHub API（自动在 gh → curl → node 之间选路） | `bash tools/github.sh api repos/owner/repo --jq .full_name` |
| `release` | 列出 release 的 tag / 资产 | `bash tools/github.sh release owner/repo v1.2.3` |
| `asset` | 下载 release 资产（镜像选路 + SHA256 校验） | `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>` |
| `download` | 下载任意 URL（aria2 多连接→curl 续传） | `bash tools/github.sh download <url> -o out.bin -s <sha256>` |
| `raw` | 取文件正文（走 API contents，raw 域不稳时的兜底） | `bash tools/github.sh raw owner/repo master README.md` |
| `clone` | 克隆仓库（SSH 优先，回退镜像） | `bash tools/github.sh clone owner/repo` |
| `push` | 推送（只走 SSH） | `bash tools/github.sh push owner/repo HEAD` |
| `ghdl` | 委派官方 `gh release download` | `bash tools/github.sh ghdl owner/repo v1.2.3 -p '*.zip'` |
| `sshcheck` | 只测 SSH 密钥认证 | `bash tools/github.sh sshcheck` |
| `env` | 打印脚本会用的环境变量 | `bash tools/github.sh env` |
| `relay` | 起停本地 8899 中转站 | `bash tools/github.sh relay up` |
| `token` | 打印 token（调试用，**别贴进 issue/日志**） | `bash tools/github.sh token` |

### 传输器选路

脚本里 `api` 与 `status` 都不把宝押在单一传输器上，顺序是 **gh → curl → node fetch**：

1. **`gh`** —— 自带 TLS 栈，最稳。但在仓库目录里不带 `-R` / `GH_REPO` 会试图 fork git
   推断 remote 而失败（`failed to run git: pipe: Access is denied`）。
2. **`curl`** —— 本机某些会话里 curl 拿不到 TLS 凭据句柄：
   `curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。
   这是 curl 自身的问题，**不是网络也不是 token 的问题**。
3. **`node` 的 `fetch`** —— 永远兜底，本机实测稳定可用。

`status` 会分别报告「传输器」和「token 认证」两节，就是为了不把传输器故障误读成凭据故障。

### 通道探测要说人话

`status` 的每一节都标明「这次结论是哪个传输器给的」。尤其是 API：GitHub 回 4xx/5xx
时脚本报的是 `GitHub 返回错误 → GET /repos/...`，而不是笼统的「三条路全失败」——
后者会把「这个仓库没有 release」这种正常状态误报成网络故障。

`release` 在仓库没有 `latest` release 时会自动回退成列出全部 release。

### 写操作只能走 SSH

`git push` 走 `git@github.com:owner/repo.git`。HTTPS 写在本机三条路全死
（直连被墙 / 8899 上游不支持写 / 镜像不转发写）。

**在受限会话（agent 沙箱）里，git 连传输进程都 fork 不出来**：

```
error: cannot create standard input pipe for ssh: Permission denied
fatal: unable to fork
```

这不是仓库问题、也不是密钥问题。`push` 子命令会先探测这一点（`git_fork_state`），
撞上了就直接告诉你「本地提交照常，推送请在普通终端执行」，而不是报一个误导性的
"push 失败"。本地 `git add` / `commit` / `branch` / `worktree` 全部正常。

### 依赖

- `gh`（必需，MSI 装完要重开 shell 才进 PATH；脚本会自己去 `C:/Program Files/GitHub CLI/gh.exe` 找）
- `node`（兜底传输器 + 中转站）
- `aria2c`（可选，多连接下载；没有就回退 curl 续传）
- `ssh` + `~/.ssh/id_ed25519_gh`（push 通道）

实测（本机）：`aria2c` 在 workspace-write 沙箱里会以
`Failed to initialize WinTLS context handle` 失败，脚本会自动回退 curl，
再回退 node fetch。`curl` 在同一沙箱里是 `SEC_E_NO_CREDENTIALS`。
**所以沙箱里真正把文件拉下来的通常是 node fetch 这一段**，前两级是给正常终端用的。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GITHUB_TOKEN_FILE` | `tools/.github-token`，若不存在则回退 `C:/Users/Admin/.skills-vault/download/scripts/.github-token` | token 文件（**不在仓库里**，靠 `.gitignore` 的 `*.token` 挡住） |
| `GITHUB_DL_DIR` | `$HOME/Downloads/github` | 下载落地目录 |
| `GITHUB_RELAY` | `http://127.0.0.1:8899` | 本地中转站 |
| `GITHUB_RELAY_SERVER` | `/c/Users/Admin/dsh-mirror-proxy/server.mjs` | 中转站服务文件 |
| `ARIA2C` | `aria2c` | aria2 可执行文件 |

### 相关文档

- `docs/network-baseline.md` —— 上下行实测、通道可达性、选路判据（>50 MB 不走 git push）
- `AGENTS.md` —— 本机网络限制与凭据纪律
- `docs/agents/issue-tracker.md` —— issue 操作约定（含沙箱内跑 `gh` 的坑）
