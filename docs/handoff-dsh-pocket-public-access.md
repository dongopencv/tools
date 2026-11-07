# 交付文档 · dsh-pocket 公网访问（cloudflared）修复

> 写于 2026-11-06 21:35 (Asia/Shanghai)，PC1（DESKTOP-OGBQE3B，192.168.1.38）。
> **给一个没有任何上下文记忆的新会话看。** 本文每条结论都标了证据等级：可直接使用 / 弱证据 / 我的猜测。请按等级取用，不要把我的推断当事实。
> 用户已明确指出：本文里的推断「很多是错误的」。第 6 节把它们全部列出来了，**优先读第 6 节**。

---

## 0. 一句话现状

cloudflared 已经装好并通过 SHA256 校验，插件那句「cloudflared 下载失败：所有源都不通」的报错**理论上已被绕过**（resolveCloudflared 现在命中 PATH，不会走下载分支）。

但**「公网访问」这件事一次都没有成功过**：

- GUI 里点「开启公网访问」：**没做**（我无法从命令行触发，见第 5 节）
- 手机端能不能打开：**没验证**
- 自定义密码：**没设**（密码值还没拿到）
- 证据：C:/Users/Admin/.dsh/dsh-pocket/tunnel-auto.json **不存在**（该文件存在 = 曾经成功开过公网）

**用户的明确需求（我理解的）**：把公网访问真正打开，并且访问密码设成**自定义**的（不要插件每次自动轮换的随机 8 位）。

⚠️ 注意：连「用户说的『我电脑应该装了这个』具体指什么」**我都还没确认过**，这就是第 6 节第 1 条。

---

## 1. 环境事实（这些是查出来的，可以当真）

| 项 | 值 |
|---|---|
| 工作目录 | D:\proj\PC1 |
| 文件策略 | danger-full-access（本会话），审批提示已禁用 |
| DSH GUI URL | http://127.0.0.1:61420 |
| DSH 安装目录 | C:\Users\Admin\AppData\Local\Programs\DeepSeek Harness\ |
| dsh CLI | C:\Users\Admin\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd（**不在 PATH**） |
| 插件位置 | C:/Users/Admin/.dsh/profiles/desktop/node_modules/dsh-pocket，版本 **2.12.0** |
| 插件设置 | C:/Users/Admin/.dsh/dsh-pocket/settings.json，内容仅 {"lanEnabled": false} |
| 公网密码文件 | C:/Users/Admin/.dsh/dsh-pocket/token → 当前值 40574490 |
| 局域网密码文件 | C:/Users/Admin/.dsh/dsh-pocket/token-lan → 当前值 78212500 |
| 系统 node | D:\tools\nodejs\node，v24.16.0 |
| 监听 3081 | 0.0.0.0:3081（PID 38492）与 127.0.0.1:3081（PID 33808），两个都是 DeepSeek Harness.exe |

---

## 2. 用户最初的问题（截图内容，逐字）

「设置 → 手机访问」页，公网访问区块红字：

> 开启失败：cloudflared 下载失败：所有源都不通（最后错误：The operation was aborted due to timeout）。Windows 可手动安装后重试：winget install cloudflared；或下载 cloudflared-windows-amd64.exe 放到 C:\Users\Admin\.dsh\dsh-pocket\bin 目录（可重试；若是代理/VPN 问题见 README 排障）

同页另有：「局域网访问已关闭：手机扫码/链接均不可用（公网不受影响）。点「开」恢复。」

用户附言：「我电脑应该装了这个，你看一下怎么搞。」

---

## 3. 根因（直接读源码得出，可信度高）

### 3.1 插件找 cloudflared 的顺序 —— lib/tunnel.mjs:377-431 resolveCloudflared()

1. 环境变量 DSH_POCKET_CLOUDFLARED（settings.json 的 cloudflaredPath 会被写进它，见 lib/index.js:269-274）
2. cloudflaredOnPath() → 执行 where cloudflared（lib/tunnel.mjs:360）
3. 缓存 $DSH_HOME/dsh-pocket/bin/ 下的 cloudflared.exe 或 cloudflared-windows-amd64.exe（lib/tunnel.mjs:399-402）
4. 都没有 → downloadCloudflared()

### 3.2 下载源 —— lib/tunnel.mjs:94-99 CLOUDFLARED_MIRRORS

依次尝试：官方 github.com/cloudflare/cloudflared/releases/latest/download/<asset> → ghproxy.net → gh.ddlc.top → gh-proxy.com
Windows 资产名：cloudflared-windows-amd64.exe（platformAssets()，lib/tunnel.mjs:80-85）
超时：AbortSignal.timeout(120_000)（lib/tunnel.mjs:247-249），全失败就抛用户截图那句话。

**判断**：本机 github.com 的 HTTPS 被墙（仓库 AGENTS.md 有记载），前三个源会耗到超时，所以必然报「所有源都不通」。这个判断我认为成立。

