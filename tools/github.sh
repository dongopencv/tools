#!/usr/bin/env bash
# github.sh — 本机唯一 GitHub 操作网关
#
# 铁律：本机所有 GitHub 操作（API / 下载 / clone / 发布 / 查仓库）都必须经过
#       这个脚本，不允许各处手搓 curl/gh/git 直连。依据见 docs/network-baseline.md：
#       github.com 的 443 被墙，api.github.com 通，release 资产要选路，
#       token 只在网关里读取一次。
#
# 下载通道（按序探测，取探测到字节数最大的那条）：
#   relay   本机中转站 127.0.0.1:8899。MITM 反代，把 github 家族域名改写到镜像站。
#           优点：URL 不用改，任何工具都能透明走；中转站在线时自动进入候选。
#   mirror  gh-proxy.com / ghfast.top / ghproxy.net 前缀改写（直连镜像站）。
#   direct  裸 url（github 家族本机基本不通，留给 codeload/api 这类可达域名）。
#
# 用法：
#   github.sh status                       # 自检：gh / token / 身份 / 各通道 / SSH
#   github.sh env                          # 打印 export，eval 后当前 shell 全走中转站
#   github.sh relay [up|down|status]       # 中转站起停查
#   github.sh token                        # 打印 token（供其它脚本 $(...) 取用）
#   github.sh api <path>                   # GET api.github.com（自动带 token）
#   github.sh api -X POST <path> -f k=v    # 带 body 的写操作
#   github.sh release <owner/repo> [tag]   # release 的 tag + 资产清单
#   github.sh download <url> [-o FILE] [-s SHA256] [--via relay|mirror|direct]
#   github.sh asset <owner/repo> <tag> <file> [-o FILE] [-s SHA256] [--via ...]
#   github.sh ghdl <owner/repo> [tag] [-p PATTERN] [-D DIR]  # 委派 gh release download
#   github.sh clone <owner/repo> [DIR]     # SSH 优先 → relay(HTTPS) → 镜像
#   github.sh push <owner/repo> [ref]      # 只能走 SSH（HTTPS 写操作本机全死）
#   github.sh sshcheck                     # 验证 SSH 密钥对 GitHub 的认证
#   github.sh raw <owner/repo> <ref> <path>
#
# 退出码：0 成功 / 1 参数或环境错误 / 2 网络全通道失败 / 3 校验失败
set -uo pipefail
# 关掉通配符展开：curl_opts 会产出 "--noproxy *"，星号必须保持字面量
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$SCRIPT_DIR/.github-token}"
# 仓库内没有 token 时回落到技能目录（token 只该存在那里，见 AGENTS.md 凭据纪律）
if [[ ! -s "$TOKEN_FILE" && -s /c/Users/Admin/.skills-vault/download/scripts/.github-token ]]; then
  TOKEN_FILE=/c/Users/Admin/.skills-vault/download/scripts/.github-token
fi

