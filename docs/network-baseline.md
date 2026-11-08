# PC1 网络基线（2026-11-06）

本机出网通道的真实带宽、可达性，以及据此定下的选路规则。
AGENTS.md 里那条「大于 50 MB 不要用 git push」的判据，来源就是这里。

采测环境：DESKTOP-OGBQE3B（192.168.1.38），Asia/Shanghai，2026-11-06 02:00–02:20。
测量方式：`node` 的 `fetch`（本机 `curl` 在沙箱里全废，见第七节「只在 workspace-write 沙箱里成立的做法/失败」），每次记录实际 body 字节数与墙钟耗时。

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
| gh-proxy.com 转发的本仓库 archive | 19,542 | 1.03 s | 19 KB/s（小文件，延迟主导） |

**结论**：下行本身不慢。国际 CDN（Cloudflare）4–6 MB/s，GitHub 自己的 codeload / api tarball 0.5–1.6 MB/s。
小文件（<1 MB）的「速率」基本是延迟噪声，别拿它算带宽。

> AGENTS.md 现在只写分层结论、不再给单一下行数字，逐条实测以**本表**为准。
> 历史变更：2026-11-06 早些时候记过「下行同时段约 90 KB/s」，那是单线程小文件测出来的延迟噪声，
> 后来独立复测明显更高，该数字已从 AGENTS.md 删除（2026-11-07 复核，两处不再互相引用）。

## 二、上行实测

| 载荷 | 耗时 | 速率 |
|---|---|---|
| 1,000,000 B → speed.cloudflare.com `__up` | 2.68 s | 364 KB/s |
| 2,000,000 B → 同上 | 14.54 s | 134 KB/s |
| 2,000,000 B → 同上 | 10.77 s | 181 KB/s |

**结论**：上行 134–364 KB/s，大载荷稳态约 **140–180 KB/s**。后续批量复测见到 58–364 KB/s 的更宽区间，
所以规划一律按 **150 KB/s** 保守估（AGENTS.md 记的就是这个值，两边一致）。
上行是本机的瓶颈，下行不是。所有「大文件怎么传」的判据都应该用上行来算。

## 三、通道可达性

| 通道 | 状态 | 说明 |
|---|---|---|
| `api.github.com:443` | ✅ 通 | `gh` 与 `github.sh api` 走这条，不受 443 封锁影响 |
| `github.com:443` | ❌ 不通 | 被墙。网页、raw、release 直链全部不通 |
| `ssh.github.com:443` | ✅ 通 | 03:53 复测 5/6 通；当天早些时候 5/5 全通。脚本默认走 22，需要 443 时用 `ssh://git@ssh.github.com:443/owner/repo.git` |
| `github.com:22` | ✅ 通（波动） | 03:53 复测 6/6 通；02:33 同一小时内测到 CLOSED，历史上约 4/5 成功率。**两个端口都试**，别赌任一个 |
| `codeload.github.com` | ✅ 通 | GitHub 的归档下载域，意外地没被墙 |
| `gh-proxy.com` | ✅ 通 | 镜像，转发 GitHub 资产 |
| `ghfast.top` | ✅ 通 | 镜像。02:13 复测 `fetch failed`、02:33 复测 200 且转发资产 206——**时好时坏，别默认可用** |
| `ghproxy.net` | ✅ 通 | 镜像。02:33 复测转发资产 206，1 MB range 5.2 s |
| `registry.npmmirror.com` | ⚠️ 时通时不通 | 02:13 复测 `fetch failed` |
| `release-assets.githubusercontent.com` | ✅ 通 | `api.github.com` 资产端点 302 的落点，**预签名 URL，直连可达**。同一批 324 MB 资产实测 5.09 MiB/s（ghfast 3.39、gh-proxy 1.32），是资产下载的最优路径 |

> **坑（2026-11-07 23:2x 实测）**：`~/.ssh/config` 里只有 `Host github.com` 一段时，走 `ssh.github.com` **不会匹配**、等于不带密钥，直接 `git@ssh.github.com: Permission denied (publickey)`。必须单开一段 `Host ssh.github.com`（HostName ssh.github.com / Port 443 / User git / IdentityFile ~/.ssh/id_ed25519_gh / IdentitiesOnly yes）。
>
> 同一小时里 22 端口出现过 `Connection reset by 20.205.243.166 port 22`，而 443 一路正常——这就是为什么要留 443 兜底且必须先把 config 配好。