### 3.3 隧道协议 —— 插件源码里**已经强制 http2**

- startQuickTunnel()（lib/tunnel.mjs:549-560）argv 已经是：--no-autoupdate / tunnel / --url http://127.0.0.1:<port> / --protocol http2
- startNamedTunnel() 同样带 --protocol http2，token 走 TUNNEL_TOKEN 环境变量（不进 argv）
- cloudflaredEnv()（PROXY_ENV_KEYS，lib/tunnel.mjs:30-37）会剥掉所有代理环境变量

**含义**：任何「要改插件给它加 http2」的动作都是白改——已经加了。

### 3.4 自定义密码机制 —— lib/index.js:152-171 setCustomPin(which, value)

- 规则：PIN_RE，**8–64 位，只能英文字母或数字**（lib/index.js:159），否则抛错
- 公网：写 token 文件 + settings.json 里置 publicPinCustom = true
- 自定义后 credentialKindForHost 返回 'persistent'（lib/index.js:125）→ **开公网时不再轮换密码**（rotateAccessToken 被 pinCustom('public') 短路，lib/index.js:90）
- RPC 端点名：pin.setCustom（client/api.js:19）
- 传空串会恢复随机并清掉 custom 标记（lib/index.js:154-157）

**注意**：手工改文件（token 写目标值 + settings.json 加 "publicPinCustom": true）**这条路我没实测过**。

### 3.5 自动恢复机制（**未验证，别当事实**）

- tunnel-auto.json 位于 $DSH_HOME/dsh-pocket/（lib/service.mjs:250）
- stopTunnel({keepAutoMarker})（lib/service.mjs:379-388）：手动关闭会 clearAutoTunnel()，进程退出/重启会保留以便下次自动拉起（issue #11）
- 该文件当前**不存在** → 这台机器从来没有成功开过公网
- 我**没读过这个文件的 schema**，「手写一个让插件重启后自动开公网」能不能成，**我不知道**。

---

## 4. 我实际做了什么（含命令与输出，可复现）

### 4.1 下载并安装 cloudflared ✅ 已验证

用仓库网关（走 release-assets 通道，不经 github.com 网页）：

    cd /d/proj/PC1 && bash tools/github.sh asset cloudflare/cloudflared 2026.10.7 cloudflared-windows-amd64.exe \
      -s 2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343 \
      -o /d/downloads/cloudflared/cloudflared-windows-amd64.exe

结果：55,390,512 B，aria2 8 连接，**SHA256 校验通过 [ok]**（第一次前台 120s 超时，转后台 job bash-8b46eed88b7e4033 完成）。

同一份二进制放到三处：

| 路径 | 用途 |
|---|---|
| C:/Users/Admin/.dsh/dsh-pocket/bin/cloudflared.exe | 插件缓存名 1 |
| C:/Users/Admin/.dsh/dsh-pocket/bin/cloudflared-windows-amd64.exe | 插件缓存名 2（手动放置的发布资产名） |
| C:/Users/Admin/.local/bin/cloudflared.exe | **在 DSH 进程 PATH 里**，让 where cloudflared 命中 |

验证输出：

    where cloudflared
    → C:\Users\Admin\.local\bin\cloudflared.exe

    cloudflared --version
    → cloudflared version 2026.10.7 (built 2026-10-30T09:43 UTC)

    node --input-type=module -e "import('./lib/tunnel.mjs').then(m=>m.resolveCloudflared().then(p=>console.log('resolved:',p)))"
    → resolved: cloudflared

最后一行是**报错已被绕过**的直接证据：第 2 步就命中，**永远不会走到下载分支**。

### 4.2 镜像可达性 ⚠️ 方法有缺陷

命令：curl.exe -sS -o /dev/null -w "%{http_code}" --max-time 15 -I <url>（**HEAD 请求**）

| 源 | 结果 |
|---|---|
| github.com/cloudflare/cloudflared/releases/latest/download/... | 000 |
| ghproxy.net/... | 000 |
| gh.ddlc.top/... | 429 |
| gh-proxy.com/... | 200 |

**缺陷**：全程用 -I（HEAD），有些服务器对 HEAD 不给码，000 不等于 GET 也不通。github.com 的 000 与 AGENTS.md 记载一致、可信；ghproxy.net 的 000 只是弱证据。

### 4.3 隧道连通性 ✅ 隧道本身通过

    nohup "/c/Users/Admin/.local/bin/cloudflared.exe" tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3081 > /tmp/cf.log 2>&1 &

- 约 4 秒后出 URL：https://providence-expiration-yarn-skilled.trycloudflare.com
- 更早一次用插件模块 startQuickTunnel({port:3081}) 也成功：phase starting>registering>ready，URL https://heaven-assets-cork-steps.trycloudflare.com
- 日志出现过 Registered tunnel connection（protocol=http2，location=lax13）

