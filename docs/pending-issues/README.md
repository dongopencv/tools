# 待建票（等 GitHub 身份恢复）

这里的文件是**已经写好、但建不出去**的 issue 草稿。

为什么用文件而不是直接建票：2026-11-08 01:16 起本机推送与 API 写权限全部失效，
SSH 公钥被从账号移除、token 被撤销（证据见 `docs/log/2026-11-08.md`）。
身份一恢复，按下面的命令把它们建出来即可。

## 恢复后怎么建

```bash
gh issue create -R dongopencv/tools \
  --title "沉睡票的处置：14 张停 3 天的线，哪些还在跟" \
  --body-file docs/pending-issues/stale-tickets.md
# 拿到票号后挂到 map #47 下，再核对子票张数：
gh api -X POST repos/dongopencv/tools/issues/<新票号>/sub_issues -F sub_issue_id=<新票号>
gh api repos/dongopencv/tools/issues/47 --jq .sub_issues_summary
```

> `deck_map_link` 在本工作区仍然会失败（后端 `repo.refId missing: pc1`），
> 上面用 `gh api` 直接落边是当前唯一可行的路。缺陷票见 `deck-refid-bug.md`。

## 清单

| 文件 | 标题 | 归属 |
|---|---|---|
| `stale-tickets.md` | 沉睡票的处置：14 张停 3 天的线，哪些还在跟 | map #47 子票 |
| `deck-refid-bug.md` | deck 插件 repoOf() 解析不出 owner/name，父子边与阻塞边全落空 | 独立缺陷票 |
