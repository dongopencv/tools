#!/usr/bin/env bash
# github.sh — 本机唯一 GitHub 操作网关
#
# 铁律：本机所有 GitHub 操作（API / 下载 / clone / 发布 / 查仓库）都必须经过
#       这个脚本，不允许各处手搓 curl/gh/git 直连。依据见 docs/network-baseline.md：
#       api.github.com 通、github.com 连不上、token 只在网关里读取一次。
#
# 通道只有两条：读 API 走 api.github.com，读写 git 走 SSH。
#   github.com 的 443 在本机是 TCP 层连不上（不是「时通时不通」），所以：
#   - release 资产一律先换 API 资产端点（api.github.com → 302 →
#     release-assets.githubusercontent.com），直链 github.com/... 在本机必然失败；
#   - 本机 getaddrinfo 冷缓存要 ~12 s（任何域名都是），所以 api.github.com 与
#     release-assets 两个域名会被 tools/ghfetch.cjs / fast_ip 用快解析器先解析、
#     再用 --resolve 钉住 IP，绕过系统解析栈。
#
# 传输器顺序固定：gh → curl → node(tools/ghfetch.cjs)。失败时如实说是哪一层失败。
#
# 用法：
#   github.sh status                       # 自检：gh / token / 身份 / 可达域 / SSH
#   github.sh env --config                 # 打印脚本实际读取的配置变量
#   github.sh token                        # 打印 token（供其它脚本 $(...) 取用）
#   github.sh api <path>                   # GET api.github.com（自动带 token）
#   github.sh api -X POST <path> -f k=v    # 带 body 的写操作
#   github.sh release <owner/repo> [tag]   # release 的 tag + 资产清单
#   github.sh download <url> [-o FILE] [-s SHA256]
#   github.sh asset <owner/repo> <tag> <file> [-o FILE] [-s SHA256]
#   github.sh ghdl <owner/repo> [tag] [-p PATTERN] [-D DIR]  # 委派 gh release download
#   github.sh clone <owner/repo> [DIR]     # 只走 SSH
#   github.sh push <owner/repo> [ref]      # 只走 SSH
#   github.sh sshcheck                     # 验证 SSH 密钥对 GitHub 的认证
#   github.sh raw <owner/repo> <ref> <path>
#
# 退出码：0 成功 / 1 参数或环境错误 / 2 网络全通道失败 / 3 校验失败
#         4 受限会话：git 无法 fork 传输进程（clone/push 在沙箱里注定失败，需普通终端）
set -uo pipefail
# 关掉通配符展开：curl_opts 会产出 "--noproxy *"，星号必须保持字面量
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$SCRIPT_DIR/.github-token}"
# 仓库内没有 token 时回落到技能目录（token 只存在那一处）
if [[ ! -s "$TOKEN_FILE" && -s /c/Users/Admin/.skills-vault/download/scripts/.github-token ]]; then
  TOKEN_FILE=/c/Users/Admin/.skills-vault/download/scripts/.github-token
fi

DL_DIR="${GITHUB_DL_DIR:-$HOME/Downloads/github}"
ARIA2="${ARIA2C:-aria2c}"
# 低于这个大小不值得开多连接（实测小文件上 aria2 不加速，见 cmd_download）
ARIA2_MIN="${GITHUB_ARIA2_MIN:-8388608}"


info() { echo "$*" >&2; }
ok()   { echo "[ok] $*" >&2; }
warn() { echo "[warn] $*" >&2; }
die()  { echo "[fail] $1" >&2; exit "${2:-1}"; }

# ── gh 定位：Windows 上 MSI 装完要重开 shell 才进 PATH，这里主动找 ──
gh_bin() {
  command -v gh 2>/dev/null && return 0
  local c
  for c in "/c/Program Files/GitHub CLI/gh.exe"            "/c/Program Files (x86)/GitHub CLI/gh.exe"            "${LOCALAPPDATA:-$HOME/AppData/Local}/GitHubCLI/bin/gh.exe"            /c/Users/Admin/.local/bin/gh.exe; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

gh_token() {
  if [[ -s "$TOKEN_FILE" ]]; then tr -d '[:space:]' < "$TOKEN_FILE"; return 0; fi
  local g
  if g=$(gh_bin); then "$g" auth token 2>/dev/null && return 0; fi
  return 1
}

require_token() {
  local t
  t=$(gh_token) || die "拿不到 token：$TOKEN_FILE 不存在且 gh 未登录。跑 github.sh status 看看。"
  [[ -n "$t" ]] || die "token 为空：检查 $TOKEN_FILE"
  echo "$t"
}

# ── curl 参数：Schannel 的吊销查询会失败，必须 --ssl-no-revoke ──
SCHANNEL=0
curl --version 2>/dev/null | head -1 | grep -qi schannel && SCHANNEL=1

# 直连 curl 参数：没有环境代理时强制 --noproxy，免得被全局代理劫持
curl_opts() {
  (( SCHANNEL )) && { echo --ssl-no-revoke; }
  [[ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]] || { echo --noproxy; echo '*'; }
  return 0
}

opts_of() { local -a a=(); while IFS= read -r v; do a+=("$v"); done < <(curl_opts); echo "${a[*]}"; }

# ── 解析：本机 getaddrinfo 冷缓存要 ~12 s，绕开它 ──
# 2026-11-08 实测：ipconfig /flushdns 之后，node dns.lookup（等价 getaddrinfo）解析
#   github.com 8601 / example.com 12013 / baidu.com 12025 / api.github.com 12048 ms
# —— 是 OS 解析栈的通病（本机非物理网卡上挂着 DHCP 下发的 IPv6 DNS），不是 GitHub 特有问题。
# 而直接问 192.168.0.1 / 119.29.29.29 / 223.5.5.5 是 5–120 ms。
# 拿到 IP 后用 curl --resolve 钉住，curl 就完全不碰 getaddrinfo。
# 注意 curl -V 里没有 c-ares，--dns-servers 会直接报不支持，所以只能这样绕。
DNS_PIN_TTL="${GITHUB_DNS_PIN_TTL:-600}"
_PIN_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
_pin_file() { echo "$_PIN_DIR/pc1-pin-$(printf '%s' "$1" | tr '.' '_')"; }

fast_ip() { # $1=host → 一行 IP（空格分隔），失败非零
  have_node || return 1
  local f age ips; f=$(_pin_file "$1")
  if [[ -s "$f" ]]; then
    age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0) ))
    if (( age < DNS_PIN_TTL )); then cat "$f"; return 0; fi
  fi
  ips=$(node -e '
    const { Resolver } = require("dns");
    const host = process.argv[1];
    const servers = ["192.168.0.1", "119.29.29.29", "223.5.5.5", "8.8.8.8"];
    (function next(i) {
      if (i >= servers.length) process.exit(1);
      const r = new Resolver({ timeout: 2000, tries: 1 });
      r.setServers([servers[i]]);
      r.resolve4(host, (e, a) => {
        if (!e && a && a.length) process.stdout.write(a.join(" "));
        else next(i + 1);
      });
    })(0);
  ' "$1" 2>/dev/null)
  [[ -n "$ips" ]] || return 1
  mkdir -p "$_PIN_DIR" 2>/dev/null
  printf '%s' "$ips" > "$f" 2>/dev/null
  echo "$ips"
}

# 要钉的宿主：只钉真正会下载/取 JSON 的那两个域。github.com 不钉 ——
# 它的问题是 TCP 层连不上（实测 net.connect 6 s 超时 ×2），钉 IP 也救不了，改走 API 端点。
PIN_HOSTS="api.github.com release-assets.githubusercontent.com"
pin_args() {
  local -a a=()
  local h ip
  for h in $PIN_HOSTS; do
    ip=$(fast_ip "$h" 2>/dev/null) || continue
    [[ -n "$ip" ]] && a+=(--resolve "$h:443:${ip%% *}")
  done
  echo "${a[*]}"
}

# curl 的完整前置参数：TLS 开关 + 绕开 getaddrinfo 的钉 IP
net_opts() { local a b; a=$(opts_of); b=$(pin_args); echo "$a $b"; }