MIRRORS=(https://gh-proxy.com/ https://ghfast.top/ https://ghproxy.net/ "")
DL_DIR="${GITHUB_DL_DIR:-$HOME/Downloads/github}"
ARIA2="${ARIA2C:-aria2c}"

# ── 中转站（8899 MITM 反代）──
RELAY="${GITHUB_RELAY:-http://127.0.0.1:8899}"
RELAY_HOST="${GITHUB_RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${GITHUB_RELAY_PORT:-8899}"
RELAY_SERVER="${GITHUB_RELAY_SERVER:-/c/Users/Admin/dsh-mirror-proxy/server.mjs}"
RELAY_CA="${GITHUB_RELAY_CA:-/c/Users/Admin/dsh-mirror-proxy/certs/ca.crt.pem}"

info() { echo "$*" >&2; }
ok()   { echo "[ok] $*" >&2; }
warn() { echo "[warn] $*" >&2; }
die()  { echo "[fail] $1" >&2; exit "${2:-1}"; }

# ── gh 定位：Windows 上 MSI 装完要重开 shell 才进 PATH，这里主动找 ──
gh_bin() {
  command -v gh 2>/dev/null && return 0
  local c
  for c in "/c/Program Files/GitHub CLI/gh.exe"            "/c/Program Files (x86)/GitHub CLI/gh.exe"            "$LOCALAPPDATA/GitHubCLI/bin/gh.exe"            /c/Users/Admin/.local/bin/gh.exe; do
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

# ── curl 参数：Schannel 对 MITM 私有 CA 的吊销查询会失败，必须 --ssl-no-revoke ──
SCHANNEL=0
curl --version 2>/dev/null | head -1 | grep -qi schannel && SCHANNEL=1

# 按通道给 curl 参数：relay 走 -x 代理；rest 在没有环境代理时强制 --noproxy
curl_opts() {
  local kind="$1"
  (( SCHANNEL )) && { echo --ssl-no-revoke; }
  if [[ "$kind" == relay ]]; then
    echo -x; echo "$RELAY"
  else
    [[ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]] || { echo --noproxy; echo '*'; }
  fi
  return 0
}
CSL=(); while IFS= read -r x; do CSL+=("$x"); done < <(curl_opts rest)

opts_of() { local -a a=(); while IFS= read -r v; do a+=("$v"); done < <(curl_opts "$1"); echo "${a[*]}"; }

# ──────────────────────────────────────────────────────────────────────────
# 传输通道：gh 优先 → curl → node fetch
#
# 背景（2026-11-06 实测于 PC1 受限会话）：curl 可能拿不到 TLS 凭据句柄
#   curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS
# 此时 gh（自带 TLS 栈）与 node 的 fetch 仍可用。因此 api/status 不能只绑 curl。
# ──────────────────────────────────────────────────────────────────────────

have_node() { command -v node >/dev/null 2>&1; }

# node fetch 取 GET 正文；成功打印 body，失败非零
node_get() {
  local url="$1" tok="${2:-}"
  have_node || return 1
  node -e '
    const [u, tok] = process.argv.slice(1);
    const h = { "User-Agent": "pc1-github-sh", "Accept": "application/vnd.github+json" };
    if (tok) h["Authorization"] = "Bearer " + tok;
    fetch(u, { headers: h })
      .then(async r => {
        const t = await r.text();
        if (!r.ok) { process.stderr.write("http " + r.status + "\n"); process.exit(1); }
        process.stdout.write(t);
      })
      .catch(e => { process.stderr.write(String(e.message || e) + "\n"); process.exit(1); });
  ' "$url" "$tok"
}

# node 下载：curl 不可用时的兜底。
#   node_download <url> <out>                 —— 直连（不走中转/镜像）
#   node_download <url> <out> <token>         —— 带 Authorization（API 资产端点要用）
#   node_download <url> <out> <token> <proxy> —— 额外走 HTTP 代理（relay 通道）。
#                                     node ≥ 24 用 NODE_USE_ENV_PROXY=1 生效（实测可用）。
node_download() {
  local url="$1" out="$2" tok="${3:-}" proxy="${4:-}"
  have_node || return 1
  if [[ -n "$proxy" ]]; then
    NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" \
      node -e '
        const [u, o, tok] = process.argv.slice(1);
        const fs = require("fs");
        const h = { "User-Agent": "pc1-github-sh" };
        if (tok) h["Authorization"] = "Bearer " + tok;
        fetch(u, { headers: h, redirect: "follow" })
          .then(async r => {
            if (!r.ok) { process.stderr.write("http " + r.status + "\n"); process.exit(1); }
            fs.writeFileSync(o, Buffer.from(await r.arrayBuffer()));
          })
          .catch(e => { process.stderr.write(String(e.message || e) + "\n"); process.exit(1); });
      ' "$url" "$out" "$tok"
    return $?
  fi
  node -e '
    const [u, o, tok] = process.argv.slice(1);
    const fs = require("fs");
    const h = { "User-Agent": "pc1-github-sh" };
    if (tok) h["Authorization"] = "Bearer " + tok;
    fetch(u, { headers: h, redirect: "follow" })
      .then(async r => {
        if (!r.ok) { process.stderr.write("http " + r.status + "\n"); process.exit(1); }
        fs.writeFileSync(o, Buffer.from(await r.arrayBuffer()));
      })
      .catch(e => { process.stderr.write(String(e.message || e) + "\n"); process.exit(1); });
  ' "$url" "$out" "$tok"
}

# node fetch 探测：输出 "<code> <bytes>"
node_probe() {
  local url="$1"
  have_node || { echo "000 0"; return 1; }
  node -e '
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    fetch(process.argv[1], { headers: { "User-Agent": "pc1-github-sh" }, redirect: "follow", signal: ac.signal })
      .then(async r => { const b = await r.arrayBuffer(); process.stdout.write(r.status + " " + b.byteLength); })
      .catch(() => process.stdout.write("000 0"))
      .finally(() => clearTimeout(t));
  ' "$url" 2>/dev/null || echo "000 0"
}

# gh api 可用性（一次 status 内只测一次）
GH_API_OK=""
gh_api_ok() {
  if [[ -z "$GH_API_OK" ]]; then
    local g
    if g=$(gh_bin) && "$g" api user >/dev/null 2>&1; then GH_API_OK=1; else GH_API_OK=0; fi
  fi
  [[ "$GH_API_OK" == 1 ]]
}

# git 能否 fork 远端助手（不能则 push/fetch/clone 在本会话里全废）
git_fork_state() {
  local out
  git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "n/a|不在 git 仓库里"; return 0; }
  out=$(git ls-remote "$(git remote get-url origin 2>/dev/null || echo .)" HEAD 2>&1 || true)
  case "$out" in
    *"cannot create standard input pipe"*|*"unable to fork"*|*"Permission denied"*)
      echo "blocked|沙箱禁止 git fork 管道（cannot create standard input pipe）" ;;
    "") echo "unknown|git ls-remote 无输出" ;;
    *)  echo "ok|git 远端通道可用" ;;
  esac
}