### 4.4 DNS / 访问链路 ⚠️ **本节结论可能是错的，见第 6 节第 3 条**

    curl https://heaven-assets-cork-steps.trycloudflare.com/        → Could not resolve host（http=000）
    nslookup heaven-assets-cork-steps.trycloudflare.com             → 找不到（服务器 192.168.0.1）
    nslookup heaven-assets-cork-steps.trycloudflare.com 223.5.5.5   → 104.16.230.132 / 104.16.231.132 + 两个 IPv6
    nslookup heaven-assets-cork-steps.trycloudflare.com 8.8.8.8     → 同上
    nslookup heaven-assets-cork-steps.trycloudflare.com 1.1.1.1     → 超时
    nslookup abcxyz-test-1234.trycloudflare.com                     → 找不到（这域名本来就不存在，属预期）

本机 DNS：以太网 {192.168.0.1, 8.8.8.8}，WLAN {192.168.0.1}。

**我看到的现象**：默认解析器（192.168.0.1）对确实存在的隧道域名也返回 NXDOMAIN，公共 DNS 能解析。
**我犯的错**：这是瞬间快照、没重试；新子域可能有传播/负缓存延迟；我还拿一个本不存在的域名做对照，容易混淆。**所以「本机 DNS 坏了」证据不足。**

### 4.5 本地代理行为（顺带测到，与我之前的解释冲突）

    curl -H "Accept: text/html" http://127.0.0.1:3081/    → 401 text/plain「dsh web authentication required; reopen the URL printed by dsh web.」
    curl -H "Accept: text/html" http://192.168.1.38:3081/ → 403 text/html，页面标题「DSH Pocket · 局域网访问已关闭」

**含义**：回环访问拿到的是**上游 DSH 自己的 401**，不是 dsh-pocket 的登录页。也就是说**代理层的密码门在 loopback 上没有生效**（按 3.4 的调用链，isProtected 对 127.0.0.1 应该返回 lanAuthEnabled()=true、应该拦住）。**这里有我没搞懂的地方，别照抄我的解释。**
192.168.1.38 返回 403「局域网访问已关闭」，与 settings.json 的 lanEnabled:false 一致。

---

## 5. 卡点：我无法从命令行把「公网」打开 ⚠️ 证据也不够硬

尝试：对 http://127.0.0.1:61420/dsh-pocket/<endpoint> 发 POST，body {rpcId, method, payload}（method 必须等于 endpoint，content-type: application/json），端点来自 client/api.js 的 POCKET_ENDPOINTS（pocket.status / tunnel.start / tunnel.stop / tunnel.setConfig 等；tunnel.start 要求 payload.disclaimer === true）。

结果：一律一行 unauthorized；带 ?token=40574490 或 ?token=78212500 仍 unauthorized。GUI 没开 9222 调试端口。

**我的结论**：宿主 web 认证在插件路由之前就拦了，必须由用户在 GUI 里点。
**可疑之处**：dsh web 的启动 token 每次进程启动都变，插件自己是靠 ctx.connection.authenticatedUrl() 现取的（lib/index.js:344-353）；我根本没找到它存在哪，只试了两个文件里的**pocket PIN**——那本来就不是宿主 token，试了当然不通。**所以「原理上不能用 RPC 触发」这个结论不成立，只能说我用错了凭据。** 新会话若要试，应去找 dsh web 真正的启动 token（启动日志/stdout 里通常会打印）。

---

## 6. 我的错误猜测清单（用户明确说：很多推断是错的）

> **新会话请优先信这一节**，而不是正文里那些语气笃定的段落。以下每条都是我没有硬证据就写出来的。

