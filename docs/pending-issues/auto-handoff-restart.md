# dsh-auto-handoff：现网生效与待验证（2026-11-08 13:30 版）

代码已到 **v1.1.2**（`D:\proj\PC1\plugins\dsh-auto-handoff`，过渡期运行副本 `D:\tools\dsh-auto-handoff` 与它 md5 一致），
四套离线测试全绿（integration 16 / midturn 5 / chain 8 / claims 10），两部分设计票（10 张）已全部关闭。

## 「必须人重启」这条结论已被推翻

旧版这里写着：桌面宿主启动时一次性加载插件，`dsh-plugin/lib/services/loader.js` 只有 live-disable，
`dsh-plugin/lib/http/` 没有 reload 端点，`dsh` CLI 也没有 reload 子命令，**只能由人退出再打开**。

实测推翻（2026-11-08 05:18Z）：DSH 自带 `@deepseek-ai/dsh-hmr`，它监听 profile 的 `package.json` 与
`cordis.patch.yml`，文件一改就触发一次 **profile 重组（recomposition）**，把「被改动过的 linked 包」整体换掉。
本插件正是 profile 里的 `link:` 包（`node_modules/dsh-auto-handoff` → `D:\tools\dsh-auto-handoff`，
HMR 的 `profileRoots()` 只收集 `node_modules` 下的符号链接条目），所以在它的追踪范围内。

验证过程：往 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加一行注释 → **3 秒后**插件日志出现新的
`已启用：token 阈值 300000 / 工具调用阈值 80，交接目录 .dsh/handoff…`（说明 `apply()` 重新跑了一遍）→
此后「轮中触发被占位拦下」刷屏立刻停止（v1.1.1 的「同一会话只留一条证据行」行为）。marker 已还原，
还原不会再触发一次重载（内容回到旧值，HMR 的 inputs 比对相等）。

**仍然成立的部分**：改动模块若落在宿主自身模块（`hostModules()`）里，或 HMR 判为 `unmanaged-plugin`，
会走 `pending` 路径，日志警告「changed modules keep running their previous code until a restart」——那才真得重启。
本插件不属于这两类。

## 判据已经脚本化（不要再人肉翻日志）

```bash
node tools/handoff-check.mjs --deep      # 它坏了没有：10 项检查 + 四套离线测试
node tools/handoff-metrics.mjs --verify  # 阈值该设多少、验收够不够：8 项判据
```

两条命令都在有 FAIL 时 exit 1，可直接进 `&&` 链。

`handoff-check.mjs` 在 13:20 改过一次判据：原来用「`lib/index.js` mtime > `hub.log` 里最后一次
`system.start`」判定新旧模块——HMR 重载不写 `system.start`，这条判据永远误报 FAIL。
现在改成从插件日志里抽**最后一次桌面配置的「已启用」行**当 `loadedAt`，所有检查只看这之后的产物：
更早的行与文档是旧模块的历史遗留，不计入缺陷。

## 当前实测（2026-11-08T05:29Z，`node tools/handoff-check.mjs`）

**0 FAIL / 8 WARN / 1 PASS**，exit 0。8 条 WARN 全是同一句：「本次加载后还没有跑过一次真实交接」。

| 检查项 | 现在 | 说明 |
|---|---|---|
| 代码版本 | ✅ PASS | 加载于 05:18:20.463Z，晚于 `lib/index.js` mtime 04:38:06.718Z |
| 链深（genesis） | ◐ WARN | 加载后没有新棒。历史 claims 17 条：done×14 / stopped×3（3 条 stopped 是 headless e2e 探针，note=no-session-controller） |
| 交接是否真发生过 | ◐ WARN | 历史 7 次，末次 02:41:33Z（305b→c454，369385 tokens / 242 次工具调用）；本次加载后 0 次 |
| 交接前 REVIEW | ◐ WARN | 历史 9 次，末次 04:40:34Z（e2e）；本次加载后 0 次 |
| 日志是新格式 | ◐ WARN | 本次加载后只有 1 行（「已启用」），没有 `[sessionId] 轮中触发…` 这类行为行 |
| 父会话是否被停 | ◐ WARN | 加载后无「父会话当前轮已取消」 |
| 交接文档有「下一步」 | ◐ WARN | 加载后没写新文档；历史 8 份里 4 份没有（都已确认是旧模块产物） |
| 简报送达 | ◐ WARN | 加载后没投递过 |
| 离线测试 ×4 | ✅ PASS | `--deep` 才跑 |

