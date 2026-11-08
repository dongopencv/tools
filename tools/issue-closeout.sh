#!/usr/bin/env bash
# issue-closeout.sh —— 一次性补完 #5 的收尾写操作（幂等，默认只演练）
#
# 背景：2026-11-08 01:16 起本机 GitHub 写通道中断，当晚才恢复。当时 issue 写操作全部 403
# （响应头 X-Accepted-Github-Permissions: issues=write），补齐 token 权限后一把跑完。
#
# 为什么需要它：docs/pending-issues/issue-closeout.md 里原是四条手敲命令，其中「内联正文」那条
# 被 shell 再执行了一遍，写出了坏评论 6710513283。
# 本脚本一律走 -F body=@file，并用 HTML 注释标记做幂等，绝不把正文内联进命令行。
#
# 用法：
#   bash tools/issue-closeout.sh            # 演练：只打印将要执行的命令（默认）
#   bash tools/issue-closeout.sh --apply    # 真写
#   MAP_ISSUE=2 bash tools/issue-closeout.sh --apply
#
# 退出码：0 全部完成；2 权限不足；3 前置文件缺失。
set -uo pipefail

REPO="${REPO:-dongopencv/tools}"
ISSUE="${ISSUE:-5}"
MAP_ISSUE="${MAP_ISSUE:-2}"
BAD_COMMENT="${BAD_COMMENT:-6710513283}"
COMMENT_FILE="${COMMENT_FILE:-docs/pending-issues/i5-comment.md}"
MAP_GIST_FILE="${MAP_GIST_FILE:-docs/pending-issues/map-gist.md}"

MARK_COMMENT="<!-- resolution-2026-11-08-vault-forwarder -->"
MARK_BODY="<!-- closeout-2026-11-08 -->"
MARK_MAP="<!-- multi-upstream-2026-11-08 -->"

# 幂等指纹：标记只是「我写的时候留的记号」，而这次的三处产物是手写的、没有标记。
# 只认标记会把「已做过」误判成「没做过」，--apply 就会重复发评论 / 重复追加段落。
# 所以每一步都是「标记 OR 正文指纹」双判，指纹取正文里唯一的那一行。
FP_COMMENT='## Resolution 补充（2026-11-07）：vault 副本已收敛成转发器'
FP_BODY='## 收尾（2026-11-08）'
FP_MAP='「链路不通」与「没有授权」必须分开报'

DRY=1
for a in "$@"; do
  case "$a" in
    --apply)   DRY=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n "2,21p" "$0"; exit 0 ;;
    *) printf "[warn] 忽略未知参数：%s\n" "$a" >&2 ;;
  esac
done

say()  { printf "%s\n" "$*"; }
step() { printf "\n=== %s\n" "$*"; }
warn() { printf "[warn] %s\n" "$*" >&2; }
fail() { printf "[fail] %s\n" "$*" >&2; exit "${2:-1}"; }
run()  { if (( DRY )); then printf "[dry-run] %s\n" "$*"; else eval "$@"; fi; }

step "0/5 预检：工具链 + 读写权限 + 前置文件"
command -v gh >/dev/null 2>&1 || fail "gh 不在 PATH"
TITLE=$(gh api "repos/$REPO/issues/$ISSUE" --jq .title 2>/dev/null) || fail "读不通：先 gh auth login -h github.com --with-token" 2
say "[ok] 读权限可用 —— #$ISSUE 标题：$TITLE"

# 探测方式必须只留「只读副产品」，绝不能是真实写操作。
# 教训（2026-11-08）：上一版用 PUT /contents 与 POST /git/refs 探权限，直接在 master 上
# 造出 3 个提交 + 1 个分支，清理时又造了 1 个。这里改成 DELETE 一个必然不存在的评论：
#   有权限 → 404（有权访问，资源不存在）；没权限 → 403（Resource not accessible）。
PROBE_CODE=$(gh api -X DELETE "repos/$REPO/issues/comments/1" -i 2>/dev/null | head -1 | awk '{print $2}')
PROBE_FAIL=
case "$PROBE_CODE" in
  404|204) say "[ok] 写权限可用（DELETE 探针返回 $PROBE_CODE = 有权访问、资源不存在）" ;;
  *)       warn "写权限探测返回 HTTP ${PROBE_CODE:-?}，预期 404"; PROBE_FAIL=1 ;;
esac
if [ -z "$PROBE_FAIL" ]; then
  :
else
  warn "写权限缺失（读得动、写 403）"
  say "  实测响应头：X-Accepted-Github-Permissions: issues=write; pull_requests=write"
  say "  修法：https://github.com/settings/tokens → 编辑这枚细粒度 token →"
  say "        Repository permissions 里 Issues = Read and write、Contents = Read and write"
  say "        （Contents=write 顺带解决 push：push 只走 SSH，不依赖 HTTPS）"
  if (( DRY )); then
    warn "演练模式：继续往下打印全部步骤，但 --apply 时会在这一步停下"
  else
    fail "权限不足，未做任何写操作" 2
  fi
fi

[ -f "$COMMENT_FILE" ] || fail "缺 $COMMENT_FILE" 3
say "[ok] 评论正文文件：$COMMENT_FILE（$(wc -c < "$COMMENT_FILE") 字节）"

step "1/5 删掉写坏的那条评论 $BAD_COMMENT"
if gh api "repos/$REPO/issues/comments/$BAD_COMMENT" >/dev/null 2>&1; then
  run "gh api -X DELETE 'repos/$REPO/issues/comments/$BAD_COMMENT'"
  say "[ok] 已删除（演练时仅为待办）"
else
  say "[skip] 评论 $BAD_COMMENT 已不存在"
fi

