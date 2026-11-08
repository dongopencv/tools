# PC1 网络基线（2026-11-06 采测，2026-11-08 修订）

本机出网的真实带宽与可达性，以及据此定下的规矩。
AGENTS.md 里那条「大于 50 MB 不要用 git push」的判据，来源就是这里。

采测环境：DESKTOP-OGBQE3B（192.168.1.38），Asia/Shanghai，2026-11-06 02:00–02:20。
测量方式：`node` 的 `fetch`（本机 `curl` 在沙箱里全废，见第五节「只在 workspace-write 沙箱里成立的做法/失败」），每次记录实际 body 字节数与墙钟耗时。

## 一、下行实测

| 端点 | 字节 | 耗时 | 速率 |
|---|---|---|---|
| speed.cloudflare.com `__down?bytes=5000000` | 5,000,000 | 2.42 s | 2,022 KB/s |
| 同上 | 5,000,000 | 1.57 s | 3,104 KB/s |
| speed.cloudflare.com `__down?bytes=10000000` #1 | 10,000,000 | 2.36 s | 4,140 KB/s |
| 同上 #2 | 10,000,000 | 2.29 s | 4,272 KB/s |
| 同上 #3 | 10,000,000 | 1.59 s | 6,127 KB/s |
| speed.cloudflare.com `__down?bytes=25000000` | 25,000,000 | 4.20 s | 5,818 KB/s |
| codeload.github.com `cli/cli` tar.gz #1 | 1,060,244 | 2.27 s | 456 KB/s |
| 同上 #2 | 1,060,244 | 0.97 s | 1,071 KB/s |
| 同上 #3 | 1,060,244 | 0.65 s | 1,605 KB/s |
| api.github.com `repos/cli/cli/tarball/v2.63.2` | 1,060,222 | 0.99 s | 1,041 KB/s |

**结论**：下行本身不慢。国际 CDN（Cloudflare）4–6 MB/s，GitHub 自己的 codeload / api tarball 0.5–1.6 MB/s。
小文件（<1 MB）的「速率」基本是延迟噪声，别拿它算带宽。

> AGENTS.md 只写分层结论、不给单一下行数字，逐条实测以**本表**为准。
> 2026-11-06 早些时候记过「下行同时段约 90 KB/s」，那是单线程小文件测出来的延迟噪声，已删除。

## 二、上行实测

| 载荷 | 耗时 | 速率 |
|---|---|---|
| 1,000,000 B → speed.cloudflare.com `__up` | 2.68 s | 364 KB/s |
| 2,000,000 B → 同上 | 14.54 s | 134 KB/s |
| 2,000,000 B → 同上 | 10.77 s | 181 KB/s |

**结论**：上行 134–364 KB/s，大载荷稳态约 **140–180 KB/s**。后续批量复测见到 58–364 KB/s 的更宽区间，
所以规划一律按 **150 KB/s** 保守估（AGENTS.md 记的就是这个值，两边一致）。
上行是本机的瓶颈，下行不是。所有「大文件怎么传」的判据都应该用上行来算。

## 三、通道可达性（只有 GitHub 自己的域）

| 通道 | 状态 | 说明 |
|---|---|---|
| `api.github.com:443` | ✅ 通 | `gh` 与 `github.sh api` 走这条。**读的一切都走它** |
| `release-assets.githubusercontent.com` | ✅ 通 | `api.github.com` 资产端点 302 的落点，**预签名 URL、直连可达**。解析出 4 个 IP，好坏不一（实测最坏的一个只有 0.18 MB/s，另有一轮三次全 0 字节），所以下载时要逐个试并砍慢连接，见 `tools/README.md`「release-assets 有四个 IP」 |
| `codeload.github.com` | ✅ 通 | GitHub 归档下载域 |
| `github.com:22` | ✅ 通（波动） | 03:53 复测 6/6 通；02:33 同一小时内测到 CLOSED，历史约 4/5 成功率。**push 主通道** |
| `ssh.github.com:443` | ✅ 通 | 03:53 复测 5/6 通。`github.com:22` 不通时改这条 |
| `github.com:443` | ❌ 基本不通 | **TCP 层**就不通（`net.connect` 实测 6 s 超时 ×2、`curl` exit 28），不是 DNS 问题、也不是「时好时坏」。**不影响干活**：读走 api，写走 SSH，release 资产走 API 端点 |
| `raw.githubusercontent.com` | ⚠️ 时通时不通 | 实测 8/8 失败、偶发成功。要稳就走 `api.github.com/repos/<o>/<r>/contents/<path>`（`github.sh raw` 就是这么做的） |

> **坑（2026-11-07 23:2x 实测）**：`~/.ssh/config` 里只有 `Host github.com` 一段时，走 `ssh.github.com` **不会匹配**、等于不带密钥，直接 `git@ssh.github.com: Permission denied (publickey)`。必须单开一段 `Host ssh.github.com`（HostName ssh.github.com / Port 443 / User git / IdentityFile ~/.ssh/id_ed25519_gh / IdentitiesOnly yes）。
>
> 同一小时里 22 端口出现过 `Connection reset by 20.205.243.166 port 22`，而 443 一路正常——这就是为什么要留 443 兜底且必须先把 config 配好。