# 预热解析缓存：把 IP 抓进 --resolve 缓存里（fast_ip 落盘，后续 curl 直接钉住）。
# 老实现是 node dns.lookup + 最多等 6 s 就 kill —— 实测冷解析要 12 s，
# 等不到就把进程杀了，缓存根本没预热，紧接着的 curl 照样超时。现在改走 fast_ip（~120 ms）。
DNS_WARMED=""
dns_warm() {
  local host="$1"
  case " $DNS_WARMED " in *" $host "*) return 0 ;; esac
  DNS_WARMED="$DNS_WARMED $host"
  fast_ip "$host" >/dev/null 2>&1 || true
  return 0
}


# ──────────────────────────────────────────────────────────────────────────
# 传输通道：gh 优先 → curl → node fetch
#
# 背景（2026-11-06 实测于 PC1 受限会话）：curl 可能拿不到 TLS 句柄
#   curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS
# 此时 gh（自带 TLS 栈）与 node 的 fetch 仍可用。因此 api/status 不能只绑 curl。
# ──────────────────────────────────────────────────────────────────────────

have_node() { command -v node >/dev/null 2>&1; }

# node 传输器统一走 tools/ghfetch.cjs（不是内联 node -e）：
#   1) 自己问 DNS（dns.Resolver 打 192.168.0.1 等），绕开要 12 s 的 getaddrinfo；
#   2) 按目标自动选 Accept —— 资产端点必须是 application/octet-stream，否则回 1470 字节元数据 JSON；
#   3) 重定向到 release-assets 时自动摘掉 Authorization。
# 老实现是三个内联 node -e：缺 Accept、走 undici（只能 getaddrinfo）、冷缓存必失败。
GHFETCH="$SCRIPT_DIR/ghfetch.cjs"

# node 取 GET 正文；成功打印 body，失败非零
node_get() {
  local url="$1" tok="${2:-}"
  have_node || return 1
  [[ -f "$GHFETCH" ]] || return 1
  node "$GHFETCH" GET "$url" "$tok"
}

# node 下载（curl 不可用时的兜底）
node_download() {
  local url="$1" out="$2" tok="${3:-}"
  have_node || return 1
  [[ -f "$GHFETCH" ]] || return 1
  node "$GHFETCH" DL "$url" "$out" "$tok"
}

# node 探测：输出 "<code> <bytes>"
node_probe() {
  local url="$1" o
  have_node || { echo "000 0"; return 1; }
  [[ -f "$GHFETCH" ]] || { echo "000 0"; return 1; }
  o=$(node "$GHFETCH" PROBE "$url" 2>/dev/null) || o=""
  [[ "$o" =~ ^[0-9]{3}[[:space:]][0-9]+$ ]] || o="000 0"
  echo "$o"
}
# ── SSH 通道选路 ──
# 文档一直写「默认 22，22 不通改 ssh.github.com:443」，但 2026-11-06 复核发现代码只拼
# git@github.com:owner/repo.git，端口从不切换——文档承诺的兜底根本没实现。
# 2026-11-08 又发现：选路本身用 /dev/tcp 探端口是错的。MSYS bash 的
#   exec 3<>/dev/tcp/github.com/22
# 连跑三次 1/3 通，而同一分钟 ssh -T git@github.com 3/3 successfully authenticated
# ——替身探测会稳定地把「好的通道」判成坏，然后土路兜底吃满超时。
# 现在改成直接用将来要走它的那个命令去试（ssh -T），并把结论缓存 10 分钟。
#
# 三个坑，都是实测撞出来的，改这函数前先读：
#   1) 不能把结论存在普通变量里——调用点是 $(ssh_url_of ...)，命令替换跑在子 shell，
#      变量赋值随子 shell 一起消失，等于每次都重探（实测同一脚本内连续两次给出相反答案）。
#      → 结论落盘到 $_SSH_CACHE，子 shell 与下一次调用都能读到。
#   2) 不能只探一次就定死 10 分钟——22 端口实测有单次失败、紧接着就成功的情况。
#      → 单端口重试 2 次，2 次都失败才降级到 443。
#   3) 缓存文件用 stat -c %Y 判年龄，不用 mktemp/锈 /tmp（本机 /tmp 映射不稳）。
_SSH_CACHE="${GITHUB_SSH_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pc1-ssh-target}"
_SSH_CACHE_TTL="${GITHUB_SSH_CACHE_TTL:-600}"
# ssh 也吃 getaddrinfo：conhost 解析一次 github.com 可能 3 s 也可能 14 s（实测 4 轮
# 3.2/3.4/12.5/14.4 s，同一分钟）。跟 curl 一样钉 IP 就稳了：实测 4 轮 3.4/3.6/4.7/4.9 s。
# 注意用的是 -o HostName=<ip> 而不是把 IP 当 ssh 的参数：argv 里仍是 github.com，
# 所以 ~/.ssh/config 的 Host github.com 段（IdentityFile / IdentitiesOnly）照常生效；
# HostKeyAlias 保持 known_hosts 里的名字不变，不会因为换了 IP 就报 host key 变了。
ssh_pin() { # $1=host → 可选的 -o 串；解析不出来就输出空（调用方退回不钉）
  local host="$1" ip
  ip=$(fast_ip "$host" 2>/dev/null | awk '{print $1}')
  [[ -n "$ip" ]] || return 0
  printf '%s' "-o HostName=$ip -o HostKeyAlias=$host"
}

# 钉住 IP 的 ssh 探测。钉 IP 只是「把最坏情况压平」，不是必需条件：
# 解析失败、或钉住的 IP 恰好坏了，都要能退回系统解析再试一次。
_ssh_try() { # $1=host $2=port $3...=额外 ssh 选项 → 打印输出
  local host="$1" port="$2"; shift 2
  timeout 25 ssh -p "$port" -o ConnectTimeout=8 -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new "$@" -T "git@$host" 2>&1 || true
}

_ssh_works() { # $1=host $2=port；先钉 IP 试 2 次，再退回系统解析试 1 次
  local host="$1" port="$2" i out pin
  pin=$(ssh_pin "$host")
  for i in 1 2; do
    out=$(_ssh_try "$host" "$port" $pin)
    [[ "$out" == *"successfully authenticated"* ]] && return 0
    (( i == 1 )) && sleep 1
  done
  out=$(_ssh_try "$host" "$port")
  [[ "$out" == *"successfully authenticated"* ]] && return 0
  return 1
}
ssh_target() {
  local t="" age=0
  if [[ -s "$_SSH_CACHE" ]]; then
    age=$(( $(date +%s) - $(stat -c %Y "$_SSH_CACHE" 2>/dev/null || echo 0) ))
    (( age < _SSH_CACHE_TTL )) && t=$(<"$_SSH_CACHE")
  fi
  if [[ -z "$t" || "$t" != "22 github.com" && "$t" != "443 ssh.github.com" ]]; then
    if _ssh_works github.com 22; then t="22 github.com"; else t="443 ssh.github.com"; fi
    mkdir -p "$(dirname "$_SSH_CACHE")" 2>/dev/null || true
    printf "%s\n" "$t" > "$_SSH_CACHE" 2>/dev/null || true
  fi
  echo "$t"
}
ssh_url_of() {
  local repo="$1" t
  t=$(ssh_target)
  case "$t" in
    "22 github.com") echo "git@github.com:$repo.git" ;;
    *)
      info "github.com:22 认证不通 → 改走 ssh.github.com:443" >&2
      echo "ssh://git@ssh.github.com:443/$repo.git"
      ;;
  esac
}

