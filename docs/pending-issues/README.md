# 待建票 / 待发评论（历史归档）

> **2026-11-08 11:25 更新：五步全部执行完毕，本目录不再是「没发出去的东西」。**
> 删评论 `6710513283`、重发 resolution 评论 `6716358563`、回写 #5 正文、map #2 补 Decisions 11–13、
> 第 4 步建票（**#63** deck 插件缺陷 / **#64** 沉睡票处置，#64 已挂 map #47 原生父子边，读回 10）、
> `deck_issue_report`（#2/#3/#4/#5/#47/#63/#64）均已落地。
> **本目录现在的用途只有一个：留证据。** 每个文件记着「当初为什么卡住、后来怎么解的」；
> 不要再往里加新的待办——能做的当场做，做不了的先建票。

这里的文件原本是**已经写好、但发不出去**的东西：不能建的 issue 草稿、不能发的评论、不能做的收尾写操作。

为什么曾经用文件而不是直接做：2026-11-08 票库写操作一度全线不可用（`gh` 报 401、SSH 被拒），
所以写好但发不出去的东西先落成文件，等通道恢复后照抄执行。**通道已恢复，五步已全部执行完毕**；
本目录转为归档，只保留「为什么卡、怎么解的」这条证据链。

## 权限恢复后按这个顺序做

1. ~~**删掉写坏的那条评论**~~ —— ✅ 2026-11-08 已删（`issue-closeout.sh --apply` 第 1 步）
2. ~~**重发 #5 的 resolution 补充评论**~~ —— ✅ 已发，评论 id `6716358563`
3. ~~**给 map #2 补「## 进度」与 Decisions 第 11 条**~~ —— ✅ 已补，现为 Decisions 第 11–13 条
4. ~~**建两张新票**~~ —— ✅ 已建 **#63**（deck 插件 repoOf 解析缺陷，独立缺陷票）、**#64**（沉睡票处置，已挂 map #47 下）
5. ~~**跑一遍 `deck_issue_report`（2/3/4/5）**~~ —— ✅ 上报范围已扩到 #2/#3/#4/#5/#47/#63/#64

建新票 + 挂原生父子边的确切命令（已实跑，可复用）：

```bash
# 1) 建票：正文走 -f body="$(cat file)"，标签用 -f 'labels[]=...'
gh api -X POST repos/dongopencv/tools/issues \
  -f title="沉睡票的处置：14 张停 3 天的线，哪些还在跟" \
  -f body="$(cat docs/pending-issues/stale-tickets.md)" \
  -f 'labels[]=wayfinder:task' --jq .number

# 2) 挂到 map 下：sub_issue_id 要 issue 的 database id，不是票号
id=$(gh api repos/dongopencv/tools/issues/64 --jq .id)
gh api -X POST repos/dongopencv/tools/issues/47/sub_issues -F sub_issue_id=$id

# 3) 校验：REST 的 sub_issues_summary 有陈旧缓存，第一次读可能还是旧值；
#    权威读法是 GraphQL subIssues
gh api graphql -f query='query { repository(owner:"dongopencv", name:"tools") {
  issue(number:47) { subIssues(first:20) { totalCount nodes { number } } } } }'
```

> `deck_map_link` 在本工作区仍然会失败（后端 `repo.refId missing: pc1`），
> 上面用 `gh api` 直接落边是当前唯一可行的路。缺陷票见 `deck-refid-bug.md`。

## 清单

| 文件 | 是什么 | 归属 |
|---|---|---|
| `stale-tickets.md` | 已建票 **#64** 的正文（沉睡票的处置） | map #47 子票 |
| `deck-refid-bug.md` | 已建票 **#63** 的正文；根因追到 `shell.js:257` / `repo.js:28` / `graph.js:20` | 独立缺陷票 |
| `issue-closeout.md` | 收尾写操作：删坏的评论 / 补 map #2 进度与 Decisions / 报进度 | map #2 与 #5 |
| `i5-comment.md` | #5 的 resolution 补充评论正文（干净版，等 PATCH/POST） | #5 |
| `map47-progress.md` | map #47 正文追加草稿：#49 交付物 + 中断期间的真实状态 | map #47 |
| `map-gist.md` | map #2 决策第 11 条正文（「链路不通」与「没有授权」分开报） | map #2 |
| `pat-permission-fix.md` | 给 PAT 补两处写权限的实测矩阵与操作步骤 | 人工 |
| `credential-rotation.md` | 泄露面清点与处置顺序（先删公开副本 → 再轮换 → 最后才谈历史改写） | 人工 |
| `capswriter-speech-rollout.md` | dsh-capswriter-speech 两端重启与写回的待办 | #30 map |
| `auto-handoff-v1.1.0-restart.md` | auto-handoff v1.1.0 重启核验清单 | 人工 |

## 一条命令跑完 1–3 步

`tools/issue-closeout.sh` 把上面第 1/2/3 步（删坏评论、重发 resolution、回写 #5 正文、补 map #2 决策）
串成一个幂等脚本，靠正文里的 HTML 注释标记判断是否已做过：

```bash
bash tools/issue-closeout.sh            # 演练，只打印要做什么
bash tools/issue-closeout.sh --apply    # 真写（需 Issues+Contents 写权限，否则 exit 2）
```

权限怎么补，见 `pat-permission-fix.md`。
