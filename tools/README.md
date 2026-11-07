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
| `asset` | 下载 release 资产（**先走 release-assets**，镜像兜底，SHA256 校验） | `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>` |
| `download` | 下载任意 URL（顺序试通道，大文件才上 aria2） | `bash tools/github.sh download <url> -o out.bin -s <sha256>` |
| `raw` | 取文件正文（走 API contents，raw 域不稳时的兜底） | `bash tools/github.sh raw owner/repo master README.md` |
| `clone` | 克隆仓库（SSH 优先，回退镜像） | `bash tools/github.sh clone owner/repo` |
| `push` | 推送（只走 SSH） | `bash tools/github.sh push owner/repo HEAD` |
| `ghdl` | 委派官方 `gh release download` | `bash tools/github.sh ghdl owner/repo v1.2.3 -p '*.zip'` |
| `sshcheck` | 只测 SSH 密钥认证 | `bash tools/github.sh sshcheck` |
| `env` | 打印可直接 eval 的代理 export（中转站在跑才有）；`--config` 打印全部配置变量的当前值 | `eval "$(bash tools/github.sh env)"` / `bash tools/github.sh env --config` |
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

> 这个顺序在 `api`、`status`、`asset` 三处**曾经各不相同**（有的 gh→node→curl，有的只有
> gh→node），同一台机器上「谁先谁后」读代码都预测不出来。2026-11-07 统一成 gh → curl → node
> 一条，以后加传输器只改一处。

### 下载选路（2026-11-06 重做）

老版本是「先逐通道探测再挑最快」，实测这个策略本身比下载还贵：

- 探测比的是 `%{size_download}`，而每个通道都被 `-r 0-1023` 卡在 1024 字节 → 永远只有候选表第一个赢，等于从未测速。
- 镜像对 Range 的处理不一致：有的老实回 `206`，有的直接回 `200` 并开始推整个文件 → 探测只能靠 `--max-time` 硬砍，四个候选一轮 **60+ 秒**，而真正下载只要 0.8–1.6 秒。

现在改成**按候选表顺序直接下，失败或大小不符就换下一条**，选路成本 ≈ 一次真实传输：

1. `asset` 先走 `api.github.com/…/releases/assets/<id>`（302 到 `release-assets.githubusercontent.com`，预签名、直连可达，**全场最快**：同一 324 MB 资产 5.09 MiB/s，而 ghfast 3.39、gh-proxy 1.32）。
2. 失败才回落到 `download` 的候选表：relay(8899) → gh-proxy → ghfast → ghproxy.net → 直连。
3. 每换一条通道都先删半截文件：不同通道未必都支持续传，`-C -` 接手别处残片会算出坏哈希。
4. aria2 只在文件 ≥ 8 MiB 时启用（实测 2.18 MiB 时它与 curl 打平，更小的文件反而慢 6–12 倍）。

实测（同一 2.18 MiB 资产）：改造前 `download` **52.2 s**，改造后 **8.2 s**；`asset` 三轮 3.0 / 3.8 / 12.8 s（第三轮是当时链路自己慢）。

想回到「先测速再选」的旧行为：`GITHUB_PROBE=1 bash tools/github.sh download <url>`。

### 凭据只发给 GitHub 自己的域名

镜像是第三方（`gh-proxy.com` / `ghfast.top` / `ghproxy.net`），把 PAT 塞进它们的请求头等于把
repo / workflow / delete_repo 权限交给别人。实测镜像对公开内容**根本不需要** `Authorization`
（无 token 照样 200 / 206）。所以 `raw` 与 `clone` 的镜像分支都不带凭据，只有
`api.github.com` / `release-assets` / 直连 / relay 才带。

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
  - 本机实测版本：`gh version 2.103.3 (2026-10-26)`（release tag `v2.103.3`）
  - 已装二进制的 SHA256：`d303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd`（`sha256sum '/c/Program Files/GitHub CLI/gh.exe'`）；核对官方 hash 以 `v2.103.3` release 的 `gh_2.103.3_checksums.txt` 为准
- `node`（兜底传输器 + 中转站）
- `aria2c`（可选，多连接下载；没有就回退 curl 续传）
- `ssh` + `~/.ssh/id_ed25519_gh`（push 通道）

实测（本机）：`aria2c` 在 workspace-write 沙箱里会以
`Failed to initialize WinTLS context handle` 失败，脚本会自动回退 curl，
再回退 node fetch。`curl` 在同一沙箱里是 `SEC_E_NO_CREDENTIALS`。
**所以沙箱里真正把文件拉下来的通常是 node fetch 这一段**，前两级是给正常终端用的。

### 退出码

脚本只在有明确语义时才返回非零，方便在别的脚本里判断；不要只看「有没有输出」。