# git 能否 fork 远端助手（不能则 push/fetch/clone 在本会话里全废）
# 输出两行：第一行状态（ok / blocked / unknown / n/a），第二行人话说明。
# 以前是 "blocked|说明" 这种三元字符串，调用方用 ${fork#*|} 剥前缀——状态和文案挤在
# 同一个变量里，多一个状态就得改所有解析点。现在调用方这样读：
#   local fork fork_msg; { read -r fork; read -r fork_msg; } < <(git_fork_state)
git_fork_state() {
  local out
  git rev-parse --show-toplevel >/dev/null 2>&1 || { printf 'n/a\n不在 git 仓库里\n'; return 0; }
  # 这一步本身就要起一次 SSH（实测冷解析 15 s），先钉住 IP，把「解析慢」和
  # 「fork 被禁」两件事分开 —— 否则沙箱里被拦和网络慢会混成同一个 15 s 超时。
  local sp; sp=$(ssh_pin github.com 2>/dev/null)
  out=$(GIT_SSH_COMMAND="ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new $sp" \
        git ls-remote "$(git remote get-url origin 2>/dev/null || echo .)" HEAD 2>&1 || true)
  case "$out" in
    *"cannot create standard input pipe"*|*"unable to fork"*|*"Permission denied"*)
      printf 'blocked\n沙箱禁止 git fork 管道（cannot create standard input pipe）\n' ;;
    "") printf 'unknown\ngit ls-remote 无输出\n' ;;
    *)  printf 'ok\ngit 远端通道可用\n' ;;
  esac
}

# ── 通道：只有直连一条 ──
# 稳定端点只有 api.github.com 与 release-assets，其余用 API 端点绕开。
candidates() {
  echo "direct|$1"
}

prefix_name() {
  case "$1" in
    direct) echo direct ;;
    rest)   echo "release-assets" ;;
    *)      echo "$1" ;;
  esac
}

# 探测：真测速。
#
# 老实现比的是 %{size_download} —— 每个通道都被 -r 0-1023 卡在 1024 字节，
# 于是 (( size > best )) 永远只有候选列表里第一个赢，等于从未测速。现在比
# %{speed_download}（curl 的平均
# 字节/秒），并顺带从 Content-Range 取文件总大小，供后面决定要不要上 aria2。
#
# 直连 github.com 被墙时旧版每次烧满 --max-time 12；现在 --connect-timeout 3
# 卡住建连阶段，单通道最多 PROBE_TIMEOUT 秒。
PROBE_BYTES="${GITHUB_PROBE_BYTES:-131072}"    # 每通道探 128 KiB
PROBE_TIMEOUT="${GITHUB_PROBE_TIMEOUT:-6}"
# 默认不预探测：见 cmd_download 里的说明（探测成本 > 传输成本）
PROBE="${GITHUB_PROBE:-0}"

probe() {
  local kind="$1" url="$2" code size spd total hdr
  hdr=$(mktemp 2>/dev/null || echo "/tmp/probe.$$")
  # 探针也要吃钉 IP：冷缓存下 getaddrinfo 要 12 s，--max-time 8 的探针会直接误报「不通」。
  local prc=0
  read -r code size spd < <(
    curl -sS $(net_opts) -D "$hdr" -o /dev/null \
      -w '%{http_code} %{size_download} %{speed_download}' \
      --connect-timeout 3 --max-time "$PROBE_TIMEOUT" \
      -L -r "0-$((PROBE_BYTES-1))" "$url" 2>/dev/null || { prc=$?; echo "000 0 0"; }
  )
  : "$prc"
  if [[ "$code" == 000 ]]; then
    read -r code size < <(node_probe "$url"); spd=0
  fi
  # Content-Range: bytes 0-131071/12345678 → 总大小（直连 200 全量时没有这行）
total=$(grep -i '^content-range:' "$hdr" 2>/dev/null | tail -1 | sed 's|.*/||' | tr -d '\r')
  [[ "$total" =~ ^[0-9]+$ ]] || total=0
  rm -f "$hdr" 2>/dev/null
  echo "$code $size $spd $total"
}

# 校验尾巴：空文件 / HTML 错误页 / SHA256
verify_out() {
  local out="$1"; shift
  local sha=""
  while [[ $# -gt 0 ]]; do
    case "$1" in -s|--sha256) sha="$2"; shift 2 ;; *) shift ;; esac
  done
  [[ -s "$out" ]] || die "下载产物为空" 3
  head -c 200 "$out" | grep -qi '<!DOCTYPE html' && { rm -f "$out"; die "产物是 HTML 错误页，不是目标文件" 3; }
  # 用 stdin 形式算哈希：Windows 路径含反斜杠时，sha256sum 会把文件名转义并在行首加一个
  # 反斜杠（GNU coreutils 对含 \ 或换行的文件名如此），直接 awk '{print $1}' 会拿到 "\\abc…"。
  local actual; actual=$(sha256sum < "$out" 2>/dev/null | awk '{print $1}')
  if [[ -n "$sha" ]]; then
    if [[ "${actual,,}" == "${sha,,}" ]]; then ok "SHA256 校验通过"
    else die "SHA256 不匹配（期望 ${sha,,} / 实际 $actual）" 3; fi
  else
    info "SHA256: $actual （未提供期望值，未比对）"
  fi
  ok "完成: $out ($(du -h "$out" | cut -f1))"
  echo "$out"
}

