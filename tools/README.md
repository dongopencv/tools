# tools/

这台机器（PC1）的工具与脚本。每个工具一个文件，一个工具只做一件事。

| 文件 | 用途 |
|---|---|
| `github.sh` | GitHub 访问的**唯一入口**：API、release 资产、raw、clone、push、通道体检 |
| `attention.sh` | 票库注意力视图：等我拍板 / agent 可接 / 被阻塞 / 沉睡 |
| `handoff-check.mjs` | dsh-auto-handoff 现网核验：代码版本 / 链深 / 日志刷屏 / 文档结构 / 简报送达 / 离线测试 |

## github.sh

本机到 GitHub 只有两条通道：`api.github.com`（读）与 SSH（写）。`github.com` 的 443
在本机是 TCP 层连不上，加上冷缓存下 getaddrinfo 要 ~12 s、不同会话里的传输器可用性还不一样，
所以 GitHub 的访问统一收敛到这一个脚本，而不是各处裸写 `curl` / `gh` / `git`。

### 用法

```bash
bash tools/github.sh <子命令> [参数…]
```

| 子命令 | 作用 | 例 |
|---|---|---|
| `status` | 全通道体检：gh / 传输器 / token / 可达性 / SSH / git 传输 | `bash tools/github.sh status` |
| `api` | 调 GitHub API（自动在 gh → curl → node 之间选路） | `bash tools/github.sh api repos/owner/repo --jq .full_name` |
| `release` | 列出 release 的 tag / 资产 | `bash tools/github.sh release owner/repo v1.2.3` |
| `asset` | 下载 release 资产（走 api 资产端点 → release-assets，SHA256 校验） | `bash tools/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>` |
| `download` | 下载任意 URL；release 直链会自动换成 API 资产端点（大文件才上 aria2） | `bash tools/github.sh download <url> -o out.bin -s <sha256>` |
| `raw` | 取文件正文（走 API contents，raw 域不稳时的兜底） | `bash tools/github.sh raw owner/repo master README.md` |
| `clone` | 克隆仓库（SSH 优先，不通才 HTTPS 直连） | `bash tools/github.sh clone owner/repo` |
| `push` | 推送（只走 SSH：22 不通自动改 ssh.github.com:443） | `bash tools/github.sh push owner/repo HEAD` |
| `ghdl` | 委派官方 `gh release download` | `bash tools/github.sh ghdl owner/repo v1.2.3 -p '*.zip'` |
| `sshcheck` | 只测 SSH 密钥认证 | `bash tools/github.sh sshcheck` |
| `env` | 打印全部配置变量的当前值 | `bash tools/github.sh env --config` |
| `token` | 打印 token（调试用，**别贴进 issue/日志**） | `bash tools/github.sh token` |

### 传输器选路

脚本里 `api` 与 `status` 都不把宝押在单一传输器上，顺序是 **gh → curl → node fetch**：

1. **`gh`** —— 自带 TLS 栈，最稳。但在仓库目录里不带 `-R` / `GH_REPO` 会试图 fork git
   推断 remote 而失败（`failed to run git: pipe: Access is denied`）。
