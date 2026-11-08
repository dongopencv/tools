#!/usr/bin/env bash
# attention.sh — 把整个票库收敛成「今天该管哪几件」
#
# 票越开越多，大部分被别的票阻塞住，人不知道从哪下手，于是干脆不看。
# 这个脚本只回答四件事：
#   1. 哪几件在等我拍板（我不动就永远停着）
#   2. 哪几件 agent 现在就能接（open + 未阻塞 + 无人认领 = wayfinder 的 frontier）
#   3. 哪几条线已经睡着（>=N 天零动静），该降级或关掉，别再假装还在跟
#   4. 阻塞链：能动的那一环还挡着谁
#
# 只读：不发任何写请求，不改票、不加标签、不 assign。判断权仍然在人。
#
# 用法：
#   bash tools/attention.sh              # 默认全部，沉睡阈值 3 天
#   bash tools/attention.sh --days 7     # 沉睡阈值 7 天
#   bash tools/attention.sh --repo o/r   # 换仓库（默认 dongopencv/tools）
#   bash tools/attention.sh --blocks     # 额外打印阻塞链的下一动作
#
# 退出码：0 正常 / 1 参数错误 / 2 gh 取数失败
set -uo pipefail

REPO="${GH_REPO:-dongopencv/tools}"
STALE_DAYS=3
SHOW_BLOCKS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)   STALE_DAYS="${2:?}"; shift 2 ;;
    --repo)   REPO="${2:?}"; shift 2 ;;
    -R)       REPO="${2:?}"; shift 2 ;;
    --blocks) SHOW_BLOCKS=1; shift ;;
    -h|--help) sed -n "2,20p" "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

command -v gh >/dev/null || { echo "缺少 gh" >&2; exit 2; }

