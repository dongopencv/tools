# 待建票 / 待发评论（等 GitHub 身份恢复）

这里的文件是**已经写好、但发不出去**的东西：不能建的 issue 草稿、不能发的评论、不能做的收尾写操作。

为什么用文件而不是直接做：2026-11-08 01:16 起本机两个身份通道同时失效——
账号侧 SSH 公钥被清空（`GET /users/dongopencv/keys` → `[]`，而 01:13 同一把钥匙刚推成功过），
`.github-token` 被撤销（任何请求 401 `Bad credentials`）。**不是本机配置、不是网络、不是限流。**
完整证据见 `docs/log/2026-11-08.md`。

## 身份恢复后按这个顺序做

1. **删掉写坏且带 token 明文的评论** —— `issue-closeout.md` 第 1 节
2. **重发 #5 的 resolution 补充评论** —— 正文已备好在 `i5-comment.md`
3. **给 map #2 补「## 进度」与 Decisions 第 11 条** —— `issue-closeout.md` 第 3 节
4. **建两张新票** —— 见下面清单
5. **跑一遍 `deck_issue_report`（2/3/4/5）** —— `issue-closeout.md` 第 4 节

建新票的命令：

```bash
gh issue create -R dongopencv/tools \
  --title "沉睡票的处置：14 张停 3 天的线，哪些还在跟" \
  --body-file docs/pending-issues/stale-tickets.md
# 拿到票号后挂到 map #47 下：
gh api -X POST repos/dongopencv/tools/issues/47/sub_issues -F sub_issue_id=<新票号>
gh api repos/dongopencv/tools/issues/47 --jq .sub_issues_summary
```

> `deck_map_link` 在本工作区仍然会失败（后端 `repo.refId missing: pc1`），
> 上面用 `gh api` 直接落边是当前唯一可行的路。缺陷票见 `deck-refid-bug.md`。

## 清单

| 文件 | 是什么 | 归属 |
|---|---|---|
| `stale-tickets.md` | 票草稿：沉睡票的处置：14 张停 3 天的线，哪些还在跟 | map #47 子票 |
| `deck-refid-bug.md` | 票草稿：deck 插件 repoOf() 解析不出 owner/name，父子边与阻塞边全落空 | 独立缺陷票 |
| `issue-closeout.md` | 收尾写操作：删坏的评论 / 补 map #2 进度与 Decisions / 报进度 | map #2 与 #5 |
| `i5-comment.md` | #5 的 resolution 补充评论正文（干净版，等 PATCH/POST） | #5 |
| `map47-progress.md` | map #47 正文追加草稿：#49 交付物 + 身份失效期间的真实状态 | map #47 |
| `credential-rotation.md` | 已泄露凭据清单与待轮换项（**不含任何口令值**） | 人来做 |