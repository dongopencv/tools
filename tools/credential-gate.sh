#!/usr/bin/env bash
# credential-gate.sh —— 提交与发文前的闸门（脚本，不是规则）
#
# 为什么是脚本：写在 AGENTS.md 里的「提交前自查」没人执行，而且旧版词表
# （grep -iE 'ghp_|pin|password|token'）会命中 55 行正常散文，等于永远失败。
# 闸门只有装在机器上、每次自动跑，才算闸门。
#
# 用法：
#   bash tools/credential-gate.sh --staged        扫暂存区（pre-commit 钩子用）
#   bash tools/credential-gate.sh --tree          扫所有被跟踪文件
#   bash tools/credential-gate.sh --text FILE...  扫任意文本（发 issue 评论前用）
#   bash tools/credential-gate.sh --stdin         扫标准输入
#   bash tools/credential-gate.sh --install       装 pre-commit / commit-msg 钩子
#   bash tools/credential-gate.sh --selftest      自测：真实值必须命中，散文必须不命中
#
# 退出码：0 干净；1 命中；2 用法错误。
set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")

# ---- 只匹配真实值的形状，不匹配散文词 ----
SHAPE_GITHUB='gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}'
SHAPE_KEY='-----BEGIN [A-Z ]*PRIVATE KEY-----'
SHAPE_ASSIGN='(password|passwd|passphrase|secret|token|api[_-]?key|pin)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+=~-]{8,}'
BLOCKLIST="${CREDENTIAL_GATE_BLOCKLIST:-$HOME/.skills-vault/download/scripts/credential-rotation.blocklist}"

MODE=""; ARGS=()
for a in "$@"; do
  case "$a" in
    --staged|--tree|--text|--stdin|--install|--selftest) MODE="$a" ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done

red()  { printf '%s\n' "$*" >&2; }
grn()  { printf '%s\n' "$*" >&2; }

mask() {
  local s="$1"
  if [ ${#s} -gt 10 ]; then printf '%s...(%d chars)' "$(printf '%s' "$s" | cut -c1-6)" ${#s}; else printf '***'; fi
}

scan_stream() {
  local label="$1" hits=0 line val pat ln tmp out
  tmp=$(mktemp)
  cat > "$tmp"
  # 三道正则整段一次跑完。旧实现是「每行 for 三个正则 + 命令替换 + head 收尾」，
  # 一行要 fork 4 个进程；暂存区 4500 行 ≈ 18000 次 spawn，实测 17 s/200 行，
  # 也就是一次 pre-commit 要十几分钟 —— 2026-11-08 11:26 两个并行会话的 git commit
  # 就是这样被钩子堵死、并留下 index.lock。
  # 现在按行号去重，语义不变：同一行只报一次。
  out=$(
    for pat in "$SHAPE_KEY" "$SHAPE_GITHUB" "$SHAPE_ASSIGN"; do
      grep -noiE "$pat" "$tmp" 2>/dev/null || true
    done | awk -F: '!seen[$1]++'
  )
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ln=${line%%:*}; val=${line#*:}
    case "$val" in *'<token>'*|*xxx*|*XXX*|*example*|*REDACTED*|*'***'*) continue ;; esac
    local src
    src=$(sed -n "${ln}p" "$tmp")
    case "$src" in *credential-gate.sh*) continue ;; esac
    # 形如 `<base64(x-access-token:TOKEN)>` 的占位符不是真实值：真值不带尖括号。
    case "$src" in *'<'*'>'*) continue ;; esac
    red "  [命中] $label:$ln  $(mask "$val")"
    hits=$((hits + 1))
  done <<< "$out"
  if [ -f "$BLOCKLIST" ]; then
    while IFS= read -r val; do
      [ -z "$val" ] && continue
      case "$val" in \#*) continue ;; esac
      grep -qF "$val" "$tmp" 2>/dev/null || continue
      red "  [命中·黑名单] $label  $(mask "$val")"
      hits=$((hits + 1))
    done < "$BLOCKLIST"
  fi
  rm -f "$tmp"
  return $hits
}

do_staged() {
  local tmp rc=0 f
  tmp=$(mktemp)
  # 只看「新增的行」：删掉一行旧值是在做清理，不该被闸门拦住。
  git -C "$REPO_ROOT" diff --cached -U0 2>/dev/null | grep '^+' | grep -v '^+++' > "$tmp" || true
  scan_stream staged < "$tmp" || rc=$?
  rm -f "$tmp"
  while IFS= read -r f; do
    [ -f "$REPO_ROOT/$f" ] || continue
    scan_stream "$f" < "$REPO_ROOT/$f" || rc=$?
  done < <(git -C "$REPO_ROOT" diff --cached --name-only --diff-filter=A 2>/dev/null)
  return $rc
}