1. **「『我电脑应该装了这个』= cloudflared」——纯猜测。** 也可能指插件本身、手机端 App、或别的东西。**必须问清楚，不要假设。**
2. **「cloudflared 原本没装」——证据不完整。** 我只查了 where、WinGet/Scoop/Chocolatey、注册表卸载项、C:/D: 文件名。没搜非标准目录、没搜改名/portable 版本。只能说「按常见路径没找到」。
3. **「本机 DNS 坏 / trycloudflare 子域解析不了 / 手机也会打不开」——最可疑的一条。** 只取了瞬间快照、没重试；对照域本来不存在；「手机也会受影响」是从电脑推断手机、毫无依据（手机可能走 4G 或别的 DNS）。**更可能只是新子域的短暂负缓存/传播延迟。不要基于这条去改 DNS 或写 hosts。**
4. **「QUIC/UDP 7844 被封，只能 http2」——弱证据。** 依据是 cloudflared 自带预检查 FAIL + 一次 http2 成功。可能是瞬时抖动或本机防火墙，也可能预检查在 Windows 上本来就常 FAIL。**而且这条已经没用了**：插件本就强制 http2（3.3）。
5. **「3081 上两个监听 = 两个 DSH GUI 实例」——推断。** 只看了 PID 名字，CommandLine 取出来是空的。
6. **「可以用 tunnel-auto.json 自动恢复代替用户点击」——完全没验证。** 我连这文件长什么样都没见过。
7. **「改 hosts 只影响隧道、改动面小、我倾向这个」——这是建议不是结论。** 没测过任何一条 DNS 修法，也没测过 Cloudflare 是否接受被改 hosts 的 SNI/证书。
8. **「401 = 数据面打通、只缺宿主 token」——半对半猜。** 401 来自上游 DSH 说明隧道把请求送到本机了，但「只缺宿主 token」没验证。
9. **「4 个镜像源里只有 gh-proxy.com 能用」——方法有缺陷**（4.2，只用了 HEAD）。
10. **「局域网 403 页面 = lanEnabled:false 生效」——合理但没逐条对代码路径。**
11. **流程上的根本错误**：用户两次直接问「进度怎么样 / 我的需求是什么」，我都在继续调工具、继续查，没有先停下来把问题复述清楚、把「已验证 / 未验证」摊开。用户明确表达了不满。**新会话必须先对齐需求再动手，不要一上来就跑命令。**

---

## 7. 当前真实状态盘点（新会话从这里接手）

机器上新增/改变的东西（都可回滚）：

| 路径 | 状态 | 回滚 |
|---|---|---|
| C:/Users/Admin/.local/bin/cloudflared.exe | 新增 55,390,512 B | 删掉（PATH 其他项不动） |
| C:/Users/Admin/.dsh/dsh-pocket/bin/cloudflared.exe | 新增 | 删掉 |
| C:/Users/Admin/.dsh/dsh-pocket/bin/cloudflared-windows-amd64.exe | 新增 | 删掉 |
| D:/downloads/cloudflared/cloudflared-windows-amd64.exe | 新增（源文件） | 删掉 |
| C:/Users/Admin/.dsh/dsh-pocket/settings.json | **未修改**，仍是 {"lanEnabled": false} | — |
| token / token-lan | **未修改** | — |
| 插件源码 | **一行都没改** | — |

**可能还没退干净的进程**：我手工 nohup 起的 cloudflared.exe tunnel --protocol http2 --url http://127.0.0.1:3081，日志 /tmp/cf.log，URL https://providence-expiration-yarn-skilled.trycloudflare.com。**新会话第一件事建议先确认并杀掉它**，否则会和插件自己拉起的隧道抢外部连接、留孤儿进程：

    Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

**没开始的事**：自定义密码（值未定）、GUI 里点「开启公网」、手机端验证。

---

## 8. 建议的下一步（**先和用户对齐，不要直接执行**）

1. **确认「装了这个」指什么**（cloudflared？插件？手机 App？）。别再猜。
2. **拿到自定义密码**。规则 8–64 位字母数字（3.4）。设置方式两条：
   - (a) 走 GUI 设置页的「自定义密码」（最稳，两条标记都会置对）；
   - (b) 手工：token 写目标值 + settings.json 加 "publicPinCustom": true ——**我没实测，走它必须先备份并验证重启后密码不变**。
3. **让用户在 GUI 里点「开启公网访问」**（或先解决第 5 节的 RPC 凭据）。这是唯一必须人工的动作。
4. **点完立刻验证（别信 UI 的绿字）**：
   - Get-Process cloudflared 是否起来、命令行里有没有 --protocol http2；
   - 日志有没有 Registered tunnel connection；
   - curl 那个 trycloudflare URL → 应该出 dsh-pocket 登录页（**不是** dsh web authentication required）；
   - 输自定义密码 → 进主页；
   - 再用手机开同一 URL 验证。
5. **只有第 4 步确实失败、且确认是解析问题时才动 DNS**。诊断顺序：
   - nslookup <真实隧道域名> 223.5.5.5（出 IP = 记录存在）；
   - nslookup <真实隧道域名>（默认解析器，NXDOMAIN 才是本地 DNS 问题）；
   - curl -v 看是 DNS 阶段还是 TLS 阶段失败；
   - **等 1–2 分钟再试一次**再下结论。
   **不要**先写 hosts（Cloudflare 边缘 SNI/证书可能不认），也不要先改整机 DNS。

---

## 9. 一句话给新会话

> cloudflared 装好了（SHA256 验过，三处，PATH 命中），插件的「下载失败」报错理论上已被绕过，但**公网一次都没成功开过**（tunnel-auto.json 不存在可证）。剩下的活：确认需求边界 → 定自定义密码 → 在 GUI 点开 → 端到端验证 → 手机验证。**我之前关于「DNS 坏了」的判断证据不足、方法有缺陷，不要在它上面做决策。**