# ── 中转站探测 / 起停 ──
relay_up() { (exec 3<>/dev/tcp/$RELAY_HOST/$RELAY_PORT) 2>/dev/null; }

relay_start() {
  relay_up && { echo "[ok] 中转站已在跑 ($RELAY)" >&2; return 0; }
  [[ -f "$RELAY_SERVER" ]] || { warn "中转站服务文件不存在: $RELAY_SERVER"; return 1; }
  command -v node >/dev/null 2>&1 || { warn "没有 node，起不了中转站"; return 1; }
  info "拉起中转站: node $RELAY_SERVER"
  nohup node "$RELAY_SERVER" >/dev/null 2>&1 &
  local i
  for i in $(seq 1 40); do
    relay_up && { ok "中转站就绪 ($RELAY)"; return 0; }
    sleep 0.25
  done
  warn "中转站启动超时"
  return 1
}

relay_stop() {
  relay_up || { info "中转站没在跑"; return 0; }
  local pid
  pid=$(netstat -ano 2>/dev/null | grep LISTENING | grep -E "[:.]$RELAY_PORT[[:space:]]" | awk '{print $NF}' | head -1)
  [[ -n "$pid" ]] || { warn "没找到监听 $RELAY_PORT 的进程"; return 1; }
  taskkill //PID "$pid" //F >/dev/null 2>&1 && { ok "已停止中转站 (pid $pid)"; return 0; }
  warn "停止失败 (pid $pid)"
  return 1
}

# ── 通道枚举：每行 kind|url ──
candidates() {
  local url="$1" m
  relay_up && echo "relay|$url"
  for m in "${MIRRORS[@]}"; do
    if [[ -z "$m" ]]; then echo "direct|$url"; else echo "prefix|$m$url"; fi
  done
  return 0
}

prefix_name() {
  case "$1" in
    https://gh-proxy.com/*) echo gh-proxy ;;
    https://ghfast.top/*)   echo ghfast ;;
    https://ghproxy.net/*)  echo ghproxy.net ;;
    relay)                  echo "relay(8899)" ;;
    prefix)                 echo mirror ;;
    direct)                 echo direct ;;
    *)                      echo "$1" ;;
  esac
}

# 探测：只信 200/206 且有字节回来。curl 不可用时改用 node fetch。
probe() {
  local kind="$1" url="$2" code size
  read -r code size < <(curl -sS $(opts_of "$kind") -o /dev/null       -w '%{http_code} %{size_download}' --max-time 12 -L -r 0-1023 "$url" 2>/dev/null || echo "000 0")
  if [[ "$code" == 000 ]]; then
    read -r code size < <(node_probe "$url")
  fi
  echo "$code $size"
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
  local actual; actual=$(sha256sum "$out" 2>/dev/null | awk '{print $1}')
  if [[ -n "$sha" ]]; then
    if [[ "${actual,,}" == "${sha,,}" ]]; then ok "SHA256 校验通过"
    else die "SHA256 不匹配（期望 ${sha,,} / 实际 $actual）" 3; fi
  else
    info "SHA256: $actual （未提供期望值，未比对）"
  fi
  ok "完成: $out ($(du -h "$out" | cut -f1))"
  echo "$out"
}