## 下一次真实交接要盯的四件事

1. 交接文档里有 **`## 下一步`** 且是完整句子（v1.1.1 的 `orderSummary` + v1.1.2 的 `summaryTokenBudget` 共同保证）。
2. 日志出现 **`[sessionId]` 前缀**的行，并且「轮中触发被占位拦下」不再逐次刷屏。
3. 日志出现 **「父会话当前轮已取消」**（`cancelParentAfterHandoff` 默认 true）。
4. `claims.json` 里新出现的棒是 **`genesis`** 而不是 `done`，说明链条能走过第 2 棒。

## 票库现状（地图 #12：12 张子票，已关 10）

| 票 | 状态 | 说明 |
|---|---|---|
| #13 四阶段即终点 | closed | 强制只到「触发+落盘+开新棒」 |
| #14 运行现状与横评 | closed | 在跑但只跑通前半段；简报 0/86 |
| #22 竞品横评 | closed | 续作列全球空白；可抄机制八条 |
| #16 记忆三层 | closed | `index.md` / `facts.jsonl` / taskboard |
| #19 源码与版本控制 | closed | 源码进 `plugins/`，commit a5cb4d0 |
| #15 强制边界 | closed | 采纳 L2、拒绝 L3；阈值改按窗口比例 |
| #29 文档结构 | closed | 三段式 + 节边界裁剪 + 下一步第二 |
| #17 REVIEW 定稿 | closed | 三层只有 L1 能刹车；结论不回写票库 |
| #18 续作链 | closed | `maxAutoHops` / `chain.json` / `deferred` / rename 可见 |
| #20 可观测与验收 | closed | `tokenThresholdRatio=0.45` / `events.jsonl` / 八条验收 |
| #46 打通简报投递 | **open** | 代码侧做完，等一次真实交接回填四项验收 |
| #65 落地实现 | **open（等 #46）** | 把 #17/#18/#20/#29 的设计决定变成代码 |

## 仍然做不到 / 待裁决的事

- **`chainLimit = 8` 从未被真实跑到**：claims 里最大链深是 1。要验证只能人工构造 8 棒长链（#65 落地后第一件该做的事）。
- **阈值的绝对值还不敢定**：只有 6 次真实交接（门槛 20）。所以 #20 只改了比例（0.45），没动 `tokenThreshold` / `toolCallThreshold` 的默认绝对值。
- **headless e2e 验不到全链路**：headless profile 没有 `sessionController`，只能验文档生成与 REVIEW，验不到 cancel 父会话与 genesis 占位。
- **e2e 与桌面宿主共用 `USERPROFILE`**：同一份 `claims.json` 与日志会被互相污染，跑 e2e 后要手工清理（claims 里那 3 条 `no-session-controller` 的 stopped 就是 e2e 残留）。
- **`dongopencv/dsh-auto-handoff` 不存在（404）**：要进版本控制只能落 `dongopencv/tools` 内。
- **待裁决：`REQUIREMENTS.md:78` 的 N2（不杀掉旧会话、不调用 `sessionController.cancel`）与已落地的
  `cancelParentAfterHandoff: true` 正面冲突**。票 #15 的结论是「采纳 L2、拒绝 L3」，而 L3 恰恰就是 cancel。
  代码已经做了票面与需求都写明不做的事，三条路：改 N2（承认需求变更，需拍板）、默认值改回 `false`（只留开关）、撤回 cancel。
  **在动 #65 之前必须先定这一条**，否则 #65 会照着错误的需求边界施工。