## 四、中转站（8899）：镜像站代理这条链

思路是「在本机起一个代理，把 GitHub 家族的流量统一改道去镜像站」——不用改 URL、不用改各工具配置，只给进程塞一个 `HTTPS_PROXY`（或让网关脚本自动走）：

```
curl / git / gh / aria2c
        ↓  HTTPS_PROXY=http://127.0.0.1:8899
本地 MITM 反代  tools/relay/server.mjs → 部署副本 C:\Users\Admin\dsh-mirror-proxy\server.mjs
        ↓  解密后重写 URL，多上游按序回退
https://ghfast.top/https://<原域名><原路径>     ← 首选
https://gh-proxy.com/…  https://ghproxy.net/…  ← 失败就换下一个
        ↓
GitHub
```

- **只碰 GitHub**：仅对 10 个 GitHub 家族域名做 MITM 重写（`github.com` / `raw.githubusercontent.com` / `objects.githubusercontent.com` / `gist.github.com` / `github.githubassets.com` / `avatars.*` / `user-images.*` / `camo.*` / `media.*` / `githubusercontent.com`）；**其它域名一律普通 CONNECT 隧道直连、不解密**。
- **源码在仓库、运行在别处**：真身是 `tools/relay/server.mjs`；`C:\Users\Admin\dsh-mirror-proxy\server.mjs` 是**部署副本**（那个目录不是 git 仓库）。改完源码用 `bash tools/github.sh relay deploy`（= `tools/relay/deploy.sh`）同步：语法检查 → 备份 → 拷贝 → 停旧进程 → 起新进程 → 打 `/__relay/status` 自检。
- **多上游回退（2026-11-08 落地）**：旧版写死单上游 `gh-proxy.com`，它一抽风整条链就死。新版默认顺序 `ghfast.top → gh-proxy.com → ghproxy.net`，可由 `RELAY_UPSTREAMS`（逗号分隔）覆盖；单次尝试超时 `RELAY_ATTEMPT_TIMEOUT_MS`（默认 15000）。遇到 5xx/429/连接错误/超时即换下一个，全失败才回 502 `all upstreams failed`；成功的上游会被**置顶记忆**（进程内），日志里有 `ORDER` 行。
- **版本判据**：`curl -s http://127.0.0.1:8899/__relay/status` 有响应 = 新版（能报上游顺序与超时）；没响应 = 旧版没有回退。`github.sh relay status` / `github.sh status` 都会打这个判据，看到「单上游旧版」就说明该 deploy 了。
- **证书是自签的**：MITM 用本地 CA `certs/ca.crt.pem`，客户端必须显式信任（curl `--cacert`、node `NODE_EXTRA_CA_CERTS`）。Windows Schannel 版 curl 还要加 `--ssl-no-revoke`，否则吊销查询失败直接断连——网关脚本 `curl_opts` 已按 Schannel 自动补。
- **证书续期（定时炸弹）**：CA 到 2036-11-02，但 **leaf 只到 2028-11-02**；而且目录里**没有 CA 私钥**，所以届时不能用同一 CA 重签，只能换一套新 CA 并重装信任库。`tools/relay/gen-certs.sh` 就是为此写的：`--dry-run` 会打出现有证书剩余天数，实跑会生成新 CA + 覆盖 `MITM_HOSTS` 全部 13 条 SAN 的 leaf 并自检通过（实测 `2026-11-08` 生成到 `work/certs-test` 全绿）。装信任库那步需要管理员，脚本只打印指令。
- **起停**：`bash tools/github.sh relay up|down|deploy|status`。另有一个**登录时触发**的计划任务 `\dsh-gh-proxy` 负责自启。注意它的电源策略是「电池模式停止 / 不用电池启动」，且「只使用交互方式」——**拔掉电源或非交互登录它不会起**，此时 `relay status` 报未运行，手动 `relay up` 即可。
- **网关里是一等通道**：`download` 的探测/候选表含 relay（`--via relay` 可强制）；`asset` / `ghdl` / `clone` 在别路失败时回落到它。

