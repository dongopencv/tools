#!/usr/bin/env bash
# 把仓库里的中转站（tools/relay/server.mjs）部署到运行目录并重启。
#
# 为什么要这个脚本：运行目录 C:/Users/Admin/dsh-mirror-proxy 是**部署副本**，
# 不是 git 仓库；以前直接手改，改了什么没人知道、坏了没法回退。
# 现在唯一真身是仓库里的 tools/relay/server.mjs，这个脚本负责拷过去 + 重启 + 自检。
#
# 用法：
#   bash tools/relay/deploy.sh            # 部署并重启，然后自检
#   bash tools/relay/deploy.sh --dry-run  # 只看会做什么
#
# 环境变量：
#   RELAY_DEPLOY_DIR  部署目录（默认 /c/Users/Admin/dsh-mirror-proxy）
#   RELAY_PORT        端口（默认 8899）
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SRC_DIR/server.mjs"
DEST_DIR="${RELAY_DEPLOY_DIR:-/c/Users/Admin/dsh-mirror-proxy}"
DEST="$DEST_DIR/server.mjs"
PORT="${RELAY_PORT:-8899}"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

die()  { echo "[fail] $*" >&2; exit 1; }
info() { echo "[..] $*"; }
ok()   { echo "[ok] $*"; }

[[ -f "$SRC" ]] || die "找不到源文件: $SRC"
command -v node >/dev/null 2>&1 || die "没有 node"
node --check "$SRC" || die "server.mjs 语法检查失败"

info "源: $SRC ($(wc -c < "$SRC" | tr -d ' ') B)"
info "目标: $DEST"

if (( DRY )); then
  echo "--- 会做的事 ---"
  echo "1. 备份现有 $DEST → $DEST.bak-$(date +%Y%m%d-%H%M%S)"
  echo "2. 拷贝 $SRC → $DEST"
  echo "3. 杀掉监听 $PORT 的进程"
  echo "4. 在 $DEST_DIR 后台起 node server.mjs"
  echo "5. 自检 http://127.0.0.1:$PORT/__relay/status"
  exit 0
fi

# 1) 备份（保留最近 5 份）
if [[ -f "$DEST" ]]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  cp "$DEST" "$DEST.bak-$STAMP" || die "备份失败"
  ok "已备份 $DEST.bak-$STAMP"
  ls -1t "$DEST".bak-* 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old"; done
fi

# 2) 拷贝
cp "$SRC" "$DEST" || die "拷贝失败"
ok "已写入 $DEST ($(wc -c < "$DEST" | tr -d ' ') B)"

# 3) 停旧进程
#
# 坑（2026-11-08 实测）：线上实例是计划任务 \dsh-gh-proxy 拉起的，
# taskkill /PID <pid> /F 会报「拒绝访问」，即使进程属主就是当前用户。
# 正确姿势是 schtasks /end 让任务自己收掉它。所以先问任务，再退回 taskkill。
port_pid() {
  netstat -ano 2>/dev/null | grep LISTENING | grep -E "[:.]$PORT[[:space:]]" | awk '{print $NF}' | head -1
}
port_busy() { [[ -n "$(port_pid)" ]]; }

wait_port_free() {
  local i
  for i in $(seq 1 20); do port_busy || return 0; sleep 0.25; done
  return 1
}

TASK_NAME="${RELAY_TASK_NAME:-dsh-gh-proxy}"
# git-bash（MSYS）会把 /query、/tn 当成路径改写掉（→ C:/Program Files/Git/query），
# 于是 schtasks 静默失败、脚本误判「没有计划任务」。必须关掉路径转换。
task_exists() { MSYS_NO_PATHCONV=1 schtasks /query /tn "$TASK_NAME" >/dev/null 2>&1; }
task_run()    { MSYS_NO_PATHCONV=1 schtasks /run   /tn "$TASK_NAME" >/dev/null 2>&1; }
task_end()    { MSYS_NO_PATHCONV=1 schtasks /end   /tn "$TASK_NAME" >/dev/null 2>&1; }
PID=$(port_pid)
if [[ -n "$PID" ]]; then
  if task_exists; then
    info "端口 $PORT 被 pid $PID 占着，且它属于计划任务 $TASK_NAME → schtasks /end"
    task_end
    if wait_port_free; then ok "已通过 $TASK_NAME 停止旧实例"
    else taskkill //PID "$PID" //F >/dev/null 2>&1 && wait_port_free && ok "已 taskkill 旧实例 (pid $PID)" \
         || die "停不掉旧实例 (pid $PID)：任务与 taskkill 都没成功"; fi
  else
    taskkill //PID "$PID" //F >/dev/null 2>&1 && wait_port_free && ok "已停止旧实例 (pid $PID)" \
      || die "停止旧实例失败 (pid $PID)"
  fi
else
  info "端口 $PORT 上没有在跑的实例"
fi

# 4) 起新实例
#
# 优先让计划任务来拉：这样进程归 \dsh-gh-proxy 管，开机自启、也没有
# 「本次 shell 一退进程就没了」的隐患。没有任务时退回 nohup。
cd "$DEST_DIR" || die "进不去 $DEST_DIR"
mkdir -p logs
if task_exists; then
  task_run
  ok "已通过计划任务 $TASK_NAME 启动"
else
  nohup node "$DEST" >> "$DEST_DIR/logs/service.out.log" 2>&1 &
  ok "已启动 (pid $!)（无计划任务，nohup 起）"
fi

# 5) 自检
UP=0
for i in $(seq 1 40); do
  if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then UP=1; break; fi
  sleep 0.25
done
(( UP )) || die "端口 $PORT 没起来，看 $DEST_DIR/logs/service.out.log"

echo "--- /__relay/status ---"
curl -s --max-time 10 "http://127.0.0.1:$PORT/__relay/status" || die "status 端点无响应（可能还是旧版）"
echo
ok "部署完成：$PORT 已在跑新版（多上游回退 + /__relay/status）"
