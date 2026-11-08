# dsh-auto-handoff：待重启验证 + 待补票（2026-11-08 12:50 版）

代码已到 **v1.1.2**（`D:\proj\PC1\plugins\dsh-auto-handoff`，过渡期运行副本 `D:\tools\dsh-auto-handoff` 与它 md5 一致），
四套离线测试全绿（integration 16 / midturn 5 / chain 8 / claims 10），两部分设计票（10 张）已全部关闭。

**但现网 DSH 仍加载 02:17:31 启动时的那份旧模块**——桌面宿主的插件在启动时一次性加载：
`dsh-plugin/lib/services/loader.js` 只有 live-disable（`removeLoadedEntry` 走 `entry.update({disabled:true})`），
`dsh-plugin/lib/http/` 九个模块里没有 reload 端点，`dsh` CLI 也没有 `reload` 子命令。
**只能由人从菜单/托盘退出桌面版再打开。** 插件侧不能自杀式重启（会把发起重启的助手一起结束，应用壳判成宿主崩溃）。

## 判据已经脚本化（不要再人肉翻日志）

```bash
node tools/handoff-check.mjs --deep   # 它坏了没有：9 项检查 + 四套离线测试
node tools/handoff-metrics.mjs --verify # 阈值该设多少、验收够不够：8 项判据
```

两条命令都在有 FAIL 时 exit 1，可直接进 `&&` 链。

### 重启前实测（2026-11-08T04:45Z）

| 检查项 | 现在 | 重启后应为 |
|---|---|---|
| 代码版本 | ❌ `lib/index.js` mtime 04:38 晚于宿主启动 02:17:31 | ✅ mtime 早于最后一次 `system.start` |
| 链深（genesis 修复） | ❌ `done×14 / stopped×3`，7 个 depth>=1 的占位全是终态 | ✅ 新出现的棒是 `genesis` |
| 交接是否真发生过 | ✅ 7 次，末次 02:41:33Z | 保持 |
| 交接前 REVIEW | ✅ 9 次 | 保持 |
| 父会话是否被停 | ◐ 没有「父会话当前轮已取消」（旧模块不会停） | ✅ 出现该行 |
| 日志刷屏 | ◐ 1270/1329（96%） | ✅ 噪声比 <20% |
| 交接文档结构 | ✅ 最新一份含 `## 交接前 REVIEW` | 保持 |
| 交接文档有「下一步」 | ❌ 最新一份没有（v1.1.1 的 `orderSummary` 才修） | ✅ 出现 `## 下一步` |
| 简报送达 | ✅ 6878 字符 | 保持 |
| 离线测试 ×4 | ✅ 8 / 10 / 15 / 5 | 保持 |

## 重启后要做的四件事

1. `node tools/handoff-check.mjs --deep` → 期望 **0 FAIL**。
2. `node tools/handoff-metrics.mjs` → 噪声比应从 99.2% 掉到 <20%，「日志只含一个 profile 的配置」转 PASS。
3. ``/.dsh/auto-handoff/claims.json` 里新出现的棒应是 **`genesis`** 而非 `done`（说明链条能走过第 2 棒）。
4. 回填 #46 的四项验收并 close —— 它是地图 #12 上唯一还开着的设计票，且 #65 落地实现正等着它。

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
| #46 打通简报投递 | **open** | 代码侧做完，卡宿主重启 |
| #65 落地实现 | **open（等 #46）** | 把 #17/#18/#20/#29 的设计决定变成代码 |

## 仍然做不到的事

- **插件不能自杀式重启**：只能人从菜单/托盘退出再打开。
- **`chainLimit = 8` 从未被真实跑到**：claims 里最大链深是 1。要验证只能人工构造 8 棒长链（#65 落地后第一件该做的事）。
- **阈值的绝对值还不敢定**：只有 6 次真实交接（门槛 20）。所以 #20 只改了比例（0.45），没动 `tokenThreshold` / `toolCallThreshold` 的默认绝对值。
- **headless e2e 验不到全链路**：headless profile 没有 `sessionController`，只能验文档生成与 REVIEW，验不到 cancel 父会话与 genesis 占位。
- **e2e 与桌面宿主共用 `USERPROFILE`**：同一份 `claims.json` 与日志会被互相污染，跑 e2e 后要手工清理。
- **`dongopencv/dsh-auto-handoff` 不存在（404）**：要进版本控制只能落 `dongopencv/tools` 内。