### 实测（2026-11-06 02:50–02:56，单上游旧版）

| 场景 | 结果 |
|---|---|
| `github.com:443` 直连（对照） | ❌ curl (28) 21.0 s 超时，http 000 |
| 经 8899 取 raw 4,698 B | ✅ 200，1.46 s（延迟主导，不算带宽） |
| 经 8899 取 release 资产 1 MiB（curl 单连接） | ✅ 206，5.37 s，**191 KiB/s**（195,353 B/s） |
| 经 8899 取 15,721,375 B 资产（aria2c 8 连接） | ✅ 25.09 s，**612 KiB/s**（626,699 B/s），SHA256 通过 |
| `gh api repos/astral-sh/uv` 经 8899 | ✅ 正常返回 |

### 实测（2026-11-08，多上游回退版）

| 场景 | 结果 |
|---|---|
| 经 8899 取 raw 4,698 B（多上游版，线上 8899） | ✅ 200，12.5 s |
| 首选上游坏（`http://127.0.0.1:1/`，必拒）→ 次选 `ghfast.top` | ✅ 日志 `RETRY … connect ECONNREFUSED` → `200 1459ms via https://ghfast.top/` → `ORDER` 置顶；客户端 200 / 1.47 s / 4,698 B |
| 上游全坏 | ✅ 502 `all upstreams failed`（不是假 200，也不是挂死） |
| `github.com` HTML 页面经 8899 | ⚠️ 403 —— 镜像站不代理网页，是上游策略，不是 relay 缺陷 |
| 不存在的文件 | ✅ 404 正常透传 |

### 什么时候用 / 别用

- **该用**：要碰 `github.com` 本体（release 直链、HTTPS clone）的兜底；某个镜像域名抽风时，换这条链往往立刻可用。
- **别用**：`api.github.com` 直连本来通且更快——`gh` / `github.sh api` 塞代理是白绕一圈、多付一次 MITM。
- **写：能，2026-11-08 实测推翻了旧结论。** 旧版这里写「做不到——上游镜像不转发 push」。错在把两个不同的东西混成一个：`git push` 经 relay 时，relay **不是**去求镜像站转发，而是自己把请求原样转给 `https://github.com`（`buildUpstreamUrl` 里 mirror 前缀只在配置了才拼）。实测：

  | 请求 | 直连 | 经 8899 relay |
  |---|---|---|
  | `GET /dongopencv/tools.git/info/refs?service=git-receive-pack` | ❌ 21.09 s，http 000 | ✅ 200 / 413 B / 1.40 s，返回真实 ref `cc27875a…` |
  | `POST /dongopencv/tools.git/git-receive-pack`（body `0000`） | ❌ 21.05 s，http 000 | ✅ 200 / 0 B / 1.74 s |
  | 真推临时分支 `probe-relay-push` | — | ✅ `* [new branch]`，随后 `push --delete` 删净 |
  | `bash tools/github.sh push … --via relay` | — | ✅ 5 s，`[ok] push 成功（relay）` |

  前提是 token 有 **Contents: Read and write**；403 时响应头 `X-Accepted-Github-Permissions` 会点名缺哪项——**那是授权问题不是链路问题**，别再去调网络。
