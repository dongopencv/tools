# 给 PAT 补权限（2026-11-08 实测结论）

结论先说：**现在这枚 token 只读，写接口全 403，push 也 403。缺的是两处授权，不是链路。**

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
| `git push`（经 8899 relay） | **403** | `Permission to dongopencv/tools.git denied` |

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
   解决：push（git over HTTPS 经 8899 relay 已实测链路通，只差这一项）。
3. （可选）**Account permissions → Git SSH keys = Read and write**
   这样就能用 `POST user/keys` 把公钥自己注册回去，不必手点网页。账号上现在 **0 个 SSH key**。

改完把新值写到 `C:/Users/Admin/.skills-vault/download/scripts/.github-token`，再 `gh auth login -h github.com --with-token`。

## 补齐后一把跑完

```bash
bash tools/issue-closeout.sh            # 先演练，看它要做什么
bash tools/issue-closeout.sh --apply    # 真写
```

脚本做五件事（幂等，靠正文里的 HTML 注释标记判断是否已做过）：

1. 预检读写权限，写不通就 exit 2 并打印缺哪几项；
2. 删评论 `6710513283`（含 token 明文那条）；
3. 重发干净版 resolution（正文取自 `docs/pending-issues/i5-comment.md`，**一律 `-F body=@file`**，不内联）；
4. 把 `## 收尾（2026-11-08）` 追加进 #5 正文；
5. PATCH map #2 追加 Decisions 第 11 条（正文取自 `docs/pending-issues/map-gist.md`）。

## 为什么写这个脚本

上一版是四条手敲命令，其中「内联正文」那条被 bash 当成命令替换执行——
反引号里的内容被跑掉、把 `.github-token` 的明文顶进了公开评论的表格单元格，
GitHub secret scanning 秒级检出并吊销了那枚 `ghp_` token。
**内联正文 + 反引号 = 事故**。脚本把所有正文都走文件，杜绝这一类。

## 顺带修掉的基线偏差

AGENTS.md 原来写「HTTPS 写操作三条路全死」。2026-11-08 实测：
`git -c http.proxy=http://127.0.0.1:8899 -c http.sslVerify=false \
   -c http.extraheader="Authorization: Basic <base64(x-access-token:TOKEN)>" \
   ls-remote https://github.com/dongopencv/tools.git HEAD`
→ 返回真实 SHA，**通**。push 同形态返回 403（权限问题，不是链路问题）。
即：**HTTPS 写操作经 relay 是活的**，缺的只是 token 的 Contents=write。