# 单通道下载一次。成功（且大小对得上）返回 0；失败或明显不完整返回 1，由调用方换下一条。
# 换通道时必须清掉半截文件：不同通道未必都支持续传，-C - 接手一个别处来的残片会算出坏哈希。
fetch_one() {
  local kind="$1" url="$2" out="$3" fsize="${4:-0}"
  rm -f "$out" 2>/dev/null
  local alog; alog="$(mktemp 2>/dev/null || echo "$out.aria2.log")"
  local okflag=0
  # rest = api.github.com 的资产端点（302 到 release-assets 预签名 URL）。
  # token 与 Accept 只发给 GitHub 自己的域名。
  local -a auth=() akx=() akh=()
  if [[ "$kind" == rest ]]; then
    dns_warm api.github.com
    dns_warm release-assets.githubusercontent.com
    local t; t=$(gh_token 2>/dev/null || true)
    if [[ -n "$t" ]]; then
      auth=(-H "Authorization: token $t")
      akh+=(--header="Authorization: token $t")
    fi
    auth+=(-H "Accept: application/octet-stream")
    akh+=(--header="Accept: application/octet-stream")
  fi
  # 数据面优先交给 node（tools/ghfetch.cjs）：它对同一 host 的所有 IP 并发抢跑，
  # 谁先回响应头谁赢。curl 只能逐个试，坏 IP 要按 --speed-time 白等一轮。
  # 2026-11-08 同一 2.5 MiB 资产冷缓存 A/B（每轮 flushdns）：
  #   node 8 轮 → 2161/2427/1930/2757/2271/2210/2771 ms（中位 ~2.2 s）
  #   curl 8 轮 → 7431/3759/3696/4574/11945/10043/17836/14922 ms（中位 ~8.7 s）
  # 差距 4 倍，所以 rest 通道直接让 node 打头，curl 退成兜底。
  if [[ "$kind" == rest ]] && have_node; then
    local nt; nt=$(gh_token 2>/dev/null || true)
    if node_download "$url" "$out" "$nt" 2>/dev/null; then
      if (( fsize <= 0 )); then okflag=1
      else
        local ngot; ngot=$(stat -c %s "$out" 2>/dev/null || echo 0)
        if (( ngot == fsize )); then okflag=1
        else info "  node 拿到大小不符（$ngot / $fsize），改用 curl"; rm -f "$out"; fi
      fi
    else
      info "  node 没成，改用 curl"
    fi
  fi
  if (( okflag == 0 )) && command -v "$ARIA2" >/dev/null 2>&1 && (( fsize >= ARIA2_MIN )); then
    info "  aria2c 8 连接（文件 $(( fsize / 1048576 )) MiB）"
    local -a ax=()
    if "$ARIA2" "${ax[@]}" "${akh[@]}" --allow-overwrite=true -x 8 -s 8 -k 1M --max-tries=2 --timeout=30 \
         --summary-interval=0 --console-log-level=warn --show-console-readout=false \
         --auto-file-renaming=false --connect-timeout=5 \
         -o "$(basename "$out")" -d "$(dirname "$out")" "$url" >"$alog" 2>&1; then okflag=1; fi
    rm -f "$alog" 2>/dev/null
    [[ $okflag -eq 1 ]] || info "  aria2 失败，改用 curl"
  fi
  if [[ $okflag -eq 0 ]]; then
    # 必须校验 HTTP 状态码：错误页会回 200 + "Not Found" 正文，
    # 只看 curl 退出码会把 9 字节的 "Not Found" 当成下载成功（实测踩到）。
    # 状态码必须和退出码分开取：老写法 code=$(curl ... || echo 000) 在 curl 先打印 302、
    # 再因跳转目标解析超时而退出非零时，会拼成 "302000"，于是传成功也被判失败（实测踩到）。
    #
    # 数据面（release-assets）会解析出 4 个 IP，**好坏不一，坏的是哪个并不固定**。
    # 2026-11-08 同一 2.5 MiB 资产实测：.108 1.19/0.84 MB/s、.109 1.05/0.99、.110 0.91/0.93、
    # .111 0.37/0.18 MB/s（6.9 s / 14.0 s）；另一轮 .110 连续三次只拿到 0 字节。
    # 只钉第一个 IP 就是抽签：抽到坏的那个，白等一轮 connect 超时再由 node 兜底重解析 ——
    # 这就是「同一条命令 4 s 还是 44 s」的分水岭。所以这里逐个 IP 试，谁先成谁算。
    local code crc ip
    local base; base=$(opts_of)
    local apiip; apiip=$(fast_ip api.github.com 2>/dev/null | awk '{print $1}')
    [[ -n "$apiip" ]] && base+=" --resolve api.github.com:443:$apiip"
    local -a rels=()
    if [[ "$kind" == rest ]]; then
      while read -r ip; do [[ -n "$ip" ]] && rels+=("$ip"); done < <(fast_ip release-assets.githubusercontent.com 2>/dev/null | tr ' ' '\n')
    fi
    (( ${#rels[@]} )) || rels=("")
    for ip in "${rels[@]}"; do
      local -a ropts=()
      [[ -n "$ip" ]] && ropts=(--resolve "release-assets.githubusercontent.com:443:$ip")
      # --speed-limit/--speed-time 是这里的另一个关键：连上了不代表传得动。
      # 2026-11-08 实测同一 2.5 MiB 资产，四个 IP 的瞬时速率从 1.19 MB/s 到 181 KB/s，
      # 还出现过单轮 44 s（≈58 KB/s）而 --connect-timeout 全程没触发 —— 因为连接早建好了，
      # 卡在传输。不设速度下限的话，慢 IP 会一直磨到 --max-time，等于白等。
      # 低于 96 KB/s 持续 12 s 就放弃这条 IP，换下一条。
      code=$(curl -sS $base "${ropts[@]}" -L --connect-timeout 4 --retry 1 --max-time 1800 \
        --speed-limit 98304 --speed-time 12 \
        -o "$out" -w '%{http_code}' "${auth[@]}" "$url" 2>/dev/null)
      crc=$?
      [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
      if [[ "$code" == 2* ]]; then
        if (( fsize > 0 )); then
          local got; got=$(stat -c %s "$out" 2>/dev/null || echo 0)
          if (( got == fsize )); then okflag=1; break; fi
          info "  大小不符（$got / $fsize，IP ${ip:-默认}），换下一个 IP"
          rm -f "$out"; continue
        fi
        okflag=1; break
      fi
      info "  curl 拿到 http=$code（curl exit=$crc，IP ${ip:-默认}）"
      rm -f "$out" 2>/dev/null
    done
  fi
  if [[ $okflag -eq 0 ]] && have_node && [[ "$kind" != rest ]]; then
    info "  curl 没成，改用 node（tools/ghfetch.cjs）"
    node_download "$url" "$out" $(gh_token 2>/dev/null || true) && okflag=1
  fi
  [[ $okflag -eq 1 && -s "$out" ]] || return 1
  # 拿到 HTML / 短文本说明是错误页/拦截页，不是目标文件。
  # 只判 HTML 不够：404 会回 200 + 正文 "Not Found"（9 字节），
  # 不加这个检查就会把错误页当成品写进目标路径。
  if (( $(stat -c %s "$out" 2>/dev/null || echo 0) < 4096 )); then
    if head -c 200 "$out" | grep -qiE '<!DOCTYPE html|<html|^Not Found$|Bad Gateway|^404:|"message"\s*:\s*"Not Found"'; then
      info "  产物是错误页（$(head -c 40 "$out" | tr -d '\r\n')…），丢弃"
      return 1
    fi
  fi
  if (( fsize > 0 )); then
    local got; got=$(stat -c %s "$out" 2>/dev/null || echo 0)
    (( got == fsize )) || { info "  大小不符（$got / $fsize），丢弃重试"; return 1; }
  fi
  return 0
}

# 把 https://github.com/O/R/releases/download/TAG/FILE 这种直链换成 API 资产端点。
# 为什么必须换：github.com 的 443 在本机是 TCP 层连不上（net.connect 实测 6 s 超时 ×2），
# 直链下载 100% 失败；而 api.github.com/repos/O/R/releases/assets/<id> 302 到
# release-assets.githubusercontent.com，实测能拿满速。
# 输出 "<asset_url> <size>"；认不出或查不到就输出空。
gh_release_asset_api() {
  local url="$1"
  [[ "$url" =~ ^https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/?]+) ]] || return 0
  local owner="${BASH_REMATCH[1]}" repo="${BASH_REMATCH[2]}" tag="${BASH_REMATCH[3]}" name="${BASH_REMATCH[4]}"
  local t; t=$(gh_token 2>/dev/null || true)
  [[ -n "$t" ]] || return 0
  local json meta id asize
  # 先用 ghfetch（自己解析 DNS，冷缓存也只要几百 ms）；gh 走 getaddrinfo，
  # flushdns 之后一次就要 ~12 s —— 冷启动那 12 s 全是它花的。
  json=$(node_get "https://api.github.com/repos/$owner/$repo/releases/tags/$tag" "$t" 2>/dev/null || true)
  [[ -n "$json" ]] || json=$(cmd_api "repos/$owner/$repo/releases/tags/$tag" 2>/dev/null || true)
  [[ -n "$json" ]] || return 0
  # 用 node 解析而不是 grep 正则：assets[] 的元素含嵌套对象（uploader），
  # "{[^{}]*}" 这类非贪婪花括号匹配一个都匹配不到（实测 obj len = 0）。
  meta=$(printf "%s" "$json" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(s); const a=(j.assets||[]).find(x=>x.name===process.argv[1]);
            if (a) process.stdout.write(a.id + " " + (a.size||0)); } catch(e){}
    });
  ' "$name" 2>/dev/null || true)
  id="${meta%% *}"; asize="${meta#* }"
  [[ "$id" =~ ^[0-9]+$ ]] || return 0
  [[ "$asize" =~ ^[0-9]+$ ]] || asize=0
  echo "https://api.github.com/repos/$owner/$repo/releases/assets/$id $asize"
}