- **只要 `http.proxy`，不要 `http.sslVerify=false`**：git 在本机默认 `http.sslBackend=schannel`，信任来自 Windows 证书存储（relay 的 CA 已装进去）。实测：给一个**不存在的** `http.sslCAInfo` 路径照样成功（schannel 静默忽略该配置）；只有显式 `http.sslBackend=openssl` 且不给 CA 时才报 `unable to get local issuer certificate (20)`，那时才需要 `http.sslCAInfo=C:/Users/Admin/dsh-mirror-proxy/certs/ca.crt.pem`。**关校验是多余的，也是不必要的安全损失。**
- **token 不进命令行**：用 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` 环境变量注入 `http.extraheader`，别用 `git -c http.extraheader=…`（后者会出现在进程命令行，`ps`/`Get-CimInstance Win32_Process` 可直接读到）。`cmd_push` 的 `push_relay()` 已按这个写法实现。

### 改这个服务时的两个坑（都踩过）

1. **`taskkill /PID <pid> /F` 对计划任务拉起的进程会报「拒绝访问」**，即使进程属主就是当前用户。正确做法是 `schtasks /end /tn dsh-gh-proxy` 让任务自己收；`deploy.sh` 现在先问任务，停不掉才退回 taskkill。
2. **git-bash（MSYS）会吃掉 `/` 开头的参数**：`schtasks /query /tn X` 里的 `/query` 被改写成 `C:/Program Files/Git/query`，于是任务查询静默失败、脚本误判「没有计划任务」；`openssl -subj "/CN=…"` 同样被改写，报 `subject name is expected to be in the format /type0=value0`。解法分别是 `MSYS_NO_PATHCONV=1 schtasks …` 与 `-subj "//CN=…"`（双斜杠只被吃掉一层）。**别用全局 `MSYS_NO_PATHCONV=1` 跑 openssl**：它连文件路径转换一起关掉，原生 openssl 就读不到 `/c/Users/…` 形式的 `-in` 参数（实测报「找不到指定路径」）。

## 五、选路策略（照这个执行）

| 场景 | 走哪条 | 判据 |
|---|---|---|
| 代码 / 文档提交 | `bash tools/github.sh push <owner/repo> [ref]` —— 默认 `--via auto`：SSH 先（22 端口，不通自动改 `ssh.github.com:443`），失败回落中转站 HTTPS。也可强制 `--via ssh` / `--via relay` | 单次 < 10 MB。SSH 报 `Permission denied (publickey)` 时先查账号上有没有公钥（`github.sh api users/<owner>/keys`），别改 `~/.ssh/config`；relay 报 403 是 token 缺 Contents:write，别当网络问题 |
| 仓库单次 push 总量 | 尽量 ≤ 20 MB | 上行 150 KB/s 时约 2.3 分钟；超过就该拆 |
| **> 50 MB 的产物** | **release 资产，禁止 git push** | 50 MB ÷ 150 KB/s ≈ 5.7 分钟，且失败要重传整包；release 支持断点与校验 |
| 下载 release 资产 / raw | `bash tools/github.sh asset\|raw ...` | 走镜像选路 + SHA256 校验 |
| 拉别的仓库做只读分析 | `bash tools/github.sh clone owner/repo` | SSH 优先，回退镜像 |
| 大文件（>50 MB）取回 | `tools/github.sh download <url> -s <sha256>` | aria2c 多连接，断点续传 |
| GitHub 域名直连失败时的兜底 | `bash tools/github.sh relay up` 后 `--via relay` 或设 `HTTPS_PROXY=http://127.0.0.1:8899` | 见第四节；只对 GitHub 域生效。**读写都走这条**（push 也行） |

20 MB push 的预估耗时（按上行 150 KB/s）：**约 2.3 分钟**（实测早先记录 1.5–2.5 分钟，一致）。
**切 release 资产的判据**：单个文件 > 50 MB，或一次 push 预计超过 5 分钟——即总量 > 45 MB。

## 六、怎么复测

下行（改 `bytes` 调大小，10 MB 量级最稳）：

```bash
node -e "const t0=Date.now();fetch('https://speed.cloudflare.com/__down?bytes=10000000').then(async r=>{const b=await r.arrayBuffer();const s=(Date.now()-t0)/1000;console.log(b.byteLength,'bytes',s.toFixed(2),'s',(b.byteLength/1024/s).toFixed(1),'KB/s')})"
```

上行：

```bash
node -e "const n=2000000,b=new Uint8Array(n);const t0=Date.now();fetch('https://speed.cloudflare.com/__up',{method:'POST',body:b}).then(async r=>{await r.arrayBuffer();const s=(Date.now()-t0)/1000;console.log(n,'bytes',s.toFixed(2),'s',(n/1024/s).toFixed(1),'KB/s')})"
```

端口可达性：

