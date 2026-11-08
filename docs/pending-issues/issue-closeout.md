# 收尾写操作

2026-11-08 01:16 票库写操作一度中断，当晚已恢复（`gh api user` → dongopencv，仓库权限 admin/push）。
当前唯一残留：任务用的 PAT 是细粒度令牌，没有 `Issues` 写权限，所以 comment / 正文 PATCH 仍返回 403。

## 待办（按顺序做）

### 1. 删掉那条写坏的评论

评论 id `6710513283`（#5 第 6 条，2026-11-07T17:14:15Z）。当时用 shell 内联正文，
反引号被命令替换执行，写出来的内容是坏的。

```bash
gh api -X DELETE repos/dongopencv/tools/issues/comments/6710513283
```

### 2. 重发 #5 的 resolution 补充评论（干净版）

正文已经落在 `docs/pending-issues/i5-comment.md`。**必须用 `-F body=@file`，不要内联**——
上次就是内联被 shell 吃掉了反引号。

```bash
gh api -X POST repos/dongopencv/tools/issues/5/comments -F body=@docs/pending-issues/i5-comment.md
```

### 3. map #2 补「## 进度」与 Decisions 第 11 条

先把正文取回来改，再整体 PATCH 回去：

```bash
gh api repos/dongopencv/tools/issues/2 --jq .body > /tmp/i2.md
# 编辑 /tmp/i2.md：Decisions so far 末尾追加第 11 条，然后——
gh api -X PATCH repos/dongopencv/tools/issues/2 -F body=@/tmp/i2.md
```

第 11 条要写的内容：

> **11. 同一个脚本不许留两份实现，哪怕其中一份「只是旧一点」。**
> `tools/github.sh` 的真身在仓库，`skills-vault` 里那份 2026-11-07 收敛成了转发器（29 行，逻辑只有定位 + `exec` 那 10 行；执行时 `exec` 到真身，
> 可用 `GITHUB_GATEWAY` 覆盖）。判据：文档里出现的每个入口，都必须能 `exec` 到同一份实现；
> 否则两份会各自长 bug（旧副本至今带着 `sha256sum "$老家"` 那条反斜杠 bug）。
> 附带一条实测：MSYS bash 里 `ln -s <绝对路径>` **不建符号链接、而是复制实体文件**，所以收敛只能靠转发脚本。

### 4. 报一次处理进度

deck 上报要先把票读回来，读不回来就报不了。2026-11-08 02:1x 实测四次全失败：

| 票 | `deck_issue_report` 返回 |
|---|---|
| #2 | `这张票没上报（票 2 没读回来，后端原话：gh: Bad credentials (HTTP 401)）` |
| #3 | `这张票没上报（票 3 没读回来，后端原话：get: repo.refId missing: pc1）` |
| #4 | `…gh: Bad credentials (HTTP 401)` |
| #5 | `…gh: Bad credentials (HTTP 401)` |

恢复顺序：① 先确认 `gh api repos/dongopencv/tools/issues/2 --jq .number` 返回数字而不是 401；
② 再对 2/3/4/5 各跑一次 `deck_issue_report`。
#3 那条 `get: repo.refId missing: pc1` 是**另一个**缺陷（见 `deck-refid-bug.md`），与身份无关，
身份回来后仍会复现——先把那条缺陷票建出来。

## 恢复身份的做法

任务用的 PAT 需要补 `Issues: Read and write` 权限；或 `gh auth refresh`。
本机 `github.com` 的 443 被墙，设备码流程走不通，可行的是在网页上新建 / 修改 PAT 后 `gh auth login --with-token`。