2. **`curl`** —— 本机某些会话里 curl 拿不到 TLS 句柄：
   `curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。
   这是 curl 自身的问题，**不是网络也不是 token 的问题**。
3. **`node`（`tools/ghfetch.cjs`）** —— 兜底，也是**下载数据面**的首选。它不是 `fetch`：自己问 DNS（见下文「冷 DNS」），
   并按目标选 `Accept`（资产端点必须 `application/octet-stream`，否则回 1470 字节元数据 JSON）。

`status` 会分别报告「传输器」和「token 认证」两节，就是为了不把传输器故障误读成 token 故障。

> 这个顺序在 `api`、`status`、`asset` 三处**曾经各不相同**（有的 gh→node→curl，有的只有
> gh→node），同一台机器上「谁先谁后」读代码都预测不出来。2026-11-07 统一成 gh → curl → node
> 一条，以后加传输器只改一处。

### 下载选路（2026-11-08 重做）

老版本是「先逐通道探测再挑最快」，实测这个策略本身比下载还贵：

- 探测比的是 `%{size_download}`，而每个通道都被 `-r 0-1023` 卡在 1024 字节 → 永远只有候选表第一个赢，等于从未测速。
- 不同通道对 Range 的处理不一致：有的老实回 `206`，有的直接回 `200` 并开始推整个文件 → 探测只能靠 `--max-time` 硬砍，一轮 **60+ 秒**，而真正下载只要 0.8–1.6 秒。

现在改成**先换 API 端点、数据面交给 node 抢跑、失败或大小不符才换下一条**，选路成本 ≈ 一次真实传输：

1. **一律先换 API 资产端点** `api.github.com/…/releases/assets/<id>`（302 到 `release-assets.githubusercontent.com`，预签名、直连可达）。这不是优化，是**唯一能通的路**：`github.com` 在本机是 TCP 层连不上（`net.connect` 实测 6 s 超时 ×2、`curl` exit 28）。
2. `download` 收到 `https://github.com/O/R/releases/download/TAG/FILE` 这种直链时，会自动查 `releases/tags/TAG` 拿 asset id 再下 —— 你不用记两条命令。
3. 每个步骤都先删半截文件：不同通道未必都支持续传，`-C -` 接手别处残片会算出坏哈希。
4. **数据面先交给 node：四个 IP 并发抢跑，谁先回响应头谁赢。** `release-assets.githubusercontent.com`
   解析出 4 个 IP，好坏不一（见下表）。curl 只能逐个试，抽到坏的那个要按 `--speed-time` 白等一轮；
   `ghfetch.cjs` 把 4 个请求同时发出去，第一个回响应头的赢、其余立刻掐断。
5. **curl 退成兜底**，并且同样逐个 IP 试 + 慢就砍（`--speed-limit 98304 --speed-time 12`：
   低于 96 KB/s 持续 12 s 就换下一个 IP）。连上了不代表传得动 —— 出现过单轮 44 s（≈58 KB/s）
   而 `--connect-timeout` 全程没触发，因为连接早建好了，卡在传输。
6. aria2 只在文件 ≥ 8 MiB 时启用（实测 2.5 MiB 时它与 curl 打平，更小的文件反而慢 6–12 倍）。

### release-assets 有四个 IP，好坏不一（2026-11-08）

`release-assets.githubusercontent.com` 解析出 4 个 IP。同一 2.5 MiB 资产用 `curl --resolve`
逐个钉住各跑 2 次：

| IP | 单次耗时 | 有效速率 |
|---|---|---|
| `185.199.108.133` | 2.14 / 3.02 s | 0.84–1.19 MB/s |
| `185.199.109.133` | 2.42 / 2.58 s | 0.99–1.05 MB/s |
| `185.199.110.133` | 2.79 / 2.73 s | 0.91–0.93 MB/s |
| `185.199.111.133` | 6.93 / 14.02 s | **0.18–0.37 MB/s** |

另一轮里 `.110.133` 连续 3 次只拿到 0 字节。**四个里至少有一个会坏，坏的是哪个并不固定** ——
所以只钉第一个 IP 时好坏全靠运气，这就是同一条命令 4 s 还是 44 s 的来源。

**并发抢跑是在绕开一个真实的坏节点，不是微优化。** 同一 2.5 MiB 资产、每轮 `flushdns` 的 A/B：

| 实现 | 冷缓存 8 轮 | 中位 |
|---|---|---|
| `ghfetch.cjs` 四 IP 抢跑 | 2161 / 2427 / 1930 / 2757 / 2271 / 2210 / 2771 ms | **~2.2 s** |
| curl 逐个 IP 试 | 7431 / 3759 / 3696 / 4574 / 11945 / 10043 / 17836 / 14922 ms | **~8.7 s** |

实测（每轮 `ipconfig /flushdns` + 删 `~/.cache/pc1-pin-*`，2.5 MB 资产，node 打头之后）：

- `asset` 连跑 8 轮：**3.5–4.5 s**（最慢一轮 6.3 s）
- `download`（直链自动改写）**3.5–3.7 s**；`raw`（10600 B 正文）**1.3 s**
- 17.7 MB 资产走 aria2 8 连接：**7.7–8.7 s**
- 资产名写错 **2.2 s 内**失败并说清是 tag/文件名不对（`exit=1`）