cmd_download() {
  local url="" out="" sha="" via=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--out)    out="$2"; shift 2 ;;
      -s|--sha256) sha="$2"; shift 2 ;;
      --via)       via="$2"; shift 2 ;;
      -*)          die "download: 未知选项 $1" ;;
      *)           url="$1"; shift ;;
    esac
  done
  [[ -n "$url" ]] || die "download: 需要 URL"

  mkdir -p "$DL_DIR"
  if [[ -z "$out" ]]; then
    local base="${url%%\?*}"; out="$DL_DIR/$(basename "$base")"
  fi

  local chosen="" kind="" best=0 code size ck cu
  info "探测通道…（relay 需要中转站在线）"
  while IFS='|' read -r ck cu; do
    [[ -z "$ck" ]] && continue
    case "$via" in
      "")      ;;
      relay)   [[ "$ck" == relay ]] || continue ;;
      mirror)  [[ "$ck" == prefix ]] || continue ;;
      direct)  [[ "$ck" == direct ]] || continue ;;
      *)       die "download: --via 只支持 relay|mirror|direct" ;;
    esac
    read -r code size < <(probe "$ck" "$cu")
    if [[ "$code" == 200 || "$code" == 206 ]]; then
      (( size > best )) && { best=$size; chosen="$cu"; kind="$ck"; }
      info "  ok    $(prefix_name "$ck") $(prefix_name "$cu")  (http=$code)"
    else
      info "  skip  $(prefix_name "$ck") $(prefix_name "$cu")  (http=$code)"
    fi
  done < <(candidates "$url")
  [[ -n "$chosen" ]] || die "所有通道都失败（网络问题，不是 URL 问题）" 2
  info "选定通道: $(prefix_name "$kind") $(prefix_name "$chosen")"

  local dlok=0 alog
  alog="$(mktemp 2>/dev/null || echo "$out.aria2.log")"
  if command -v "$ARIA2" >/dev/null 2>&1; then
    info "下载中（aria2c 8 连接）→ $out"
    local -a ax=()
    [[ "$kind" == relay ]] && ax+=(--all-proxy="$RELAY")
    [[ -f "$RELAY_CA" ]] && ax+=(--ca-certificate="$RELAY_CA")
    if "$ARIA2" "${ax[@]}" --allow-overwrite=true -x 8 -s 8 -k 1M --max-tries=3 --timeout=30         --summary-interval=0 --console-log-level=warn --show-console-readout=false         --auto-file-renaming=false -o "$(basename "$out")" -d "$(dirname "$out")"         "$chosen" >"$alog" 2>&1; then dlok=1; else
      info "  aria2 失败，回退 curl"; grep -iE 'error|denied' "$alog" 2>/dev/null | head -3 >&2
    fi
  fi
  rm -f "$alog" 2>/dev/null
  if [[ $dlok -eq 0 ]]; then
    info "下载中（curl 续传）→ $out"
    curl -sS $(opts_of "$kind") -L -C - --retry 3 --max-time 900 -o "$out" "$chosen" >&2 && dlok=1
  fi
  if [[ $dlok -eq 0 ]] && have_node; then
    # curl 不可用（本机常见 TLS 凭据句柄问题）时，用 node fetch 兜底直取选定通道
    local -a ndl=("$chosen" "$out")
    [[ "$kind" == relay ]] && ndl+=("" "$RELAY")
    info "curl 没成，改用 node fetch 兜底 → $out"
    node_download "${ndl[@]}" && dlok=1
  fi
  [[ $dlok -eq 1 ]] || die "下载失败（curl 与 node 都拿不到内容；先跑 github.sh status 看通道）" 2
  verify_out "$out" ${sha:+-s "$sha"}
}

