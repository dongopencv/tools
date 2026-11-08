# 给 PAT 补权限（2026-11-08 实测结论）

> **已解决（2026-11-08 16:2x）**：用户把这枚细粒度 PAT 的 **Issues** 与 **Contents** 补成了 Read and write，
> 写操作实测全部通过（见文末「补齐后的复核」）。这份文档保留原始诊断过程，因为它记录的是
> **「403 不等于链路不通」的判定方法**，下次遇到同类问题照这个矩阵测一遍就能定位。
> 账号 SSH 公钥也已恢复（22 与 443 都 `successfully authenticated`）。

结论先说（**诊断时**的状态）：**那枚 token 只读，写接口全 403，push 也 403。缺的是两处授权，不是链路。**

## 实测矩阵（2026-11-08 10:33，token 前缀 `github_pat_11A2S`，93 字节）

| 操作 | 结果 | 说明 |
|---|---|---|
| `GET repos/dongopencv/tools` | 200 | 读没问题 |
| `GET repos/.../issues/5` | 200 | 票能读全 |
| `GET repos/.../contents/tools/github.sh` | 200 | 文件能读 |
| `PATCH repos/.../issues/5` | **403** | 改正文/标题不行 |
| `POST repos/.../issues/5/comments` | **403** | 发评论不行 |
| `DELETE repos/.../issues/comments/6710513283` | **403** | 删坏评论不行 |
| `PUT repos/.../contents/__probe__.txt` | **403** | 提交文件不行 |
| `POST repos/.../git/refs` | **403** | 建分支不行 |
| `POST user/keys` | **403** | 自己注册 SSH 公钥不行 |
| `git push`（SSH） | **403** | `Permission to dongopencv/tools.git denied` |

403 响应体统一是 `{"message":"Resource not accessible by personal access token"}`，
写 issue 时响应头明确写着：

```
X-Accepted-Github-Permissions: issues=write; pull_requests=write
```

对照：`gh api repos/dongopencv/tools --jq .permissions` → `admin/maintain/push/triage` 全 true。
**身份没问题，是 token 没授写权。**

## 要改的地方

打开 <https://github.com/settings/tokens> → 找到这枚细粒度 token → Edit：

1. **Repository permissions → Issues = Read and write**
   解决：改正文、发评论、删评论、关票。
2. **Repository permissions → Contents = Read and write**
   解决：写文件、建分支、走 HTTPS 的 git 操作（本机 push 仍以 SSH 为主）。
3. **账号级 SSH 公钥不在这枚 token 的能力范围里**：`POST user/keys` 用细粒度 PAT 恒为 403。
   加公钥只能人工在 <https://github.com/settings/keys> 操作。

改完把新值写到 `C:/Users/Admin/.skills-vault/download/scripts/.github-token`，再 `gh auth login -h github.com --with-token`。

## 补齐后一把跑完

```bash
bash tools/issue-closeout.sh            # 先演练，看它要做什么
bash tools/issue-closeout.sh --apply    # 真写
```

脚本做五件事（幂等，靠正文里的 HTML 注释标记判断是否已做过）：

1. 预检读写权限，写不通就 exit 2 并打印缺哪几项；
2. 删旧评论 `6710513283`；
3. 重发干净版 resolution（正文取自 `docs/pending-issues/i5-comment.md`，**一律 `-F body=@file`**，不内联）；
4. 把 `## 收尾（2026-11-08）` 追加进 #5 正文；
5. PATCH map #2 追加 Decisions 第 11 条（正文取自 `docs/pending-issues/map-gist.md`）。

## 为什么写这个脚本

上一版是四条手敲命令，其中「内联正文」那条被 bash 当成命令替换执行——
正文里的反引号被跑掉、把本地 token 文件的内容顶进了公开评论的表格单元格，
GitHub 侧随即作废了那枚 token。
**内联正文 + 反引号 = 事故**。脚本把所有正文都走文件，杜绝这一类。

## 补齐后的复核（2026-11-08 16:2x，同一枚 token）

用户把 Permissions 里 Issues 与 Contents 都改成 Read and write（token 文件仍是 93 B、内容换新）后复测：

| 操作 | 结果 |
|---|---|
| `PATCH repos/.../issues/5`（no-op 标题） | **200**，返回 `5 / closed` |
| `POST repos/.../issues/5/comments`（探针） | **201**，拿到 id `6719206931` |
| `DELETE repos/.../issues/comments/6719206931`（删探针） | **204** |
| `DELETE repos/.../issues/comments/6710513283`（旧评论） | **404 = 早已不存在** |
| `GET /users/dongopencv/keys` | **1 个**（`ssh-ed25519`） |
| `ssh -T git@github.com` / `ssh -p 443 -T git@ssh.github.com` | 两条都 `successfully authenticated` |
| `git rev-list --count origin/master..HEAD` | **0** |

两条**判据**留下来，别再靠猜：

- **写接口报 403 且响应头带 `X-Accepted-Github-Permissions: ...=write`** → 授权问题，去改 PAT 权限。
- **写接口报 404** → 有时不是「没有」而是「**无权看到**」。删一条不存在的评论返回 404 恰好证明`delete` 权限已到位
  （无权时会先撞 403）。这条被写进了 `tools/issue-closeout.sh` 的预检：**用 DELETE 探针返回 404 判定「写权限可用」**。

顺带修掉一处**探测手段骗人**：`tools/github.sh status` 原来用 `bash -c 'exec 3<>/dev/tcp/github.com/22'` 探端口，
本机 MSYS bash 下这条**常常 10 s 超时**，而同一秒 `ssh -T git@github.com` 秒回 authenticated，于是 status 天天报
「22 → 不通」。现在改成**直接拿真正要用的 `ssh` 去试**，并区分三种结果：认证成功 / 端口通但 `Permission denied` / 完全不通。
实测连跑三次：`/dev/tcp` 探 22 端口 1/3 通，`ssh` 3/3 通——**被推翻的是探测方法，不是网络**。