# 一次取全量：blockedBy / parent 由 gh 直接聚合，不逐票 round-trip。
# 字段分隔符用 "|" 而不是 TAB：IFS 里的 TAB 属于「空白类」，连续两个会塌成一个，
# 空字段（未认领、无标签、无父票）会整体左移——2026-11-08 实测踩过这个坑。
RAW="$(gh issue list -R "$REPO" --state open --limit 300 \
  --json number,title,labels,assignees,createdAt,updatedAt,blockedBy,parent \
  --jq '.[] | [
    (.number|tostring),
    ((.parent.number // "-")|tostring),
    ([.blockedBy.nodes[]|select(.state=="OPEN")|.number]|join(",")),
    ([.assignees[].login]|join(",")),
    ([.labels[].name]|join(",")),
    .createdAt[0:10],
    .updatedAt[0:10],
    (.title|gsub("\\|";"/"))
  ] | join("|")')" || { echo "gh 取数失败：确认 gh 可用、仓库名正确（见 AGENTS.md「能力边界」）" >&2; exit 2; }

[[ -z "$RAW" ]] && { echo "票库是空的。"; exit 0; }

now=$(date +%s)
# 注意 $1 是 YYYY-MM-DD，$(date -d ... +%s) 在 Git Bash 下可用；失败时回退 0
age_of() { local t; t=$(date -d "$1" +%s 2>/dev/null || echo 0); [[ "$t" == "0" ]] && { echo 0; return; }; echo $(( (now - t) / 86400 )); }

DECIDE=(); FRONT=(); BLOCKED=(); MAPS=(); STALE=()
declare -A TITLE
declare -A KIDS

while IFS="|" read -r num pnum blocked assignees labels cdate udate title; do
  [[ -z "$num" ]] && continue
  TITLE[$num]="$title"
  if [[ "$pnum" != "-" && -n "$pnum" ]]; then KIDS[$pnum]=$(( ${KIDS[$pnum]:-0} + 1 )); fi
done <<< "$RAW"

while IFS="|" read -r num pnum blocked assignees labels cdate udate title; do
  [[ -z "$num" ]] && continue
  ud=$(age_of "$udate")
  cd_=$(age_of "$cdate")
  if [[ "$labels" == *wayfinder:map* ]]; then
    MAPS+=("$num|$ud|$cd_|$title")
    [[ $ud -ge $STALE_DAYS ]] && STALE+=("map|$num|$ud|$title")
    continue
  fi
  if [[ -n "$blocked" ]]; then
    BLOCKED+=("$num|$blocked|$ud|$title")
    [[ $ud -ge $STALE_DAYS ]] && STALE+=("blocked|$num|$ud|$title")
    continue
  fi
  if [[ -n "$assignees" ]]; then
    : # 有人认领 = 在飞，不占注意力（这正是 superagent 那条纪律）
  elif [[ "$labels" == *wayfinder:grilling* || "$labels" == *needs-triage* || "$labels" == *ready-for-human* ]]; then
    # ready-for-human：范围决策/人眼确认这类 agent 做不了的事，不该混进「可接」里组队
    DECIDE+=("$num|$ud|$title")
    [[ $ud -ge $STALE_DAYS ]] && STALE+=("decide|$num|$ud|$title")
  else
    FRONT+=("$num|$pnum|$ud|$title")
    [[ $ud -ge $STALE_DAYS ]] && STALE+=("front|$num|$ud|$title")
  fi
done <<< "$RAW"

echo
echo "PC1 注意力视图  ·  $REPO  ·  $(date '+%Y-%m-%d %H:%M')  ·  沉睡阈值 ${STALE_DAYS}d"
echo

echo "== 1. 等我拍板（我不决定，它就永远停着）=============================="
if [[ ${#DECIDE[@]} -eq 0 ]]; then echo "  (空)"; else
  for r in "${DECIDE[@]}"; do IFS="|" read -r n ud t <<< "$r"
    printf "  #%-4s 停 %-3sd  %s\n" "$n" "$ud" "${t:0:52}"; done
fi
echo

echo "== 2. agent 可接（open + 未阻塞 + 无人认领 = frontier）================"
if [[ ${#FRONT[@]} -eq 0 ]]; then echo "  (空)"; else
  for r in "${FRONT[@]}"; do IFS="|" read -r n p ud t <<< "$r"
    printf "  #%-4s 停 %-3sd  [地图 #%s]  %s\n" "$n" "$ud" "$p" "${t:0:44}"; done
fi
echo

echo "== 3. 被阻塞（想解右边这张，得先动左边那几张）========================"
if [[ ${#BLOCKED[@]} -eq 0 ]]; then echo "  (空)"; else
  for r in "${BLOCKED[@]}"; do IFS="|" read -r n b ud t <<< "$r"
    printf "  #%-4s 等 <- %-14s 停 %-3sd  %s\n" "$n" "$b" "$ud" "${t:0:36}"; done
fi
echo

echo "== 4. 地图进度 ======================================================"
if [[ ${#MAPS[@]} -eq 0 ]]; then echo "  (空)"; else
  for r in "${MAPS[@]}"; do IFS="|" read -r n ud cd_ t <<< "$r"
    printf "  #%-4s 子票 %-2s 张  开图 %-3sd  %s\n" "$n" "${KIDS[$n]:-0}" "$cd_" "${t:0:42}"; done
fi
echo

echo "== 5. 沉睡 >=${STALE_DAYS}d（建议：降级、合并或直接关掉）======================"
if [[ ${#STALE[@]} -eq 0 ]]; then echo "  (空)"; else
  for r in "${STALE[@]}"; do IFS="|" read -r k n ud t <<< "$r"
    printf "  #%-4s [%-7s] 停 %-3sd  %s\n" "$n" "$k" "$ud" "${t:0:44}"; done
fi
echo

if [[ $SHOW_BLOCKS -eq 1 && ${#BLOCKED[@]} -gt 0 ]]; then
  echo "== 6. 阻塞链的下一动作（左边这一张还挡着谁）=========================="
  for r in "${BLOCKED[@]}"; do IFS="|" read -r n b ud t <<< "$r"
    IFS="," read -ra arr <<< "$b"
    for bn in "${arr[@]}"; do
      [[ -z "${TITLE[$bn]:-}" ]] && continue
      printf "  #%-4s -> #%-4s %s\n" "$bn" "$n" "${TITLE[$bn]:0:48}"
    done
  done
  echo
fi

total=$(printf "%s" "$RAW" | grep -c "" )
echo "-- 合计 open $total 张：等我 ${#DECIDE[@]} · 可接 ${#FRONT[@]} · 被阻塞 ${#BLOCKED[@]} · 地图 ${#MAPS[@]} · 沉睡 ${#STALE[@]}"
echo "-- 下一步只做一件事：从「等我拍板」挑一件，或从「可接」认领一件（认领 = assign 给自己）"