改之前同一台机器冷缓存下 `download` 直链是直接失败、`asset` 的 node 兜底会把 1470 字节 JSON 当成品存盘并报「完成」。

想回到「先测速再选」的旧行为：`GITHUB_PROBE=1 bash tools/github.sh download <url>`。

### `status` 自己也要快（2026-11-08）

`status` 要探 5 条 HTTPS + 2 条 SSH + git 传输，全串行时实测 35–58 s —— 用户根本不会等，
等于没测。现在全部并行（`& + wait`，结果写临时文件再按表顺序打印），并且：

- SSH 探针与 `push`/`clone` 一样钉 IP（`ssh -o HostName=<ip> -o HostKeyAlias=<name>`）。
  `ssh` 也走 getaddrinfo，冷的时候解析一次就 3–14 s（实测 4 轮 3.2/3.4/12.5/14.4 s）；
  钉住后 4 轮 3.4/3.6/4.7/4.9 s。`HostKeyAlias` 保持 known_hosts 里的名字不变。
- 「git 能不能 fork 传输进程」不再单独跑一遍 `git ls-remote`（那一步自己要 7–15 s）：
  两条 SSH 都认证成功了就是能 fork（push/fetch 靠的就是它），直接据此下结论。
  只有 SSH 也不通时，才值得花那 15 s 跑一次 ls-remote —— 因为那时才需要区分「网络挂了」和「沙箱禁了 fork」。

实测：**58.6 s → 6.8 s**（冷缓存，含 flushdns 后重新解析；偶尔撞上解析抖动会到 17.9 s）。

### 通道探测要说人话

`status` 的每一节都标明「这次结论是哪个传输器给的」。尤其是 API：GitHub 回 4xx/5xx
时脚本报的是 `GitHub 返回错误 → GET /repos/...`，而不是笼统的「三条路全失败」——
后者会把「这个仓库没有 release」这种正常状态误报成网络故障。

`release` 在仓库没有 `latest` release 时会自动回退成列出全部 release。

### 写操作只有 SSH 一条

```bash
bash tools/github.sh push owner/repo HEAD     # 只走 SSH；22 不通自动改 ssh.github.com:443
```

`github.com:443` 连不上**不影响 push**：写走 SSH，读走 `api.github.com`。别为它加通道。

SSH 报 `Permission denied (publickey)` = **账号上没有这把公钥**，既不是 config 问题也不是网络问题。
自检：`ssh-keygen -l -f ~/.ssh/id_ed25519_gh.pub` 拿到指纹，再对照公开端点
`bash tools/github.sh api users/<owner>/keys`（或网页 https://github.com/settings/keys）。
细粒度 PAT 读/写不了账号级公钥（`gh api user/keys` 返回 403），**加公钥只能人工在设置页做**。
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
- `node`（兜底传输器，实现在 `tools/ghfetch.cjs`；自己解析 DNS + 自动选 `Accept`）
- `aria2c`（可选，多连接下载；没有就回退 curl 续传）
- `ssh` + `~/.ssh/id_ed25519_gh`（push 的唯一通道）

实测（本机）：`aria2c` 在 workspace-write 沙箱里会以
`Failed to initialize WinTLS context handle` 失败，脚本会自动回退 curl，
再回退 node fetch。`curl` 在同一沙箱里是 `SEC_E_NO_CREDENTIALS`。
**所以沙箱里真正把文件拉下来的通常是 node fetch 这一段**，前两级是给正常终端用的。

### 退出码

脚本只在有明确语义时才返回非零，方便在别的脚本里判断；不要只看「有没有输出」。

