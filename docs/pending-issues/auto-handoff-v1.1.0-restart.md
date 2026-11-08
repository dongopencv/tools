# dsh-auto-handoff v1.1.0：待重启验证 + 待补票

代码与文档已改完（`D:/tools/dsh-auto-handoff`，版本 1.1.0），四套离线测试全绿，离线多跳探针跑通。
**但现网 DSH 仍加载旧模块**——桌面宿主的插件代码在启动时一次性加载，插件侧没有任何热重载通道
（宿主 `dsh-plugin` 的 `/dsh-plugin-hub/restart` 在桌面端直接早退；`dsh` CLI 没有 `reload` 子命令；
loader 只在装/卸插件时挂载，不重载已加载条目）。**只能由人从菜单/托盘退出桌面版再打开。**

## 判据已经脚本化（不要再人肉翻日志）

```bash
node tools/handoff-check.mjs --deep
```

| 检查项 | 重启前实测（2026-11-08T03:11Z） | 重启后应为 |
|---|---|---|
| 代码版本 | ❌ `lib/index.js` mtime 02:39:21Z 晚于宿主启动 02:17:31Z | ✅ mtime 早于最后一次 `system.start` |
| 链深（genesis 修复） | ❌ `done×14`，7 个 depth>=1 的占位全是终态 done | ✅ 新出现的棒是 `genesis` |
| 交接是否真发生过 | ✅ 7 次，最后一次 02:41:33Z（305b0163 → c4549758） | 保持 |
| 交接前 REVIEW | ✅ 6 次 | 保持 |
| 日志刷屏 | ◐ `轮中触发被占位拦下` 303/343 行（88%） | ✅ 同一会话只打一行 |
| 交接文档结构 | ✅ 最新一份含 `## 交接前 REVIEW` | 保持 |
| 简报送达 | ✅ c4549758 首条 user/message 即简报，6740 字符 | 保持 |
| 离线测试 ×4 | ✅ 8 / 10 / 10 / 4 条断言 | 保持 |

退出码 0 = 没有 FAIL。**两条 FAIL 都是「新代码没被加载」，不是代码错**——三处修复
（`genesis` 取代 `done`、`midTurnFired` 去重、chainLimit 早退落 `stopped`）都在 02:39 的源码里，
测试也已覆盖，重启即生效。

## 重启后要做的三件事

1. `node tools/handoff-check.mjs --deep` → 期望 0 FAIL。
2. 如果链路继续往下走，`claims.json` 里应出现 `genesis` 且 `chainDepth` 能超过 1；
   走到 `chainLimit: 8` 时那一棒应落 `stopped`（终态），不再无限续作。
3. 回填 #46 的四项验收并 close；然后按 #15 → #29 → #19 推进。

## 待补的票（票库写通道已恢复）

- **#46（打通简报投递）**：①②④ 已由本轮修复覆盖，③ 跨进程占位由 `claims.json` 覆盖。
  重启核验通过后写 resolution 并 close。
- **#15（检测强制执行）**：新增证据——现网空壳会话涨到 1001+，根因是「失败即删除占位」；
  已修为 `failed` + 冷却 + 次数上限，且轮中闸加了 `midTurnFired` 去重。
- **#29（交接文档结构定稿）**：本轮先给了六节结构与「落盘全文 / 注入裁剪」分离，字段级定稿仍待这张票。
- **#19（源码/文档/版本控制对齐）**：`D:/tools/dsh-auto-handoff` 至今**不是 git 仓库**；
  `ISSUES.md:94/96/112/113/115/134` 与 `REQUIREMENTS.md:4` 仍写 `D:\\PC0\\...` 的过期路径；
  文档里的「`lib/index.js` 913 行」实为 1360 行。
- **地图 #12**：进度一节需补 v1.1.0 这一轮。

## 仍然做不到的事

- 插件不能自杀式重启（会把发起重启的助手一起结束，应用壳判成宿主崩溃）。重启只能人工做。
- `dsh-auto-handoff` 没有远端仓库，也没有 `dongopencv/dsh-auto-handoff` 这个 GitHub 项目（404）；
  要进版本控制只能落 `dongopencv/tools` 内（该仓库 SSH push 实测可用）。