# 资产下载：先走常规通道（github.com 直链 + 镜像）；全失败时回落到 API 资产端点
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
  if cmd_download "https://github.com/$repo/releases/download/$tag/$name" --out "$out" ${sha:+-s "$sha"}; then
    return 0
  fi
  warn "常规通道失败，回落到 API 资产端点"
  local t json obj id
  t=$(require_token)
  json=$(cmd_api "repos/$repo/releases/tags/$tag" 2>/dev/null)
  obj=$(printf "%s" "$json" | grep -o "{[^{}]*\"name\":\"$name\"[^{}]*}" | head -1)
  id=$(printf "%s" "$obj" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  [[ -n "$id" ]] || die "API 里找不到资产 $name（tag=$tag）" 2
  info "API 资产端点 ($id) → $out"
  if ! curl -sS $(opts_of rest) -L --retry 3 --max-time 900 -o "$out" \
      -H "Authorization: token $t" -H "Accept: application/octet-stream" \
      "https://api.github.com/repos/$repo/releases/assets/$id" >&2; then
    warn "curl 走不通，改用 node fetch"
    node_download "https://api.github.com/repos/$repo/releases/assets/$id" "$out" "$t" || die "API 资产端点下载失败" 2
  fi
  verify_out "$out" ${sha:+-s "$sha"}
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
  if relay_up; then
    info "  经中转站 $RELAY"
    HTTP_PROXY="$RELAY" HTTPS_PROXY="$RELAY" NODE_EXTRA_CA_CERTS="$RELAY_CA"       "$g" "${args[@]}" "$@" || die "gh release download 失败" 2
  else
    "$g" "${args[@]}" "$@" || die "gh release download 失败" 2
  fi
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
  local ssh_url="git@github.com:$repo.git"

  # 本会话的 git 能不能 fork 传输进程？不能的话 clone 在这里注定全灭，先说清楚
  local fork; fork=$(git_fork_state)
  case "$fork" in
    blocked\|*)
      warn "${fork#*|}"
      warn "  clone 在本会话里跑不了（git 连 git-remote-https 都 fork 不出来）。"
      warn "  在普通终端执行即可："
      warn ""
      warn "    git clone git@github.com:$repo.git $dir"
      warn ""
      warn "  或者只读分析某个仓库的源码：github.sh api repos/$repo/contents/<path>"
      return 4 ;;
  esac

  # 1) SSH 优先：不经任何镜像/代理，也是本机 push 的唯一通道
  if [[ -f "$HOME/.ssh/id_ed25519_gh" ]]; then
    info "尝试: SSH ($ssh_url)"
    if git -c core.sshCommand="ssh -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"          clone "$ssh_url" "$dir" >/dev/null 2>&1; then
      ok "clone 成功: $dir（SSH）"; return 0
    fi
    rm -rf "$dir" 2>/dev/null
  fi

  # 2) 中转站：URL 不用改写，用 -c http.proxy 把 git 的 HTTPS 送进 8899
  if relay_up; then
    info "尝试: relay HTTPS ($RELAY)"
    local -a gp=(-c "http.proxy=$RELAY")
    [[ -f "$RELAY_CA" ]] && gp+=(-c "http.sslCAInfo=$RELAY_CA")
    if git "${gp[@]}" clone --depth 1 "$url" "$dir" >/dev/null 2>&1; then
      ok "clone 成功: $dir（relay）"; return 0
    fi
    rm -rf "$dir" 2>/dev/null
  fi

  # 3) 镜像前缀（schannel：本机 git 全局是 openssl + 8899 私有 CA，镜像域名不在那张证书里）
  local t m cand
  t=$(require_token)
  for m in "${MIRRORS[@]}"; do
    [[ -z "$m" ]] && continue
    cand="$m$url"
    info "尝试: $m"
    if git -c http.sslBackend=schannel -c "http.extraHeader=Authorization: Bearer $t"          clone --depth 1 "$cand" "$dir" >/dev/null 2>&1; then
      ok "clone 成功: $dir（$(prefix_name "$cand")）"
      git -C "$dir" remote set-url origin "$url"
      return 0
    fi
    rm -rf "$dir" 2>/dev/null
  done
  die "clone 全部通道失败" 2
}