cmd_download() {
  local url="" out="" sha=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--out)    out="$2"; shift 2 ;;
      -s|--sha256) sha="$2"; shift 2 ;;
      -*)          die "download: 未知选项 $1" ;;
      *)           url="$1"; shift ;;
    esac
  done
  [[ -n "$url" ]] || die "download: 需要 URL"

  mkdir -p "$DL_DIR"
  if [[ -z "$out" ]]; then
    local base="${url%%\?*}"; out="$DL_DIR/$(basename "$base")"
  fi

  # 直链若是 github.com/O/R/releases/download/TAG/FILE，先换 API 资产端点再下。
  # 这条不是「优化」而是「唯一能通的路」：github.com 在本机 TCP 层连不上。
  local apispec aurl asize
  apispec=$(gh_release_asset_api "$url" || true)
  if [[ -n "$apispec" ]]; then
    aurl="${apispec%% *}"; asize="${apispec#* }"
    [[ "$asize" =~ ^[0-9]+$ ]] || asize=0
    info "直链改走 API 资产端点（$(( asize / 1048576 )) MiB）"
    if fetch_one rest "$aurl" "$out" "$asize"; then
      verify_out "$out" ${sha:+-s "$sha"}; return 0
    fi
    if have_node; then
      local at; at=$(gh_token 2>/dev/null || true)
      if node_download "$aurl" "$out" "$at" && [[ -s "$out" ]] \
         && { (( asize == 0 )) || (( $(stat -c %s "$out" 2>/dev/null || echo 0) == asize )); }; then
        verify_out "$out" ${sha:+-s "$sha"}; return 0
      fi
    fi
    warn "API 资产端点没拿到，回落直链（大概率还是不通）"
  fi
  # release 直链没有被改写成 API 端点 → 说明资产名/tag 对不上，或者没有 token。
  # 这时候**不要再试直链**：github.com 在本机 TCP 层连不上（curl exit=28 / 5 s 超时），
  # 试了也只是白等一轮再把同一件事报一遍。直接说清楚缺什么。
  if [[ "$url" =~ ^https://github\.com/[^/]+/[^/]+/releases/download/ ]]; then
    [[ -n "$(gh_token 2>/dev/null || true)" ]] || die "download: 这台机器下 release 直链必须走 API 资产端点，而 API 需要 token（见 github.sh env）" 2
    die "download: 该 release 里找不到这个资产名（tag 或文件名不对）。用 github.sh release <owner/repo> <tag> 看资产清单" 1
  fi

  # 候选表现在只有直连一条（见 candidates），选路逻辑保留是为了将来加端点时不重写：
  # 按顺序直接下，失败就换下一个，选路成本 ≈ 一次真实传输。
  local chosen="" kind="" best=0 code size spd total ck cu fsize=0
  local -a order=()
  while IFS='|' read -r ck cu; do
    [[ -z "$ck" ]] && continue
    order+=("$ck|$cu")
  done < <(candidates "$url")
  [[ ${#order[@]} -gt 0 ]] || die "没有可用通道" 2

  if [[ "$PROBE" == 1 ]]; then
    info "逐通道测速（GITHUB_PROBE=1）…"
    local entry
    for entry in "${order[@]}"; do
      ck="${entry%%|*}"; cu="${entry#*|}"
      read -r code size spd total < <(probe "$ck" "$cu")
      [[ "$code" == 200 || "$code" == 206 ]] || { info "  skip  $(prefix_name "$ck")（http=$code）"; continue; }
      (( total > fsize )) && fsize=$total
      (( spd > best )) && { best=$spd; chosen="$cu"; kind="$ck"; }
      info "  ok    $(prefix_name "$ck") $(( spd / 1024 )) KiB/s"
    done
    [[ -n "$chosen" ]] || die "所有通道都失败（网络问题，不是 URL 问题）" 2
    info "选定通道: $(prefix_name "$kind")（$(( best / 1024 )) KiB/s）"
  else
    chosen="${order[0]#*|}"; kind="${order[0]%%|*}"
    info "首选通道: $(prefix_name "$kind")（失败再顺着候选表往下换）"
  fi

  # aria2 多连接只对大文件有收益：实测 2.18 MiB 的资产 curl 12.9 s / aria2 12.6 s
  # （打平），更早 2.5 MB 时 aria2 反而慢 6–12 倍 —— 连接建立与分片开销吃掉了并行收益。
  # 所以小文件直接单连接 curl，超过 ARIA2_MIN 才上 8 连接。
  local dlok=0 entry attempt=0
  for entry in "${order[@]}"; do
    ck="${entry%%|*}"; cu="${entry#*|}"
    (( PROBE == 1 )) && [[ -n "$chosen" && "$cu" != "$chosen" ]] && continue
    attempt=$(( attempt + 1 ))
    info "下载中 ($attempt/${#order[@]}): $(prefix_name "$ck") → $out"
    if fetch_one "$ck" "$cu" "$out" "$fsize"; then
      chosen="$cu"; kind="$ck"; dlok=1; break
    fi
    info "  这条不通/太慢，换下一条"
  done
  [[ $dlok -eq 1 ]] || die "下载失败（直连不通；先跑 github.sh status）" 2
  verify_out "$out" ${sha:+-s "$sha"}
}

# 资产下载：先走 API 资产端点（api.github.com 302 → release-assets）；拿不到 id 才回落直链。
# （api.github.com 通，302 到 release-assets.githubusercontent.com 也通）。
cmd_asset() {
  local repo="${1:?需要 owner/repo}" tag="${2:?需要 tag}" name="${3:?需要文件名}"
  shift 3
  local out="" sha=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--out) out="$2"; shift 2 ;;
      -s|--sha256) sha="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [[ -n "$out" ]] || out="$DL_DIR/$name"

  # 顺序很重要：**先 release-assets**。
  # api.github.com/…/releases/assets/<id> 会 302 到 release-assets.githubusercontent.com，
  # 那是预签名 URL、直连可达，实测全场最快（324 MB 资产 5.09 MiB/s）。
  local t json obj id
  t=$(gh_token 2>/dev/null || true)
  if [[ -n "$t" ]]; then
    # 同 cmd_download：先走 ghfetch 的快速解析，gh 的冷启动要 12 s。
    json=$(node_get "https://api.github.com/repos/$repo/releases/tags/$tag" "$t" 2>/dev/null || true)
    [[ -n "$json" ]] || json=$(cmd_api "repos/$repo/releases/tags/$tag" 2>/dev/null || true)
    # 用 node 解析而不是 grep 正则：release JSON 里 assets[] 的元素含嵌套对象（uploader），
    # "{[^{}]*}" 这类非贪婪花括号匹配一个都匹配不到（实测 obj len = 0）。
    # 一次拿 id + size：size 直接来自 release JSON 的 assets[].size，
    # 不要去 HEAD 资产端点 —— 它 302 到 release-assets 后 HEAD 会被拒/超时
    # （实测 5 s 解析超时），拿不到 content-length。
    local meta
    meta=$(printf "%s" "$json" | node -e '
      let s=""; process.stdin.on("data",d=>s+=d);
      process.stdin.on("end",()=>{
        try { const j=JSON.parse(s); const a=(j.assets||[]).find(x=>x.name===process.argv[1]);
              if (a) process.stdout.write(a.id + " " + (a.size||0)); } catch(e){}
      });
    ' "$name" 2>/dev/null || true)
    id="${meta%% *}"
    local asize="${meta#* }"
    [[ "$asize" =~ ^[0-9]+$ ]] || asize=0
    if [[ -n "$id" ]]; then
      local aurl="https://api.github.com/repos/$repo/releases/assets/$id"
      info "release-assets 通道（asset $id，$(( asize / 1048576 )) MiB）→ $out"
      if fetch_one rest "$aurl" "$out" "$asize"; then
        verify_out "$out" ${sha:+-s "$sha"}; return 0
      fi
      if have_node; then
        warn "curl 走不通，改用 node fetch"
        if node_download "$aurl" "$out" "$t"; then verify_out "$out" ${sha:+-s "$sha"}; return 0; fi
      fi
      warn "release-assets 失败，回落到直链"
    fi
  fi

  cmd_download "https://github.com/$repo/releases/download/$tag/$name" --out "$out" ${sha:+-s "$sha"}
}

# 委派官方 gh：api.github.com → release-assets.githubusercontent.com（本机实测可达）
cmd_ghdl() {
  local repo="${1:?需要 owner/repo}"; shift
  local tag=""
  if [[ $# -gt 0 && "$1" != -* ]]; then tag="$1"; shift; fi
  local g; g=$(gh_bin) || die "找不到 gh" 1
  local -a args=(release download)
  [[ -n "$tag" ]] && args+=("$tag")
  args+=(-R "$repo")
  info "委派: gh ${args[*]} $*"
  "$g" "${args[@]}" "$@" || die "gh release download 失败" 2
}

# release：列出 release 的 tag / 资产。没有 "latest" release 时（404）回退到列全部。
cmd_release() {
  local repo="${1:?需要 owner/repo}" tag="${2:-latest}" path out
  path="repos/$repo/releases/latest"
  [[ "$tag" != latest ]] && path="repos/$repo/releases/tags/$tag"
  if out=$(cmd_api "$path" 2>/dev/null); then
    printf "%s" "$out" | grep -oE '"(tag_name|name|browser_download_url|published_at|size)":[[:space:]]*("[^"]*"|[0-9]+)'
    return 0
  fi
  warn "取不到 $tag，改为列出全部 release"
  out=$(cmd_api "repos/$repo/releases" 2>/dev/null) || die "release: 连列表都取不到" 2
  printf "%s" "$out" | grep -oE '"(tag_name|name|browser_download_url|published_at|size)":[[:space:]]*("[^"]*"|[0-9]+)'
  [[ -n "$out" ]] || info "该仓库还没有任何 release"
  return 0
}

cmd_clone() {
  local repo="${1:?需要 owner/repo}" dir="${2:-$(basename "$1")}"
  [[ "$repo" == */* ]] || die "clone: 需要 owner/repo"
  local url="https://github.com/$repo.git"
  local ssh_url; ssh_url=$(ssh_url_of "$repo")

  # 本会话的 git 能不能 fork 传输进程？不能的话 clone 在这里注定全灭，先说清楚
  local fork fork_msg; { read -r fork; read -r fork_msg; } < <(git_fork_state)
  case "$fork" in
    blocked)
      warn "$fork_msg"
      warn "  clone 在本会话里跑不了（git 连 git-remote-https 都 fork 不出来）。"
      warn "  在普通终端执行即可："
      warn ""
      warn "    git clone $(ssh_url_of "$repo") $dir"
      warn ""
      warn "  或者只读分析某个仓库的源码：github.sh api repos/$repo/contents/<path>"
      return 4 ;;
  esac

  # 1) SSH 优先，也是本机 push 的唯一通道
  if [[ -f "$HOME/.ssh/id_ed25519_gh" ]]; then
    info "尝试: SSH ($ssh_url)"
    local csp; csp=$(ssh_pin github.com)
    if git -c core.sshCommand="ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new $csp" clone "$ssh_url" "$dir" >/dev/null 2>&1; then
      ok "clone 成功: $dir（SSH）"; return 0
    fi
    rm -rf "$dir" 2>/dev/null
  fi

  # 2) HTTPS 直连（SSH 失败时才试；schannel 后端避免私有 CA 干扰）
  info "尝试: HTTPS ($url)"
  if git -c http.sslBackend=schannel clone --depth 1 "$url" "$dir" >/dev/null 2>&1; then
    ok "clone 成功: $dir（HTTPS）"; return 0
  fi
  rm -rf "$dir" 2>/dev/null
  die "clone 全部通道失败" 2
}

# push 只有一条通道：SSH。
# 走本地 ~/.ssh/id_ed25519_gh（22 或 ssh.github.com:443），不需要 token。
push_ssh() {
  local repo="$1" ref="$2"
  [[ -f "$HOME/.ssh/id_ed25519_gh" ]] || {
    warn "缺 SSH 密钥 ~/.ssh/id_ed25519_gh（skills-vault 里的 setup-gh.sh 生成）"; return 1; }
  local ssh_url; ssh_url=$(ssh_url_of "$repo")
  info "push(ssh) → $ssh_url ($ref)"
  local t0 t1 rc out
  t0=$(date +%s)
  # sshCommand 里也钉 IP：git 起的每次 ssh 都要重新解析，冷的时候一次就要 3–14 s。
  local sp; sp=$(ssh_pin github.com)
  out=$(GIT_TERMINAL_PROMPT=0 git -c core.sshCommand="ssh -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new $sp" push "$ssh_url" "$ref" 2>&1)
  rc=$?
  t1=$(date +%s)
  (( t1 > t0 )) && info "耗时 $((t1-t0))s"
  [[ $rc -eq 0 ]] && { ok "push 成功（ssh）"; return 0; }
  printf '%s\n' "$out" | sed 's/^/  /' >&2
  return 1
}

cmd_push() {
  local -a pos=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -*)    die "push: 未知选项 $1（只走 SSH，没有通道选项）" ;;
      *)     pos+=("$1"); shift ;;
    esac
  done
  [[ ${#pos[@]} -ge 1 ]] || die "push: 需要 owner/repo [ref] [remote]"
  local repo="${pos[0]}" ref="${pos[1]:-HEAD}" remote="${pos[2]:-origin}"
  [[ "$repo" == */* ]] || die "push: 需要 owner/repo"

  local fork fork_msg; { read -r fork; read -r fork_msg; } < <(git_fork_state)
  case "$fork" in
    blocked)
      warn "当前会话的 git 起不了传输进程：$fork_msg"
      warn ""
      warn "这不是仓库或网络的问题，是受限会话（沙箱）禁止 git fork 子进程。"
      warn "本地提交照常可用；推送要在一个普通终端里执行："
      warn ""
      warn "  bash tools/github.sh push $repo $ref"
      warn "  （或 git push $(ssh_url_of "$repo") $ref）"
      warn ""
      warn "要在这个会话里确认推送成功，用：github.sh api repos/$repo/commits/<sha> 对照。"
      return 4 ;;
  esac

  info "push $repo $ref → $remote（SSH）"
  push_ssh "$repo" "$ref" || die "push 失败。SSH 不通先查账号上有没有公钥：github.sh api users/<owner>/keys" 2
}

cmd_sshcheck() {
  [[ -f "$HOME/.ssh/id_ed25519_gh" ]] || { warn "没有 ~/.ssh/id_ed25519_gh"; return 1; }
  local out
  local port host; read -r port host < <(ssh_target)
  out=$(_ssh_try "$host" "$port" "$(ssh_pin "$host")")
  case "$out" in
    *"successfully authenticated"*) ok "$out"; return 0 ;;
    *) warn "SSH 认证失败: $out"; return 1 ;;
  esac
}

# raw 取文件正文。raw 域本机时通时不通，所以：
# 1) 走 API contents 端点（最稳，base64 回来自己解）；
# 2) 再试 node fetch 直取 raw 域；
# 3) 最后才试 curl 直连。
cmd_raw() {
  local repo="${1:?owner/repo}" ref="${2:?ref}" path="${3:?path}"
  local t json b64 out
  t=$(gh_token 2>/dev/null || true)

  # 1) API contents
  if [[ -n "$t" ]]; then
    json=$(cmd_api "repos/$repo/contents/$path?ref=$ref" 2>/dev/null)
    b64=$(printf "%s" "$json" | node -e '
      let s="";
      process.stdin.on("data", d => s += d);
      process.stdin.on("end", () => {
        try { const j = JSON.parse(s);
          if (j && j.content && j.encoding === "base64") {
            process.stdout.write(Buffer.from(j.content, "base64").toString("utf8"));
          } else { process.exitCode = 1; }
        } catch (e) { process.exitCode = 1; }
      });
    ' 2>/dev/null)
    if [[ -n "$b64" ]]; then printf "%s\n" "$b64"; return 0; fi
  fi

  # 2) node 直取 raw 域
  local rawurl="https://raw.githubusercontent.com/$repo/$ref/$path"
  if out=$(node_get "$rawurl" "$t" 2>/dev/null) && [[ -n "$out" ]] && ! grep -qi "<!DOCTYPE html" <<<"$out"; then
    printf "%s\n" "$out"; return 0
  fi

  # 3) curl 直连
  local auth=()
  [[ -n "$t" ]] && auth=(-H "Authorization: token $t")
  out=$(curl -sS $(net_opts) --max-time 25 "${auth[@]}" -L "$rawurl" 2>/dev/null)
  if [[ -n "$out" ]] && ! grep -qi "<!DOCTYPE html" <<<"${out:0:200}"; then printf "%s\n" "$out"; return 0; fi
  die "raw 取不到: $repo/$ref/$path" 2
}

# 打印脚本实际读取/推导的配置变量及当前值。
cmd_env() {
  printf '%-24s %s\n' \
    GITHUB_TOKEN_FILE   "$TOKEN_FILE（$( [[ -s "$TOKEN_FILE" ]] && echo 存在 || echo 缺失 )）" \
    GITHUB_DL_DIR       "$DL_DIR" \
    ARIA2C              "$ARIA2（$( command -v "$ARIA2" >/dev/null 2>&1 && echo 在 PATH || echo 不在 PATH )）" \
    GITHUB_ARIA2_MIN    "$ARIA2_MIN" \
    GITHUB_PROBE        "$PROBE（1 = 先测速再选路）" \
    GITHUB_PROBE_BYTES  "$PROBE_BYTES" \
    GITHUB_PROBE_TIMEOUT "$PROBE_TIMEOUT" \
    GITHUB_DNS_PIN_TTL  "$DNS_PIN_TTL（秒；0 = 每次重解析）" \
    GITHUB_PIN_HOSTS    "$PIN_HOSTS"
  return 0
}

# status 的判读原则：每条通道都说清「这次探测走的是哪个传输器、结论是什么」。
# 不能把 curl 的失败报成「token 无效」——那是把传输器问题栽给 token。
cmd_token() { require_token; echo; }

cmd_status() {
  echo "── gh ──" >&2
  local g
  if g=$(gh_bin); then
    ok "$("$g" --version | head -1)"
    info "  路径: $g"
    command -v gh >/dev/null 2>&1 || warn "当前 shell 的 PATH 还没有它（新开终端即有；本脚本不受影响）"
  else
    warn "找不到 gh（预期在 C:/Program Files/GitHub CLI/gh.exe）"
  fi

  echo "── 传输器 ──" >&2
  if command -v curl >/dev/null 2>&1; then
    local cver cprobe
    cver=$(curl --version 2>/dev/null | head -1)
    # 探针必须吃钉 IP：冷缓存下 getaddrinfo 要 ~12 s，--max-time 8 会把好 curl 判成坏 curl
    # （实测误报「curl 不可用 / curl: (28) Resolving timed out after 8001 milliseconds」）。
    cprobe=$(curl -sS -o /dev/null -w "%{http_code}" $(net_opts) --max-time 25 https://api.github.com/ 2>&1 || true)
    if [[ "$cprobe" == "200" ]]; then
      ok "curl 可用 ($cver)"
    else
      warn "curl 不可用：$cver"
      warn "  探测 api.github.com 得到: ${cprobe:0:160}"
      case "$cprobe" in
        *SEC_E_NO_CREDENTIALS*|*"curl: (35)"*)
          warn "  这是本机 curl 的 TLS 句柄问题，不是网络也不是 token。api/status 会自动改用 gh 或 node。" ;;
      esac
    fi
  else
    warn "没有 curl"
  fi
  if have_node; then ok "node $(node --version 2>/dev/null)（fetch 是最后的兜底传输器）"
  else warn "没有 node（fetch 兜底不可用）"; fi

  echo "── token ──" >&2
  if [[ -s "$TOKEN_FILE" ]]; then
    ok "token 文件存在: $TOKEN_FILE ($(wc -c < "$TOKEN_FILE" | tr -d " ") bytes)"
  else
    warn "token 文件不存在: $TOKEN_FILE"
  fi
  local t who="" how=""
  if t=$(gh_token) && [[ -n "$t" ]]; then
    # 顺序必须和 cmd_api 一致：gh → curl → node。三处（api / status / asset）以前各写一套，
    # 同一台机器上「谁先谁后」都不一样，读代码的人没法预测。统一成这一个顺序。
    # 失败时如实说是哪个传输器失败，不把传输器问题栽给 token。
    if g=$(gh_bin) && who=$(GH_TOKEN="$t" "$g" api user --jq .login 2>/dev/null) && [[ -n "$who" ]]; then
      how="gh api"
    elif raw=$(curl -sS $(net_opts) --max-time 15 -H "Authorization: token $t" -H "Accept: application/vnd.github+json" https://api.github.com/user 2>/dev/null) && [[ -n "$raw" ]]; then
      who=$(printf "%s" "$raw" | grep -o "\"login\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | cut -d"\"" -f4)
      how="curl"
    elif raw=$(node_get "https://api.github.com/user" "$t" 2>/dev/null) && [[ -n "$raw" ]]; then
      who=$(printf "%s" "$raw" | grep -o "\"login\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | cut -d"\"" -f4)
      how="node fetch"
    fi
    if [[ -n "$who" ]]; then ok "api.github.com 认证为: $who（经 $how）"
    else warn "三个传输器都没能认证 api.github.com —— 先看上面「传输器」一节，别急着换 token"; fi
  else
    warn "无 token"
  fi

  echo "── 通道可达性（用 node fetch 探测，绕开 curl 的 TLS 问题）──" >&2
  local code size tries i
  # 每条通道探测一个真实可取的 URL。codeload 的根路径会直接拒绝，必须打归档路径，
  # 否则会把「本来能用」的通道误判成不通（2026-11-06 实测：root 失败，tar.gz 200）。
  local -a probes=(
    "api.github.com|https://api.github.com/|API 挂了就没法干活；重试或换时段"
    "github.com|https://github.com/|本机 TCP 层大概率连不上（net.connect 实测 6 s 超时）；不影响干活：写走 SSH，读走 api.github.com"
    "codeload.github.com|https://codeload.github.com/octocat/Hello-World/tar.gz/refs/heads/master|归档域；根路径 403 是它自己的策略，不代表不通"
    "raw.githubusercontent.com|https://raw.githubusercontent.com/dongopencv/tools/master/AGENTS.md|raw 域时通时不通（实测 8/8 失败、偶发成功）；要稳就改走 api.github.com/repos/<o>/<r>/contents/<path>"
    "release-assets.githubusercontent.com|https://release-assets.githubusercontent.com/|release 资产域（根路径 404 属正常）"
  )
  local item name purl hint idx
  # 探针必须并行：单条最坏要 8 s 超时（github.com 与 raw 域本来就不通），
  # 串行七条实测 status 要 35–58 s —— 用户根本不会等，等于没测。
  # 并行后整节压到「最慢的那一条」，输出顺序仍按 probes 表的顺序。
  local -a pids=()
  local tdir; tdir=$(mktemp -d 2>/dev/null || echo "/tmp/pc1-status-$"); mkdir -p "$tdir"
  idx=0
  for item in "${probes[@]}"; do
    IFS="|" read -r name purl hint <<< "$item"
    ( r=$(node_probe "$purl"); printf "%s" "$r" > "$tdir/p$idx" ) &
    pids+=($!)
    idx=$((idx+1))
  done
  # SSH 两条也一起跑：跟 HTTPS 探针互不依赖，各自 3–15 s 且谁慢谁快每轮都不一样。
  # 重定向顺序有讲究：必须 `> file 2>&1`。写成 `2>&1 > file` 的话，stderr 会先复制到"当时的"
  # stdout（终端），再让 stdout 指向文件 —— 结果 ssh 的整段诊断都进了终端、文件是空的，
  # 这里就会把能用的 SSH 报成"不通（20 s 内没有输出）"。（本轮踩到并修）
  # 两条 SSH 探针同样钉 IP（ssh_pin），否则冷解析一次就吃掉 14 s，把整条 status 拖长。
  ( timeout 20 ssh -p 22  -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new $(ssh_pin github.com)    -T git@github.com    > "$tdir/s0" 2>&1 ) & pids+=($!)
  ( timeout 20 ssh -p 443 -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new $(ssh_pin ssh.github.com) -T git@ssh.github.com > "$tdir/s1" 2>&1 ) & pids+=($!)
  for idx in "${!pids[@]}"; do wait "${pids[$idx]}" 2>/dev/null || true; done

  idx=0
  for item in "${probes[@]}"; do
    IFS="|" read -r name purl hint <<< "$item"
    code=000; size=0
    [[ -s "$tdir/p$idx" ]] && read -r code size < "$tdir/p$idx"
    [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
    [[ "$size" =~ ^[0-9]+$ ]] || size=0
    # api.github.com 偶发抖动，单独重试一次；其余域本来就不通，重试没意义。
    if [[ "$code" == 000 && "$name" == api.github.com ]]; then
      read -r code size < <(node_probe "$purl")
      [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
      [[ "$size" =~ ^[0-9]+$ ]] || size=0
    fi
    case "$code" in
      200|206) ok "$name → $code（$size B）" ;;
      000)     warn "$name → 不通"
               [[ -n "$hint" ]] && warn "    $hint" ;;
      *)       ok "$name → $code（端口通，非 200 属正常）"
               if [[ "$code" == 403 && "$name" == codeload* ]] || [[ "$code" == 404 && "$name" == release-assets* ]]; then :
               else [[ -n "$hint" ]] && warn "    $hint"; fi ;;
    esac
    idx=$((idx+1))
  done

  echo "── SSH（push 通道） ──" >&2
  # 2026-11-08：别再用 /dev/tcp 探端口。MSYS bash 的 /dev/tcp 连 github.com:22 会 10 s 超时，
  # 而同一秒 `ssh -T git@github.com` 秒回 authenticated —— 探测手段本身在骗人（#5 复核）。
  # 直接拿真正要用的 ssh 去试，顺手把「端口通」与「密钥注册了」一次说清。
  local sshok=0 out hp
  idx=0
  for hp in "github.com 22" "ssh.github.com 443"; do
    out=""; [[ -s "$tdir/s$idx" ]] && out=$(cat "$tdir/s$idx" 2>/dev/null)
    case "$out" in
      *"successfully authenticated"*) ok "$hp → 通，认证成功"; sshok=1 ;;
      *"Permission denied"*)         warn "$hp → 端口通，但认证失败（公钥没注册到这个账号？）" ;;
      *)                             warn "$hp → 不通（20 s 内没有输出）" ;;
    esac
    idx=$((idx+1))
  done
  rm -rf "$tdir" 2>/dev/null || true
  if [[ $sshok -eq 0 ]]; then
    warn "    两条 SSH 都不通 → push 做不了。先在 https://github.com/settings/keys 确认公钥已注册。"
  fi

  echo "── git 传输（本会话能不能 push/fetch） ──" >&2
  # 判据可以用已经花掉的 SSH 探针结果：两条 ssh 都认证成功了，就说明本会话能 fork 出
  # 远端助手进程（push/fetch 靠的就是它），不必再自己跑一遍 ls-remote。
  # 这一步以前无条件重跑 ls-remote，实测白等 7–11 s。
  #
  # 正常路径（SSH 通）根本不用再问 git：能 ssh 认证就说明本会话能 fork 出远端助手，
  # 那正是 push/fetch 需要的。只有 SSH 也不通时，才值得花 15 s 跑一次 ls-remote 去区分
  # 「网络挂了」和「沙箱禁了 fork」。
  local fork="" fork_msg=""
  if [[ $sshok -eq 1 ]]; then
    ok "git 可以起远端进程：SSH 探针已认证成功，push/fetch 可用"
  else
    { read -r fork; read -r fork_msg; } < <(git_fork_state)
    case "$fork" in
      ok)      ok "git 可以起远端进程：$fork_msg" ;;
      blocked) warn "$fork_msg"
               warn "  本会话只能本地提交；push/fetch/clone 要人在普通终端跑。" ;;
      "")      warn "git ls-remote 没有输出（SSH 也不通，push 大概率做不了）" ;;
      *)       warn "$fork_msg" ;;
    esac
  fi
}