| 码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 | 下载完成并通过 SHA256、API 返回 JSON、push 成功 |
| `1` | 参数或环境错误 | 缺 `owner/repo`、未知选项、SSH 被服务端拒绝 |
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
| `ARIA2C` | `aria2c` | aria2 可执行文件 |
| `GITHUB_ARIA2_MIN` | `8388608` | 文件小于这个字节数就不用 aria2（小文件多连接是负优化） |
| `GITHUB_PROBE` | `0` | 设 `1` 回到「先逐通道测速再选」的旧策略 |
| `GITHUB_PROBE_BYTES` | `131072` | 测速时每通道拉多少字节 |
| `GITHUB_PROBE_TIMEOUT` | `6` | 测速时单通道超时（秒） |
| `GITHUB_DNS_PIN_TTL` | `600` | 钉住的 IP 缓存多久（秒）；到点重解析一次，代价约 120 ms |
| `GITHUB_PIN_HOSTS` | `api.github.com release-assets.githubusercontent.com` | 用 `--resolve` 钉 IP 的域名；**别把 `github.com` 加进来**，它的问题是 TCP 层 |

### 冷 DNS：本机真正的延迟来源（2026-11-08 定位）

`ipconfig /flushdns` 之后，用 getaddrinfo 解析**任何**域名都要 ~12 s：

| 域名 | 冷解析 |
|---|---|
| `example.com` | 12013 ms |
| `baidu.com` | 12025 ms |
| `api.github.com` | 12048 ms |
| `release-assets.githubusercontent.com` | 12040 ms |

不是 GitHub 的问题，是 **OS 解析栈**的问题：本机两块非物理网卡（「本地连接* 9 / * 10」）
挂着 DHCP 下发的 IPv6 DNS（`fec0:0:0:ffff::1%1` 等 ISATAP/Teredo 伪地址），getaddrinfo 会先等它们超时。
`Resolve-DnsName github.com -Type A -DnsOnly` 同样是 12161 ms —— 与 node、与 curl 都无关。
而直接问 `192.168.0.1` / `119.29.29.29` / `223.5.5.5` 只要 **5–120 ms**。

脚本的应对（两条路都用，各管一段）：

1. **`fast_ip()`（`tools/github.sh`）** —— 问快解析器拿 IP，用 `curl --resolve host:443:IP` 钉住，
   curl 就完全不碰 getaddrinfo。结果缓存在 `~/.cache/pc1-pin-*`，TTL `GITHUB_DNS_PIN_TTL`（默认 600 s）。
2. **`tools/ghfetch.cjs`** —— node 那条兜底以前用 `fetch`/`undici`，而 undici 只能走 getaddrinfo，
   冷缓存下实测 **12130 ms 后失败**。现在改成 `dns.Resolver` 直接问上面那几个服务器，
   再把 IP 通过 `https.request` 的 `lookup` 选项钉住，同一个 2.12 MiB 资产冷缓存 **2731 ms 拿全**。

被钉住的只有两个域：`api.github.com`、`release-assets.githubusercontent.com`。
**`github.com` 不钉** —— 它的问题在 TCP 层（`net.connect` 6 s 超时 ×2），钉 IP 救不了，改走 API 端点。
DNS 变了能跟得上：TTL 到点就重解析，最坏重付一次 ~120 ms（不是 12 s）。

`curl -V` 显示本机 curl 没有 c-ares，所以 `--dns-servers` 会直接报不支持（exit 2），只能这样绕。

### 下载失败要能看出来

有些直链对不存在的资产会回 **HTTP 200 + 正文 `Not Found`**（9 字节）。
早期版本只看 curl 退出码，于是 404 也 `exit=0` 并写出一个 9 字节的假文件。
现在 `fetch_one` 校验 `%{http_code}` 必须是 `2xx`，并对小于 4 KiB 的产物再查一遍
`<!DOCTYPE html` / `Not Found` / `Bad Gateway` / `404:` 等错误页特征。
实测：不存在的资产现在是 **exit=2**，日志写 `[fail] 下载失败（候选表里的通道全试过…）`。

### 这份脚本与 skills-vault 里那份的关系（2026-11-07 已收敛）

**只有一份实现：本仓库的 `tools/github.sh`。**

`C:/Users/Admin/.skills-vault/download/scripts/github.sh` 现在是一个 **转发器（shim）**（29 行 / 1099 B，真正的逻辑只有定位 + `exec` 那 10 行，其余是注释），执行时 `exec` 到本仓库的这份，自己不含任何逻辑：

```bash
bash C:/Users/Admin/.skills-vault/download/scripts/github.sh status   # 跑的是仓库里的真身，不是另一份实现
```