# push 只能走 SSH：HTTPS 写操作本机三条路全死
# （直连被墙 / 8899 上游不支持写 / 镜像不转发写）。见 docs/network-baseline.md。
cmd_push() {
  local repo="${1:?需要 owner/repo}" ref="${2:-HEAD}" remote="${3:-origin}"
  [[ "$repo" == */* ]] || die "push: 需要 owner/repo"
  local fork; fork=$(git_fork_state)
  case "$fork" in
    blocked\|*)
      warn "当前会话的 git 起不了传输进程：${fork#*|}"
      warn ""
      warn "这不是仓库或网络的问题，是受限会话（沙箱）禁止 git fork 子进程。"
      warn "本地提交照常可用；推送要在一个普通终端里执行："
      warn ""
      warn "  git push git@github.com:$repo.git $ref"
      warn ""
      warn "要在这个会话里确认推送成功，用：github.sh api repos/$repo/commits/<sha> 对照。"
      return 4 ;;
  esac
  [[ -f "$HOME/.ssh/id_ed25519_gh" ]] || die "push: 缺 SSH 密钥 ~/.ssh/id_ed25519_gh（先跑 setup-gh.sh）" 1
  local ssh_url="git@github.com:$repo.git"
  info "push → $ssh_url ($ref @ $remote)"
  local t0 t1 rc out
  t0=$(date +%s)
  out=$(GIT_TERMINAL_PROMPT=0 git -c core.sshCommand="ssh -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new" push "$ssh_url" "$ref" 2>&1)
  rc=$?
  t1=$(date +%s)
  (( t1 > t0 )) && info "耗时 $((t1-t0))s"
  [[ $rc -eq 0 ]] && { ok "push 成功"; return 0; }
  # 即便检测漏掉了，也把 fork 拒绝翻译成人话
  case "$out" in
    *"cannot create standard input pipe"*|*"unable to fork"*)
      warn "git 无法 fork 传输进程（受限会话）。请在普通终端执行：git push git@github.com:$repo.git $ref"
      warn "$out"
      return 4 ;;
  esac
  printf '%s\n' "$out" | sed 's/^/  /' >&2
  die "push 失败 (git $rc)" 1
}

cmd_sshcheck() {
  [[ -f "$HOME/.ssh/id_ed25519_gh" ]] || { warn "没有 ~/.ssh/id_ed25519_gh"; return 1; }
  local out
  out=$(timeout 25 ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1)
  case "$out" in
    *"successfully authenticated"*) ok "$out"; return 0 ;;
    *) warn "SSH 认证失败: $out"; return 1 ;;
  esac
}

# raw 取文件正文。raw 域本机时通时不通，所以：
# 1) 走 API contents 端点（最稳，base64 回来自己解）；
# 2) 再试 node fetch 直取 raw 域；
# 3) 最后才试 curl 走镜像通道。
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
          } else { process.exit(1); }
        } catch (e) { process.exit(1); }
      });
    ' 2>/dev/null)
    if [[ -n "$b64" ]]; then printf "%s\n" "$b64"; return 0; fi
  fi

  # 2) node 直取 raw 域
  local rawurl="https://raw.githubusercontent.com/$repo/$ref/$path"
  if out=$(node_get "$rawurl" "$t" 2>/dev/null) && [[ -n "$out" ]] && ! grep -qi "<!DOCTYPE html" <<<"$out"; then
    printf "%s\n" "$out"; return 0
  fi

  # 3) curl 走镜像/中转通道
  local ck cu
  while IFS='|' read -r ck cu; do
    [[ -z "$ck" ]] && continue
    out=$(curl -sS $(opts_of "$ck") --max-time 25 -H "Authorization: token $t" -L "$cu" 2>/dev/null)
    if [[ -n "$out" ]] && ! grep -qi "<!DOCTYPE html" <<<"${out:0:200}"; then printf "%s\n" "$out"; return 0; fi
  done < <(candidates "$rawurl")
  die "raw 取不到: $repo/$ref/$path" 2
}

# 打印可直接 eval 的 export：让当前 shell 里任意工具（gh / git / npm / curl）透明走中转站
cmd_env() {
  relay_up || die "中转站没在跑（先 github.sh relay up）" 1
  echo "export HTTP_PROXY=$RELAY"
  echo "export HTTPS_PROXY=$RELAY"
  echo "export http_proxy=$RELAY"
  echo "export https_proxy=$RELAY"
  [[ -f "$RELAY_CA" ]] && echo "export NODE_EXTRA_CA_CERTS=$RELAY_CA"
  # github 家族故意不进 NO_PROXY：它们必须走中转站
  echo "export NO_PROXY=localhost,127.0.0.1,::1"
  echo "export no_proxy=localhost,127.0.0.1,::1"
  return 0
}

cmd_relay() {
  case "${1:-status}" in
    up)     relay_start ;;
    down)   relay_stop ;;
    status) if relay_up; then ok "中转站在线: $RELAY"; else warn "中转站未运行: $RELAY"; fi ;;
    *)      die "relay: 只支持 up|down|status" ;;
  esac
}

# status 的判读原则：每条通道都说清「这次探测走的是哪个传输器、结论是什么」。
# 不能把 curl 的失败报成「token 无效」——那是把传输器问题栽给凭据。
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
    cprobe=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 --noproxy "*" https://api.github.com/ 2>&1 || true)
    if [[ "$cprobe" == "200" ]]; then
      ok "curl 可用 ($cver)"
    else
      warn "curl 不可用：$cver"
      warn "  探测 api.github.com 得到: ${cprobe:0:160}"
      case "$cprobe" in
        *SEC_E_NO_CREDENTIALS*|*"curl: (35)"*)
          warn "  这是本机 curl 的 TLS 凭据句柄问题，不是网络也不是 token。api/status 会自动改用 gh 或 node。" ;;
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
    # 依次试 gh → node → curl，谁先成功用谁；失败时如实说是哪个传输器失败
    if g=$(gh_bin) && who=$(GH_TOKEN="$t" "$g" api user --jq .login 2>/dev/null) && [[ -n "$who" ]]; then
      how="gh api"
    elif raw=$(node_get "https://api.github.com/user" "$t" 2>/dev/null) && [[ -n "$raw" ]]; then
      who=$(printf "%s" "$raw" | grep -o "\"login\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | cut -d"\"" -f4)
      how="node fetch"
    elif raw=$(curl -sS $(opts_of rest) --max-time 15 -H "Authorization: token $t" -H "Accept: application/vnd.github+json" https://api.github.com/user 2>/dev/null) && [[ -n "$raw" ]]; then
      who=$(printf "%s" "$raw" | grep -o "\"login\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | cut -d"\"" -f4)
      how="curl"
    fi
    if [[ -n "$who" ]]; then ok "api.github.com 认证为: $who（经 $how）"
    else warn "三个传输器都没能认证 api.github.com —— 先看上面「传输器」一节，别急着换 token"; fi
  else
    warn "无 token"
  fi

  echo "── 中转站 ──" >&2
  if relay_up; then ok "在线 $RELAY（下载通道之一，也是 gh/git 的透明代理）"
  else warn "未运行（github.sh relay up 可拉起；不影响镜像通道）"; fi

  echo "── 通道可达性（用 node fetch 探测，绕开 curl 的 TLS 问题）──" >&2
  local code size tries i
  # 每条通道探测一个真实可取的 URL。codeload 的根路径会直接拒绝，必须打归档路径，
  # 否则会把「本来能用」的通道误判成不通（2026-11-06 实测：root 失败，tar.gz 200）。
  local -a probes=(
    "api.github.com|https://api.github.com/|API 挂了就没法干活；重试或换时段"
    "github.com|https://github.com/|443 被墙，属正常：下载走 relay/镜像，写操作走 SSH"
    "codeload.github.com|https://codeload.github.com/octocat/Hello-World/tar.gz/refs/heads/master|归档域；根路径 403 是它自己的策略，不代表不通"
    "raw.githubusercontent.com|https://raw.githubusercontent.com/dongopencv/tools/master/AGENTS.md|raw 域时通时不通（实测 8/8 失败、偶发成功）；要稳就改走 api.github.com/repos/<o>/<r>/contents/<path>"
    "gh-proxy.com|https://gh-proxy.com/|镜像"
    "ghfast.top|https://ghfast.top/|镜像"
    "ghproxy.net|https://ghproxy.net/|镜像"
    "release-assets.githubusercontent.com|https://release-assets.githubusercontent.com/|release 资产域（根路径 404 属正常）"
  )
  local item name purl hint
  for item in "${probes[@]}"; do
    IFS="|" read -r name purl hint <<< "$item"
    case "$name" in api.github.com) tries=3 ;; *) tries=1 ;; esac
    code=000
    for ((i=1; i<=tries; i++)); do
      read -r code size < <(node_probe "$purl")
      [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
      [[ "$code" != 000 ]] && break
      (( i < tries )) && sleep 1
    done
    case "$code" in
      200|206) ok "$name → $code（$size B）" ;;
      000)     warn "$name → 不通"
               [[ -n "$hint" ]] && warn "    $hint" ;;
      *)       ok "$name → $code（端口通，非 200 属正常）"
               if [[ "$code" == 403 && "$name" == codeload* ]] || [[ "$code" == 404 && "$name" == release-assets* ]]; then :
               else [[ -n "$hint" ]] && warn "    $hint"; fi ;;
    esac
  done

  echo "── SSH（push 通道） ──" >&2
  local sshok=0 hp
  for hp in "github.com 22" "ssh.github.com 443"; do
    set -- $hp
    if timeout 10 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then
      ok "$1:$2 → 通"; sshok=1
    else
      warn "$1:$2 → 不通"
    fi
  done
  if [[ $sshok -eq 1 ]]; then
    local out
    out=$(timeout 20 ssh -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 || true)
    case "$out" in
      *"successfully authenticated"*) ok "SSH 认证: $(printf "%s" "$out" | head -1)" ;;
      *) warn "SSH 端口通但认证未过（密钥未注册？跑 setup-gh.sh 的 stage 4）" ;;
    esac
  fi

  echo "── git 传输（本会话能不能 push/fetch） ──" >&2
  local fork; fork=$(git_fork_state)
  case "$fork" in
    ok\|*)      ok "git 可以起远端进程：${fork#*|}" ;;
    blocked\|*) warn "${fork#*|}"
                warn "  本会话只能本地提交；push/fetch/clone 要人在普通终端跑。" ;;
    *)          warn "${fork#*|}" ;;
  esac
}

# api：先 gh，再 curl，最后 node。三者的失败理由不一样，不能混为一谈。
# gh 自带 TLS 栈且处理分页/JSON；curl 在本机可能没有 TLS 凭据句柄；node 永远兜底。
cmd_api() {
  local method=GET path="" data=() jq=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -X|--method) method="$2"; shift 2 ;;
      -f|--field)  data+=(-d "$2"); shift 2 ;;
      -F|--raw)    data+=(--data-raw "$2"); shift 2 ;;
      --jq)        jq="$2"; shift 2 ;;
      -*)          die "api: 未知选项 $1" ;;
      *)           if [[ -z "$path" ]]; then path="$1"; else data+=(-d "$1"); fi; shift ;;
    esac
  done
  [[ -n "$path" ]] || die "api: 需要 API 路径，例如 repos/owner/repo"
  [[ "$path" == /* ]] || path="/$path"

  # 1) gh api —— 最稳，且能直接 --jq
  local g out rc i gerr
  if g=$(gh_bin); then
    local -a gargs=(api -X "$method")
    [[ -n "$jq" ]] && gargs+=(--jq "$jq")
    if [[ ${#data[@]} -gt 0 ]]; then
      local x
      for x in "${data[@]}"; do [[ "$x" != -d ]] && gargs+=(-f "$x"); done
    fi
    gargs+=("${path#/}")
    gerr=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gherr.$$")
    if out=$("$g" "${gargs[@]}" 2>"$gerr"); then
      rm -f "$gerr" 2>/dev/null
      echo "$out"; return 0
    fi
    # gh 报 HTTP 错误说明传输本身是通的，API 明确拒绝了这个路径——照实说，别再换传输器
    if grep -qi "HTTP [45][0-9][0-9]" "$gerr" 2>/dev/null; then
      rm -f "$gerr" 2>/dev/null
      die "api: GitHub 返回错误 → $method $path" 3
    fi
    rm -f "$gerr" 2>/dev/null
  fi

  local t; t=$(gh_token 2>/dev/null || true)
  [[ -n "$t" ]] || die "api: 没有 token，且 gh 调用失败" 2

  # 2) curl
  for ((i=1; i<=2; i++)); do
    out=$(curl -sS $(opts_of rest) --max-time 30 -X "$method" -H "Authorization: token $t" \
      -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
      "${data[@]}" "https://api.github.com$path" 2>/dev/null)
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

  # 3) node fetch（GET 兜底；有 body 的写请求不走这条）
  if [[ "$method" == GET ]]; then
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
  relay)    shift; cmd_relay "$@" ;;
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