| 码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 | 下载完成并通过 SHA256、API 返回 JSON、push 成功 |
| `1` | 参数或环境错误 | 缺 `owner/repo`、未知选项、缺 SSH 密钥、push 被服务端拒绝 |
| `2` | 网络全通道失败 | 候选通道全试过仍失败；`api` 三个传输器全挂 |
| `3` | 校验失败 / API 明确拒绝 | SHA256 不符、下到 HTML 错误页；GitHub 返回 4xx/5xx（**传输是通的**，别去查网） |
| `4` | 受限会话 | git 无法 fork 传输进程（沙箱），clone/push/fetch 注定失败，需普通终端 |

`3` 与 `2` 的区别是有意的：`2` 说明路不通，`3` 说明路通了但结果不对。历史上把
「GitHub 返回 404」当成传输失败，排查方向直接跑偏。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GITHUB_TOKEN_FILE` | `tools/.github-token`，若不存在则回退 `C:/Users/Admin/.skills-vault/download/scripts/.github-token` | token 文件（**不在仓库里**，靠 `.gitignore` 的 `*.token` 挡住） |
| `GITHUB_DL_DIR` | `$HOME/Downloads/github` | 下载落地目录 |
| `GITHUB_RELAY` | `http://127.0.0.1:8899` | 本地中转站地址（喂给代理变量） |
| `GITHUB_RELAY_HOST` | `127.0.0.1` | 中转站主机（`relay_up` 用它做 TCP 探活） |
| `GITHUB_RELAY_PORT` | `8899` | 中转站端口（同上） |
| `GITHUB_RELAY_SERVER` | `/c/Users/Admin/dsh-mirror-proxy/server.mjs` | 中转站服务文件 |
| `GITHUB_RELAY_CA` | `/c/Users/Admin/dsh-mirror-proxy/certs/ca.crt.pem` | 中转站 MITM 证书；存在时 `env` 会一起导出 `NODE_EXTRA_CA_CERTS` |
| `ARIA2C` | `aria2c` | aria2 可执行文件 |
| `GITHUB_ARIA2_MIN` | `8388608` | 文件小于这个字节数就不用 aria2（小文件多连接是负优化） |
| `GITHUB_PROBE` | `0` | 设 `1` 回到「先逐通道测速再选」的旧策略 |
| `GITHUB_PROBE_BYTES` | `131072` | 测速时每通道拉多少字节 |
| `GITHUB_PROBE_TIMEOUT` | `6` | 测速时单通道超时（秒） |

### 冷 DNS：比带宽更常见的延迟来源

同一个 2.2 MiB 资产连测四次：**15098 / 2187 / 2324 / 11143 ms**，stderr 全是
`curl: (28) Resolving timed out after 5000 milliseconds`。

`release-assets.githubusercontent.com` 冷解析实测要 **11119 ms**，之后 0–1 ms（走 OS 缓存）；
而 curl 的 `--connect-timeout` 把 DNS 也算在内，5 秒一到就报错重试 —— 慢的不是带宽，是解析。

脚本因此在 `fetch_one` 的 `rest` 通道里先调 `dns_warm()`（`tools/github.sh` 第 113 行起）：
用 node 的 `dns.lookup`（走 getaddrinfo，结果留在 OS 缓存）预热 `api.github.com` 与
`release-assets.githubusercontent.com`。**不钉 IP**：DNS 变了能跟得上，只重付一次预热成本。

### 下载失败要能看出来

镜像和 relay 对不存在的资产会回 **HTTP 200 + 正文 `Not Found`**（9 字节）。
早期版本只看 curl 退出码，于是 404 也 `exit=0` 并写出一个 9 字节的假文件。
现在 `fetch_one` 校验 `%{http_code}` 必须是 `2xx`，并对小于 4 KiB 的产物再查一遍
`<!DOCTYPE html` / `Not Found` / `Bad Gateway` / `404:` 等错误页特征。
实测：不存在的资产现在是 **exit=2**，日志写 `[fail] 下载失败（候选表里的通道全试过…）`。

### 这份脚本与 skills-vault 里那份的关系

`C:/Users/Admin/.skills-vault/download/scripts/github.sh`（421 行、只读、由 skill 分发）是**旧副本**，
仍然带着 `sha256sum "$out"` 的 Windows 反斜杠误判。**本仓库的 `tools/github.sh` 才是权威版本**：
它多了 `ghdl` / `env` / `relay` 三个子命令、修掉了校验 bug、也修了 aria2 / curl 的沙箱降级路径。

两份并存本身就是隐患——两个「唯一入口」等于没有入口。收敛方向：以本仓库为准，vault 副本只在
`setup-gh.sh` 与 `.github-token` 这两件**凭据相关**的事上仍有价值。改动不要只改 vault 那份。

### 相关文档

- `docs/network-baseline.md` —— 上下行实测、通道可达性、选路判据（>50 MB 不走 git push）
- `AGENTS.md` —— 本机网络限制与凭据纪律
- `docs/agents/issue-tracker.md` —— issue 操作约定（含沙箱内跑 `gh` 的坑）