- 定位顺序：`$GITHUB_GATEWAY` → `$HOME/proj/PC1/tools/github.sh` → `/d/proj/PC1/tools/github.sh`。仓库换位置就 `export GITHUB_GATEWAY=/path/to/tools/github.sh`。
- 收敛前 vault 那份是 421 行旧副本（缺 `ghdl`/`env`，且带着 `sha256sum "$out"` 的 Windows 反斜杠误判），已备份为同目录 `github.sh.bak-2026-11-07-pre-shim`。**不要再改那份备份、也不要照着它改。**
- vault 根 `~/.skills-vault` 是三个客户端的 junction 目标（`~/.workbuddy/skills`、`~/.trae-cn/skills`、`~/.dsh/skills`），所以 `bash <任意客户端>/download/scripts/github.sh` 走到的都是同一个真身。
- vault 里仍独立存在的只有两件与网关无关的东西：`setup-gh.sh`（五段向导）与 `.github-token`（token 文件，真身也把它当 fallback 读，见脚本第 37–41 行）。它们不属于网关实现，不在收敛范围内。
- 改网关只改本仓库 `tools/github.sh`，commit + push；vault 侧不需要同步，也不会再分叉。

### 相关文档

- `docs/network-baseline.md` —— 上下行实测、通道可达性、选路判据（>50 MB 不走 git push）
- `AGENTS.md` —— 本机网络限制与 token 位置
- `docs/agents/issue-tracker.md` —— issue 操作约定（含沙箱内跑 `gh` 的坑）
- `AGENTS.md` 的「授权：一次配到底」—— 细粒度 PAT 该给哪四项、有效期怎么选

## issue-closeout.sh

票库写权限补齐后，一次性把 #5 的收尾做完（幂等，默认只演练）：

```bash
bash tools/issue-closeout.sh            # 演练：打印每一步要执行的命令，不写
bash tools/issue-closeout.sh --apply    # 真写
```

五步：预检读写权限 → 删旧评论 → 重发 resolution → 回写 #5 正文 → 给 map #2 补 Decisions 第 11 条。
幂等靠正文里的 HTML 注释标记（`<!-- resolution-2026-11-08-vault-forwarder -->` 等），重复跑会 `[skip]`。

退出码：`0` 完成；`2` 权限不足（会打印实测的 `X-Accepted-Github-Permissions` 与要改哪两项）；`3` 前置文件缺失。

**为什么要有这个脚本**：上一版是四条手敲命令，其中一条用 `-f body="$(cat …)"` 把正文内联进 shell，
正文里的反引号被当成命令替换执行，把本地 token 文件的内容写进了公开评论，GitHub 侧随即作废了那枚 token。
脚本把所有正文都走 `-F body=@file`，杜绝这一类。

正文素材在 `docs/pending-issues/i5-comment.md` 与 `map-gist.md`，改内容改那两个文件即可。

## attention.sh

票越开越多、大部分卡在别人的票后面，于是干脆不看了。这个脚本把整个票库收敛成
**「今天该管哪几件」**，人只管从里面挑一件。

```bash
bash tools/attention.sh              # 默认全部，沉睡阈值 3 天
bash tools/attention.sh --days 7     # 沉睡阈值改成 7 天
bash tools/attention.sh --blocks     # 额外打印阻塞链的下一动作
bash tools/attention.sh -R o/r       # 换仓库（默认 dongopencv/tools）
```

输出分五段，另加可选的第六段：

| 段 | 判据 | 含义 |
|---|---|---|
| 1. 等我拍板 | 无人认领 + 有 `w:grilling` 或 `needs-triage` | **我不决定，它就永远停着**。这是唯一必须由人做的事 |
| 2. agent 可接 | 无人认领 + 无 OPEN 阻塞者 + 非上面两类 | 即 wayfinder 的 frontier，可以直接认领开工 |
| 3. 被阻塞 | 有 OPEN 阻塞者 | 显示「等 <- #a,#b」，先动左边才能动右边 |
| 4. 地图进度 | label `wayfinder:map` | 子票张数 + 开图天数 |
| 5. 沉睡 | 最后 update >= N 天 | 该降级、合并或关掉，别再假装还在跟 |
| 6. 阻塞链（--blocks） | 被阻塞段的展开 | 「#阻塞者 -> #被阻塞者 阻塞者标题」 |