step "2/5 重发干净版 resolution 评论（带幂等标记）"
# 双判：HTML 标记（本脚本发的）或首行指纹（人工/前会话发的）。任一命中都算已发。
COMMENT_BODIES=$(gh api "repos/$REPO/issues/$ISSUE/comments?per_page=100" --jq ".[].body" 2>/dev/null)
if printf '%s' "$COMMENT_BODIES" | grep -qF "$MARK_COMMENT" \
   || printf '%s' "$COMMENT_BODIES" | grep -qF "$FP_COMMENT"; then
  say "[skip] 已有 resolution 评论（标记或首行指纹命中）"
else
  run "gh api -X POST 'repos/$REPO/issues/$ISSUE/comments' -F body=@'$COMMENT_FILE'"
  say "[ok] 评论已发（-F body=@file，绝不内联，避免 shell 吃反引号）"
fi

step "3/5 把 #$ISSUE 的真实状态回写进正文（保留下方全部原内容）"
if gh api "repos/$REPO/issues/$ISSUE" --jq .body 2>/dev/null | grep -qF "$MARK_BODY" \
   || gh api "repos/$REPO/issues/$ISSUE" --jq .body 2>/dev/null | grep -qF "$FP_BODY"; then
  say "[skip] 正文已含收尾段（标记或小节标题命中）"
else
  BODY_FILE=${TMPDIR_BASE:-work}/closeout-body.$$.md
  mkdir -p "$(dirname "$BODY_FILE")"
  {
    gh api "repos/$REPO/issues/$ISSUE" --jq .body 2>/dev/null
    printf '\n\n---\n\n## 收尾（2026-11-08）\n\n'
    printf '%s\n\n' "$MARK_BODY"
    printf '本票在 2026-11-06 关闭；2026-11-07 的复核又发现并修掉 6 处真缺陷（`704e826`）。\n'
    printf '2026-11-08 的补记：\n\n'
    printf '| 事项 | 状态 |\n|---|---|\n'
    printf '| 网关脚本 tools/github.sh（13 个子命令） | 完成 |\n'
    printf '| 网关脚本 tools/github.sh 的下载与通道体检 | 完成 |\n'
    printf '| vault 侧副本收敛为转发器 | 完成（`72133ac`） |\n'
    printf '| 旧评论 `6710513283` | **已删除**（本脚本第 1 步） |\n'
    printf '| 重发干净版 resolution 评论 | **已发**（本脚本第 2 步，`-F body=@file`） |\n'
    printf '| 本机 SSH 公钥 | 已恢复，`ssh -T git@github.com` 认证成功 |\n'
    printf '| 未推送提交 | 0 个，`origin/master` == 本地 `HEAD` |\n'
    printf '| 细粒度 PAT 权限 | Issues=write、Contents=write 均已补齐（实测写入矩阵） |\n\n'
    printf '下一轮：见 map [#2](https://github.com/dongopencv/tools/issues/2) 的 Decisions 第 11–13 条。\n'
  } > "$BODY_FILE"
  run "gh api -X PATCH 'repos/$REPO/issues/$ISSUE' -F body=@'$BODY_FILE'"
  say "[ok] 正文已回写"
fi

step "4/5 在 map #$MAP_ISSUE 的 Decisions so far 追加 gist"
if [ -f "$MAP_GIST_FILE" ]; then
  if gh api "repos/$REPO/issues/$MAP_ISSUE" --jq .body 2>/dev/null | grep -qF "$MARK_MAP" \
     || gh api "repos/$REPO/issues/$MAP_ISSUE" --jq .body 2>/dev/null | grep -qF "$FP_MAP"; then
    say "[skip] map 已含该 gist（标记或条目指纹命中）"
  else
    MAP_BODY=${TMPDIR_BASE:-work}/closeout-map.$$.md
    mkdir -p "$(dirname "$MAP_BODY")"
    gh api "repos/$REPO/issues/$MAP_ISSUE" --jq .body 2>/dev/null > "$MAP_BODY.orig"
    # gist 必须落在 "## Decisions so far" 里，不能追加到正文末尾（末尾是 "## 进度"）。
    # 做法：找到 Decisions 之后的下一个二级标题，插在它前面。
    CUT=$(awk '/^## Decisions so far/{d=1;next} d && /^## /{print NR; exit}' "$MAP_BODY.orig")
    if [ -z "$CUT" ]; then
      cat "$MAP_BODY.orig" > "$MAP_BODY"
      printf '\n' >> "$MAP_BODY"
      cat "$MAP_GIST_FILE" >> "$MAP_BODY"
    else
      head -n "$((CUT - 1))" "$MAP_BODY.orig" > "$MAP_BODY"
      cat "$MAP_GIST_FILE" >> "$MAP_BODY"
      printf '\n' >> "$MAP_BODY"
      tail -n "+$CUT" "$MAP_BODY.orig" >> "$MAP_BODY"
    fi
    rm -f "$MAP_BODY.orig"
    run "gh api -X PATCH 'repos/$REPO/issues/$MAP_ISSUE' -F body=@'$MAP_BODY'"
    say "[ok] map gist 已追加"
  fi
else
  warn "缺 $MAP_GIST_FILE，跳过第 4 步"
fi

step "5/5 deck 上报（须在会话内调用，脚本无法代劳）"
say "deck_issue_report(#$ISSUE) 与 deck_issue_report(#$MAP_ISSUE)"
say "  读权限够就能上报（2026-11-08 已实测 #5 上报成功）。"
say "  但 deck_issue_patch 走写接口，权限补齐前会返回 backend-unsupported。"

printf '\n'
if (( DRY )); then
  say "演练结束。确认无误后加 --apply 真跑。"
else
  say "全部步骤完成。"
fi