```bash
for hp in 'api.github.com 443' 'ssh.github.com 443' 'github.com 22'; do set -- $hp
  if timeout 8 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then echo "$1:$2 OPEN"; else echo "$1:$2 CLOSED"; fi; done
```

中转站（8899）是否在跑、是否真能转发：

```bash
bash tools/github.sh relay status        # 端口探活

# 经 8899 取一个已知内容的 raw 文件；不写 --ssl-no-revoke 会假装超时/断开
curl -sS --ssl-no-revoke -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s\n' \
  -x http://127.0.0.1:8899 \
  --cacert /c/Users/Admin/dsh-mirror-proxy/certs/ca.crt.pem \
  https://raw.githubusercontent.com/github/gitignore/main/Python.gitignore
# 期望：200 4698B（该文件当日大小）

# 想看链路是否真在重写，看日志
tail -5 /c/Users/Admin/dsh-mirror-proxy/logs/proxy-$(date +%F).log
# 多上游回退版专有：上游顺序、超时、有没有回退能力
curl -s --max-time 5 http://127.0.0.1:8899/__relay/status
# 期望：{"ok":true,"listen":"127.0.0.1:8899","order":[...],"timeoutMs":15000}

# 回退链自检：首选换成必然失败的地址，看会不会自动换下一个（另起端口，不动线上 8899）
cd tools/relay
RELAY_PORT=8898 RELAY_ATTEMPT_TIMEOUT_MS=15000 \
RELAY_UPSTREAMS="http://127.0.0.1:1/,https://ghfast.top/" \
RELAY_CERT_DIR=/c/Users/Admin/dsh-mirror-proxy/certs \
RELAY_LOG_DIR=/d/proj/PC1/work/relay-logs node server.mjs &
# 期望客户端 200；日志先 RETRY … ECONNREFUSED，再 200 … via https://ghfast.top/
```

**测中转站的两个坑（都踩过）**：
1. 它是 **CONNECT 正向代理**，不是「把 URL 拼在路径后面」的网关。`http://127.0.0.1:8899/https://...` 返回 **400**，别据此判断它坏了。
2. Windows 自带的 Schannel 版 curl 必须配 `--ssl-no-revoke`，否则握手完成后立刻断连、报 `(28)` 超时——看起来像镜像不通，实际是吊销查询失败。

## 七、只在 workspace-write 沙箱里成立的做法/失败（不是本机属性）

下面这几条曾被当成「机器缺陷」写进文档，**在宽策略（danger-full-access）会话里逐条复测推翻**。它们只在 DSH 的 workspace-write 沙箱下成立——判断依据就一条命令：

```bash
gh issue view 3 --json number   # 成功 = 宽策略；报 pipe: Access is denied = 沙箱
```

| 现象 | 沙箱内 | 宽策略 / 真实终端 |
|---|---|---|
| `curl` 任意 HTTPS | ❌ `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | ✅ 正常，api.github.com 200 / 0.35 s |
| `git fetch`/`push`/`ls-remote` | ❌ `cannot create standard input pipe for ssh: Permission denied` | ✅ `git push --dry-run` 正常 |
| `git clone` 走 `file://` | ❌ 同样 `unable to fork`（要 fork `git-upload-pack`） | ✅ 正常；本地复制仍建议 `cp -r` |
| `gh` 不带 `-R` | ❌ `failed to run git: pipe: Access is denied` | ✅ 自动从 git remote 推断 |
| `gh issue view --comments` | ❌ 退出码 1、stdout 空、stderr `failed to run git: pipe: Access is denied.` | ✅ 正常输出评论 |

**结论**：这是文件/进程策略的差异，不是网络或安装问题。写文档时按「策略相关」表述，别写成绝对结论。

## 八、测带宽的坑

- **小文件测带宽** —— 19 KB 的文件量出 19 KB/s，那是 RTT，不是带宽。
- **上行波动极大** —— 同一 1 MB 载荷，02:00 测 364 KB/s，02:33 测 57.9 KB/s。单次结果不可当基线，至少三跑取中位数。
- **镜像时好时坏** —— `ghfast.top` 在 30 分钟内经历「fetch failed → 200 + 206」。选路必须实测，不能写死顺序。
