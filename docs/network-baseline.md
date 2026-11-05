# PC1 网络基线（2026-11-06）

本机出网通道的真实带宽、可达性，以及据此定下的选路规则。
AGENTS.md 里那条「大于 50 MB 不要用 git push」的判据，来源就是这里。

采测环境：DESKTOP-OGBQE3B（192.168.1.38），Asia/Shanghai，2026-11-06 02:00–02:20。
测量方式：`node` 的 `fetch`（本机 `curl` 在沙箱里全废，见文末「已知不成立的做法」），每次记录实际 body 字节数与墙钟耗时。

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

> 与 AGENTS.md 旧记录（「下行同时段约 90 KB/s」）不一致。旧数是 2026-11-06 早些时候、疑似单线程小文件测出来的，本次独立复测明显更高。**以本表为准**，旧数保留在 AGENTS.md 里作为历史对照。

## 二、上行实测

| 载荷 | 耗时 | 速率 |
|---|---|---|
| 1,000,000 B → speed.cloudflare.com `__up` | 2.68 s | 364 KB/s |
| 2,000,000 B → 同上 | 14.54 s | 134 KB/s |
| 2,000,000 B → 同上 | 10.77 s | 181 KB/s |

**结论**：上行 134–364 KB/s，大载荷稳态约 **140–180 KB/s**——和 AGENTS.md 记的「上行 140–200 KB/s」吻合。
上行是本机的瓶颈，下行不是。所有「大文件怎么传」的判据都应该用上行来算。

## 三、通道可达性

| 通道 | 状态 | 说明 |
|---|---|---|
| `api.github.com:443` | ✅ 通 | `gh` 与 `github.sh api` 走这条，不受 443 封锁影响 |
| `github.com:443` | ❌ 不通 | 被墙。网页、raw、release 直链全部不通 |
| `ssh.github.com:443` | ✅ 通 | **git push 的主力通道**，5/5 成功 |
| `github.com:22` | ⚠️ 时通时不通 | 本次探测 CLOSED；历史上约 4/5 成功率。有 443 就别赌 22 |
| `codeload.github.com` | ✅ 通 | GitHub 的归档下载域，意外地没被墙 |
| `gh-proxy.com` | ✅ 通 | 镜像，转发 GitHub 资产 |
| `ghfast.top` | ✅ 通 | 镜像。02:13 复测 `fetch failed`、02:33 复测 200 且转发资产 206——**时好时坏，别默认可用** |
| `ghproxy.net` | ✅ 通 | 镜像。02:33 复测转发资产 206，1 MB range 5.2 s |
| `registry.npmmirror.com` | ⚠️ 时通时不通 | 02:13 复测 `fetch failed` |
| `release-assets.githubusercontent.com` | ✅ 通 | `api.github.com` 资产端点 302 的落点，**预签名 URL，直连可达**，是本机最快路径 |

## 四、选路策略（照这个执行）

| 场景 | 走哪条 | 判据 |
|---|---|---|
| 代码 / 文档提交 | `git push` 走 SSH（`ssh.github.com:443`） | 单次 < 10 MB |
| 仓库单次 push 总量 | 尽量 ≤ 20 MB | 上行 150 KB/s 时约 2.3 分钟；超过就该拆 |
| **> 50 MB 的产物** | **release 资产，禁止 git push** | 50 MB ÷ 150 KB/s ≈ 5.7 分钟，且失败要重传整包；release 支持断点与校验 |
| 下载 release 资产 / raw | `bash tools/github.sh asset\|raw ...` | 走镜像选路 + SHA256 校验 |
| 拉别的仓库做只读分析 | `bash tools/github.sh clone owner/repo` | SSH 优先，回退镜像 |
| 大文件（>50 MB）取回 | `tools/github.sh download <url> -s <sha256>` | aria2c 多连接，断点续传 |

20 MB push 的预估耗时（按上行 150 KB/s）：**约 2.3 分钟**（实测早先记录 1.5–2.5 分钟，一致）。
**切 release 资产的判据**：单个文件 > 50 MB，或一次 push 预计超过 5 分钟——即总量 > 45 MB。

## 五、怎么复测

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

## 六、只在 workspace-write 沙箱里成立的做法/失败（不是本机属性）

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
| `gh issue view --comments` | ❌ 静默返回空 | ✅ 正常输出评论 |

**结论**：这是文件/进程策略的差异，不是网络或安装问题。写文档时按「策略相关」表述，别写成绝对结论。

## 七、测带宽的坑

- **小文件测带宽** —— 19 KB 的文件量出 19 KB/s，那是 RTT，不是带宽。
- **上行波动极大** —— 同一 1 MB 载荷，02:00 测 364 KB/s，02:33 测 57.9 KB/s。单次结果不可当基线，至少三跑取中位数。
- **镜像时好时坏** —— `ghfast.top` 在 30 分钟内经历「fetch failed → 200 + 206」。选路必须实测，不能写死顺序。