do_tree() {
  local rc=0 f
  while IFS= read -r f; do
    [ -f "$REPO_ROOT/$f" ] || continue
    scan_stream "$f" < "$REPO_ROOT/$f" || rc=$?
  done < <(git -C "$REPO_ROOT" ls-files 2>/dev/null)
  return $rc
}

do_text() {
  local rc=0 f
  for f in "${ARGS[@]:-}"; do
    [ -z "$f" ] && continue
    if [ ! -f "$f" ]; then red "  [跳过] 没有这个文件：$f"; rc=2; continue; fi
    scan_stream "$f" < "$f" || rc=$?
  done
  return $rc
}

do_stdin() { scan_stream stdin; }

do_install() {
  local hookdir
  hookdir=$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null) || { red "不在 git 仓库里"; exit 2; }
  case "$hookdir" in /*|[A-Za-z]:*) ;; *) hookdir="$REPO_ROOT/$hookdir" ;; esac
  mkdir -p "$hookdir"
  cat > "$hookdir/pre-commit" <<'HOOK_PRE'
#!/usr/bin/env bash
# 由 tools/credential-gate.sh --install 生成：暂存区出现真实值形状就拒绝提交
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/tools/credential-gate.sh" ] || exit 0
bash "$root/tools/credential-gate.sh" --staged || {
  echo "" >&2
  echo "提交被闸门拦下。值要放环境变量或本机文件，不要写进被跟踪的文件。" >&2
  echo "确属误报：git commit --no-verify，并在提交说明里写明原因。" >&2
  exit 1
}
HOOK_PRE
  cat > "$hookdir/commit-msg" <<'HOOK_MSG'
#!/usr/bin/env bash
# 由 tools/credential-gate.sh --install 生成：commit message 里也不许出现真实值
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/tools/credential-gate.sh" ] || exit 0
bash "$root/tools/credential-gate.sh" --text "$1" >/dev/null 2>&1 || {
  echo "commit message 里有真值的形状，拒绝提交。" >&2
  exit 1
}
HOOK_MSG
  chmod +x "$hookdir/pre-commit" "$hookdir/commit-msg"
  grn "[ok] 已装钩子：$hookdir/pre-commit、$hookdir/commit-msg"
  grn "     注意：钩子只管 git 提交。发 issue / 评论不走 git，那条由 tools/issue-closeout.sh 发送前调本脚本 --text 把关。"
}

do_selftest() {
  local ok=0 bad
  bad=$(printf 'x = ghp_%s' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
  # 注意：scan_stream 的退出码就是命中数，0 = 干净
  if printf '%s\n' "$bad" | scan_stream selftest >/dev/null 2>&1; then
    red "  [失败] 真值形状没命中（闸门漏了）"; ok=1
  fi
  # 真实赋值必须命中（单靠 SHAPE_GITHUB 不够，密码类得靠 SHAPE_ASSIGN）
  # 测试向量用 printf 在运行时拼出，免得本文件里躺着一行「长得像真值的赋值」被自己拦住
  for bad2 in "password = \"$(printf 'hunter2x%s' yz123)\"" \
               "$(printf 'api_key%s sk_live_%s' ':' 9f8e7d6c5b4a)" \
               "token: ghp9_$(printf '%s' AbCdEfGhIjKlMnOpQrStUvWxYz012345)"; do
    if printf '%s\n' "$bad2" | scan_stream selftest >/dev/null 2>&1; then
      red "  [失败] 真值形状没命中：$bad2"; ok=1
    fi
  done
  # 散文必须不命中——旧版用词表，把"password 策略待定"也算命中
  for prose in 'token 文件放在 vault 里，PIN 码要改，password 策略待定。' \
               '同目录 '\`github.env'\`' 存 '\`GITHUB_TOKEN='\`'，三处同一个值。' \
               'curl "http://127.0.0.1:8080/?token=<占位>" 返回 unauthorized。'; do
    if ! printf '%s\n' "$prose" | scan_stream selftest >/dev/null 2>&1; then
      red "  [失败] 正常散文被判命中：$prose"; ok=1
    fi
  done
  if [ $ok -ne 0 ]; then red "[selftest] 失败"; return 1; fi
  grn "[selftest] 通过：真值命中、散文不命中"
  return 0
}

case "$MODE" in
  --staged)   do_staged ;;
  --tree)     do_tree ;;
  --text)     do_text ;;
  --stdin)    do_stdin ;;
  --install)  do_install; exit 0 ;;
  --selftest) do_selftest; exit $? ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
rc=$?
if [ $rc -eq 0 ]; then
  grn "[ok] 闸门：干净"
else
  red ""
  red "[fail] 闸门命中 $rc 处，已阻止。"
  red "  处置：把值挪到本机文件或环境变量，正文只引用路径。"
  exit 1
fi
