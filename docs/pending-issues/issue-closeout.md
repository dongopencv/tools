# 收尾写操作（等 GitHub 身份恢复）

2026-11-08 01:16 起，本机两个身份通道同时失效，所有 issue 写操作排队在这里。
证据与诊断见 `docs/log/2026-11-08.md`：账号侧 SSH 公钥被移除（`GET /users/dongopencv/keys` = `[]`），
`.github-token` 被撤销（任何请求都 401 `Bad credentials`）。**不是本机配置问题，也不是限流问题。**

## 待办（按顺序做）

### 1. 删掉那条写坏、且带 token 明文的评论

评论 id `6710513283`（#5 第 6 条，2026-11-07T17:14:15Z）。当时用 shell 内联正文，
反引号被命令替换执行，`.github-token` 的明文被写进了这张公开评论的表格里。token 现已吊销，
但公开仓库的历史里留着它不是好事。

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
> `tools/github.sh` 的真身在仓库，`skills-vault` 里那份 2026-11-07 收敛成了 10 行转发器（`exec` 到真身，
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

恢复身份后的顺序：① 先确认 `gh api repos/dongopencv/tools/issues/2 --jq .number` 返回数字而不是 401；
② 再对 2/3/4/5 各跑一次 `deck_issue_report`。
#3 那条 `get: repo.refId missing: pc1` 是**另一个**缺陷（见 `deck-refid-bug.md`），与身份无关，
身份回来后仍会复现——先把那条缺陷票建出来。

## 恢复身份的两条路（任选一，人来做）

1. **加回 SSH 公钥**（能 push，但 API/issue 仍不可写）：
   `https://github.com/settings/keys` → New SSH key，粘贴 `C:/Users/Admin/.ssh/id_ed25519_gh.pub`
   （指纹 `SHA256:VIn9zYJq3v85hdyHNJX2YjFWIki/Jr3eT4lnPcvG6Uo`，注释 `dsh-gh-gateway@PC1`）。
2. **重新登录 gh**（一条命令同时恢复 API 与 push）：`gh auth login -h github.com`。
   注意本机 `github.com` 的 443 被墙，设备码流程走不通；可行的是在网页上新建 PAT 后 `gh auth login --with-token`。

## 历史里还留着的东西（另一件事，见 credential-rotation.md）

`.workbuddy/memory/2026-11-05.md` 从 `bf5867c` 起就在公开仓库的历史里，含明文口令。
轮换与历史改写是人的决定，本文件不处理。