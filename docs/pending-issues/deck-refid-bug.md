## 现象

在本工作区（cwd = `D:\proj\PC1`，git remote = `dongopencv/tools`）调用 `deck_map_link` 落父子边或阻塞边，
**全部失败**，后端原话：

```
setParent: repo.refId missing: pc1
setBlockedBy: repo.refId missing: pc1
```

换成 `deck_issue_create` + `deck_map_plan_create` 也一样。
而 `gh api` 手落同样的边是成功的，说明不是 GitHub 不支持，是插件解析错了仓库。

## 根因（源码位置）

| 文件:行 | 代码在做什么 | 问题 |
|---|---|---|
| `shared/deck-tools/shell.js:257` | `repoOf()` 只取 `pick.ref.refId` | refId 为空时直接返回空，没有回落到 remote |
| `lib/tracker/backends/github/repo.js:28` | `describe()` 在 `handle.refId` 为空时回落 **cwd basename** | 得到 `pc1`——一个不含 `/` 的裸目录名，不是 `owner/name` |
| `graph.js:20` | `parseRepo()` 要求 `owner/name` 形状 | `pc1` 不含 `/` → 返回 `null` → 所有边操作报 `repo.refId missing: pc1` |
| `shared/deck-tools/shell.js:220` | `getRepoKey` 本应三层兜底补 `owner/name` | 没补成：`docs/agents/workspace.json` 在本工作区不存在，只有 `~/.dsh/mattskillsdeck/choices.json` 里 `75f79d75…` 的绑定 |

## 影响

- `deck_map_link` / `deck_map_plan_create` 在本工作区**完全不可用**，只能退回 `gh api` 手搓。
- `deck_issue_get` / `deck_map_snapshot` 单次调用 **>120s 不返回**（同一根因：拿不到 repo 就一直等）。
- wayfinder 流程里「建边工具自己落原生边并校验数量」这一条，在当前后端上**必然走降级分支**。

## 期望

1. `describe()` 在 refId 为空时，回落顺序应为 **git remote origin → `choices.json` 绑定 → 报错**，
   绝不能用 cwd basename——那是目录名，不是仓库名。
2. `parseRepo()` 拿到不含 `/` 的值时直接判失败并给出可执行的修法（比如「请设置 workspace.json」），
   不要把它当成合法 repo 继续往下走。
3. 同一根因导致的 `deck_issue_get` 超时应该**尽早失败**，不要卡满 120s。

## 复现

```bash
cd D:/proj/PC1
gh issue view 47 --json number          # 正常，说明 gh 侧没问题
# 调 deck_map_link(parentKey: "47", key: "<任意票号>") → 报 repo.refId missing: pc1
```