# api：先 gh，再 curl，最后 node。三者的失败理由不一样，不能混为一谈。
# gh 自带 TLS 栈且处理分页/JSON；curl 在本机可能没有 TLS 句柄；node 永远兜底。
cmd_api() {
  local method=GET path="" jq="" body="" x
  local -a fields=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -X|--method) method="$2"; shift 2 ;;
      -f|--field)  fields+=("$2"); shift 2 ;;
      -F|--raw)    body="$2"; shift 2 ;;
      --jq)        jq="$2"; shift 2 ;;
      -*)          die "api: 未知选项 $1" ;;
      *)           if [[ -z "$path" ]]; then path="$1"; else fields+=("$1"); fi; shift ;;
    esac
  done
  [[ -n "$path" ]] || die "api: 需要 API 路径，例如 repos/owner/repo"
  [[ "$path" == /* ]] || path="/$path"

  # 1) gh api —— 最稳，且能直接 --jq
  #    gh 的字段参数是 -f k=v（= --raw-field，字符串）；整段 JSON body 用 --input <文件>。
  #    不要把 -d 塞给 gh：gh 没有 -d，它只认 -f/-F/--input。
  local g out rc i gerr bodyf=""
  if g=$(gh_bin); then
    local -a gargs=(api -X "$method")
    [[ -n "$jq" ]] && gargs+=(--jq "$jq")
    if [[ -n "$body" ]]; then
      bodyf=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gbody.$$")
      printf '%s' "$body" > "$bodyf" 2>/dev/null || bodyf=""
      [[ -n "$bodyf" ]] && gargs+=(--input "$bodyf")
    elif [[ ${#fields[@]} -gt 0 ]]; then
      for x in "${fields[@]}"; do gargs+=(-f "$x"); done
    fi
    gargs+=("${path#/}")
    gerr=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gherr.$$")
    if out=$("$g" "${gargs[@]}" 2>"$gerr"); then
      rm -f "$gerr" 2>/dev/null; [[ -n "$bodyf" ]] && rm -f "$bodyf" 2>/dev/null
      echo "$out"; return 0
    fi
    # gh 报 HTTP 错误说明传输本身是通的，API 明确拒绝了这个路径——照实说，别再换传输器
    if grep -qi "HTTP [45][0-9][0-9]" "$gerr" 2>/dev/null; then
      rm -f "$gerr" 2>/dev/null; [[ -n "$bodyf" ]] && rm -f "$bodyf" 2>/dev/null
      die "api: GitHub 返回错误 → $method $path" 3
    fi
    rm -f "$gerr" 2>/dev/null; [[ -n "$bodyf" ]] && rm -f "$bodyf" 2>/dev/null
  fi

  local t; t=$(gh_token 2>/dev/null || true)
  [[ -n "$t" ]] || die "api: 没有 token，且 gh 调用失败" 2

  # 2) curl —— 字段用 -d k=v，整段 body 用 --data-raw
  local -a cargs=()
  if [[ -n "$body" ]]; then
    cargs+=(--data-raw "$body")
  else
    for x in "${fields[@]}"; do cargs+=(-d "$x"); done
  fi
  for ((i=1; i<=2; i++)); do
    out=$(curl -sS $(net_opts) --max-time 30 -X "$method" -H "Authorization: token $t" \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      "${cargs[@]}" "https://api.github.com$path" 2>/dev/null)
    rc=$?
    if [[ $rc -eq 0 && -n "$out" ]]; then
      # HTTP 错误也算成功到达：把状态码带出来
      if printf "%s" "$out" | head -c 200 | grep -q "\"status\":4[0-9][0-9]\"\|\"status\":5[0-9][0-9]\""; then
        die "api: GitHub 返回错误 → $method $path" 3
      fi
      echo "$out"; return 0
    fi
    (( i < 2 )) && sleep 1
  done

  # 3) node fetch（只兜底 GET；带 body 的写请求没有 node 实现，别假装成功）
  if [[ "$method" == GET && -z "$body" && ${#fields[@]} -eq 0 ]]; then
    if out=$(node_get "https://api.github.com$path" "$t" 2>/dev/null) && [[ -n "$out" ]]; then
      echo "$out"; return 0
    fi
  fi
  die "api: gh/curl/node 三条路全失败（先跑 github.sh status 看是哪一层）" 2
}

# ──────────────────────────────────────────────────────────────────────────
case "${1:-}" in
  status)   shift; cmd_status "$@" ;;
  env)      shift; cmd_env "$@" ;;
  token)    shift; cmd_token "$@" ;;
  api)      shift; cmd_api "$@" ;;
  release)  shift; cmd_release "$@" ;;
  download) shift; cmd_download "$@" ;;
  asset)    shift; cmd_asset "$@" ;;
  ghdl)     shift; cmd_ghdl "$@" ;;
  clone)    shift; cmd_clone "$@" ;;
  push)     shift; cmd_push "$@" ;;
  sshcheck) shift; cmd_sshcheck "$@" ;;
  raw)      shift; cmd_raw "$@" ;;
  ""|-h|--help|help)
    sed -n '2,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# *//'
    ;;
  *) die "未知子命令: $1（用 help 看用法）" ;;
esac