## 四、规矩（照这个执行）

| 场景 | 走哪条 | 判据 |
|---|---|---|
| 代码 / 文档提交 | `bash tools/github.sh push <owner/repo> [ref]` —— 只走 SSH（钉 IP，22 不通自动改 `ssh.github.com:443`） | 单次 < 10 MB。`Permission denied (publickey)` = 账号上没有公钥，去 https://github.com/settings/keys 人工加，别改 `~/.ssh/config` 耗时间 |
| 仓库单次 push 总量 | 尽量 ≤ 20 MB | 上行 150 KB/s 时约 2.3 分钟；超过就该拆 |
| **> 50 MB 的产物** | **release 资产，禁止 git push** | 50 MB ÷ 150 KB/s ≈ 5.7 分钟，且失败要重传整包；release 支持断点与校验 |
| 下载 release 资产 / raw | `bash tools/github.sh asset\|raw ...` | `asset` 走 api 资产端点 + SHA256 校验；`raw` 走 api contents，raw 域只作兜底 |
| 拉别的仓库做只读分析 | `bash tools/github.sh clone owner/repo` | SSH 优先，失败才 HTTPS 直连 |
| 大文件（>50 MB）取回 | `tools/github.sh download <url> -s <sha256>` | 超 `GITHUB_ARIA2_MIN` 自动 aria2c 多连接 |

20 MB push 的预估耗时（按上行 150 KB/s）：**约 2.3 分钟**。
**切 release 资产的判据**：单个文件 > 50 MB，或一次 push 预计超过 5 分钟——即总量 > 45 MB。

### SSH 也走 getaddrinfo，也会卡（2026-11-08 实测）

`ssh` 解析 `github.com` 第走的是同一套系统解析器。冷的时候单次解析就能吃掉：
同一分钟 4 轮实测 **3.2 / 3.4 / 12.5 / 14.4 s**（60% 的轮次落在 12 s 以上）。
这不是「22 端口时通时不通」，是解析没命中缓存 —— 复测时别把它记成端口不稳。

钉住 IP 就平了：`ssh -o HostName=<ip> -o HostKeyAlias=<host> -p 22 git@github.com`
同一分钟 4 轮 **3.4 / 3.6 / 4.7 / 4.9 s**。两个细节：

- 用 `-o HostName=` 而不是把 IP 写进 argv：argv 里仍是 `github.com`，`~/.ssh/config` 的
  `Host github.com` 段（IdentityFile / IdentitiesOnly）照常生效。
- `HostKeyAlias` 保持 known_hosts 里的名字，换 IP 不会报 host key changed。

`tools/github.sh` 的 `push` / `clone` / `sshcheck` / `status` 都已这么钉（`ssh_pin()`），
解析不出来会自动退回系统解析，不是硬性依赖。

## 五、只在 workspace-write 沙箱里成立的做法/失败（不是本机属性）

下面这几条曾被当成「机器缺陷」写进文档，**在宽策略（danger-full-access）会话里逐条复测推翻**。它们只在 DSH 的 workspace-write 沙箱下成立——判断依据就一条命令：

```bash
gh issue view 3 --json number   # 成功 = 宽策略；报 pipe: Access is denied = 沙箱
```

| 现象 | 沙箱内 | 宽策略 / 真实终端 |
|---|---|---|
| `curl` 任意 HTTPS | ❌ `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | ✅ 正常，api.github.com 200 / 0.35 s |
| `git fetch`/`push`/`ls-remote` | ❌ `cannot create standard input pipe for ssh: Permission denied` | ✅ 正常 |
| `git clone` 走 `file://` | ❌ 同样 `unable to fork`（要 fork `git-upload-pack`） | ✅ 正常；本地复制仍建议 `cp -r` |
| `gh` 不带 `-R` | ❌ `failed to run git: pipe: Access is denied` | ✅ 自动从 git remote 推断 |
| `gh issue view --comments` | ❌ 退出码 1、stdout 空、stderr `failed to run git: pipe: Access is denied.` | ✅ 正常输出评论 |

**结论**：这是文件/进程策略的差异，不是网络或安装问题。写文档时按「策略相关」表述，别写成绝对结论。

## 六、测带宽的坑

- **小文件测带宽** —— 19 KB 的文件量出 19 KB/s，那是 RTT，不是带宽。
- **上行波动极大** —— 同一 1 MB 载荷，02:00 测 364 KB/s，02:33 测 57.9 KB/s。单次结果不可当基线，至少三跑取中位数。
- **本机 curl 是 Schannel 后端** —— 探测 https 时若报 `(28)` 超时/断连，加 `--ssl-no-revoke` 再看，别急着判「网断了」。