设计要点：

- **只读**：不发任何写请求，不改票、不打标签、不 assign。判断权留在人手里。
- 一次 `gh issue list --json …,blockedBy,parent,assignees` 取全量，靠 gh 自带聚合，
  不逐票 round-trip（35 张票 1 次调用，约 2 秒）。
- **字段分隔符用 `|` 不用 TAB**：bash 的 `IFS` 把 TAB 当空白类，连续 TAB 会塌成一个，
  空字段（未认领、无标签、无父票）会让整行左移 —— 2026-11-08 实测踩过，症状是
  `date: invalid date 会话治理的路线裁决…` 和所有区间都是 `(空)`。
- 年龄用 `date -d` 算，失败回退 0：一条坏日期不该毁掉整个视图。

2026-11-08 首次实跑（沉睡 3d）：合计 open 35 张，等我 7 · 可接 11 · 被阻塞 12 · 地图 5 · 沉睡 14。

## handoff-check.mjs

`dsh-auto-handoff` 是「检测→落盘→REVIEW→开新会话续作」四段流水线。它出问题的方式很阴——
**看起来在跑，其实只跑通了前半段**：文档写了、新会话建了，简报没送到；或者代码改好了，
宿主还在跑旧模块。这个脚本把「它到底有没有真的工作」压成一条命令，不用每次人肉翻日志。

```bash
node tools/handoff-check.mjs            # 常规核验，扫最近 15 个会话
node tools/handoff-check.mjs --deep     # 额外扫 40 个会话 + 跑四套离线测试
```

七个检查项（每项打 ✅ PASS / ◐ WARN / ❌ FAIL）：

| 检查项 | 判据 | 判成 FAIL 说明什么 |
|---|---|---|
| 代码版本 | `lib/index.js` 的 mtime 是否晚于 `hub.log` 最后一条 `system.start` | 现网跑的是旧模块——改完没重启，白改 |
| 链深（genesis 修复） | `claims.json` 里 `chainDepth>=1` 的记录是否出现 `genesis` | 新会话被写成 `done`（终态），链条停在第 2 棒、`chainLimit` 形同废纸 |
| 交接是否真发生过 | 日志里 `已交接：` 的条数与最后一次 | 一次都没成 = 闸门或投递有硬故障 |
| 交接前 REVIEW | 日志里 `交接前 REVIEW` 的次数 | 落盘了但没审，等于跳过了流水线的第三段 |
| 日志刷屏 | `轮中触发被占位拦下` 占日志行数比例（>50% = WARN） | 工具调用计数是累计值、没有「本轮已处理」标记，每个 tool/call 都重走一遍闸门 |
| 交接文档结构 | 最新一份 md 是否含 `## 交接前 REVIEW` | 文档是旧版渲染，新会话拿到的是残缺简报 |
| 简报送达 | 最近 N 个会话里，`user/message` 是否以 `[自动交接] 上一会话` 开头 | `sessionController.prompt` 的第二参数（signal）漏传，第一行 `signal.throwIfAborted()` 就抛 |
| 离线测试（--deep） | `test/{chain,claims,integration,midturn}.test.mjs` 的 PASS 数 | 回归被改坏了 |

设计要点：

- **「简报送达」只认 `user/message` 行**：早先版本在全文里 grep 关键词，命中过 4 个「送达」，
  结果全是助手读源码时把 `promptText` 拼接代码贴进了对话——假阳性 100%。现在按事件类型收窄。
- **会话日志必须按 zstd frame 逐帧解**：`session.v4.jsonl.zstd` 是多帧拼接，
  `zstdDecompressSync(整个文件)` 只解出第一帧（188 字节的 header），会把有内容的会话误判成空会话。
  脚本按 magic `0x28B52FFD` 切帧。
- **只读**：不写插件状态、不动台账、不发网络请求。唯一的副作用是 `--deep` 会在临时目录里跑测试
  （测试自己把 `USERPROFILE` 指到临时目录，不污染真账本）。
- 环境变量可覆盖路径：`HANDOFF_PLUGIN_DIR`（插件源码目录）、`HANDOFF_OUT_DIR`（交接文档目录）。
- 退出码 0 = 没有 FAIL，1 = 有 FAIL，可直接进 `&&` 链。


## handoff-metrics.mjs

`handoff-check.mjs` 回答「它坏了没有」，这个脚本回答**「阈值该设多少、验收够不够」**。

2026-11-08 的处境：默认阈值 `tokenThreshold: 300000` / `toolCallThreshold: 80` 是拍的，没人知道
真实交接发生在多少 token 上；日志里 99% 是同一句刷屏；`chainLimit = 8` 从来没被跑到过。
这些都得用**真实运行数据**回答，不能拍脑袋。脚本只读现有证据，不跑插件、不改配置。

```bash
node tools/handoff-metrics.mjs            # 人读报告
node tools/handoff-metrics.mjs --json     # 机读（喂给别的脚本/看板）
node tools/handoff-metrics.mjs --verify   # 有 FAIL 就 exit 1，进 && 链
```

四处证据（缺哪处就降级，不报错）：

| 证据 | 路径 | 用来算什么 |
|---|---|---|
| 插件日志（含 `.1` 轮转） | `~/.dsh/auto-handoff/auto-handoff.log` | 交接次数、触发/拦下比例、噪声比、配置代数 |
| 结构化事件 | 同目录 `events.jsonl`（还没有） | 有就用，没有就退回正则解析中文日志 |
| 占位台账 | 同目录 `claims.json` | 链深分布、终态分布、`chainLimit` 有没有被跑到 |
| 会话窗口 | `~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd` 的 `request/context` | 模型 `contextWindow`，把绝对 token 换算成窗口占比 |

八条可观测验收（✅ PASS / ◐ WARN / ❌ FAIL）：

| 验收项 | 判据 | 不满足说明什么 |
|---|---|---|
| 日志行带 sessionId | 有 `[session-…]` 前缀 | 多会话并发时日志无法归属，等于没法查 |
| 有结构化事件通道 | 存在 `events.jsonl` | 只能正则解析中文日志，字段靠猜，改文案就崩 |
| 触发与拦下能分开统计 | 真触发与「被占位拦下」两类可区分 | 无法判断「不重复交接」是真生效还是闸门卡死 |
| 日志噪声比 < 20% | 拦下行 / 总行数 | 刷屏会把真正的一次交接埋掉，且日志 1 MiB 就滚掉 |
| 交接点能对上模型窗口 | 能拿到 `contextWindow` 并算出占比 | 绝对阈值无法跨模型迁移 |
| `chainLimit` 被真实跑到过 | `claims.json` 最大 `chainDepth` 达到过上限 | 「到顶就停」只在离线测试里成立，现网没验过 |
| 样本量够改默认阈值 | 真实交接 ≥ 20 次 | 6 次就改默认值 = 换个数继续拍 |
| 日志只含一个 profile 的配置 | 只出现一代 `已启用：` | e2e / 离线测试与桌面宿主共用 `USERPROFILE`，会互相污染 |

设计要点：

- **只拿真实交接算统计**：面板里的 `sess-a` / `sess-new-1` 是离线假件，e2e 压测代阈值是
  `1000/5`，混进来会把分位数彻底带偏。过滤条件是「发起方是 `session-<uuid>`」且「代数不含 e2e」。
- **分位数不在统计层取整**：窗口占比是 0–1 的比例，先 `Math.round` 会全变成 0 或 1；
  比值保留原精度，绝对量在输出层取整。
- **按「配置代数」切分日志**：同一份日志跨了多代配置（`300000/80` → `1000/5`），
  每条 `已启用：` 开一代，给每次 `已交接` 打上代数标签，否则等于把不同实验的数据混在一起平均。
- **建议只给比例，不给绝对值**：`tokenThresholdRatio = p25(窗口占比)` 夹在 `[0.15, 0.45]`；
  样本不足 20 次时明说「只给比例建议，别动默认绝对值」。
- **只读**：不写插件状态、不改 `claims.json`、不发网络请求。
- 环境变量可覆盖路径：`HANDOFF_RUNTIME_DIR`（`~/.dsh/auto-handoff`）、`HANDOFF_SESSIONS_DIR`（会话根）。
