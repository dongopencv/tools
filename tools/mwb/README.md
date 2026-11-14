# tools/mwb —— 无界鼠标（Mouse Without Borders）排障脚本

与 `local-pc` 技能的 `scripts/` 目录保持同一份内容（vault 不是 git 仓库，所以在这里留版本管理副本）。
技能文档见 `local-pc` 技能 §2.12。

## 什么时候用

「PC0 复制粘贴不到 PC1」这类**单向**剪贴板失效。典型表现：

- PC0 复制 → PC1 粘贴：Ctrl+V 和右键粘贴**都不行**
- PC1 复制 → PC0 粘贴：**正常**

这不是粘贴方式的问题，是**发送端**的 `ShareClipboard` 被关掉了，数据根本没出网。

## 用法

```powershell
# ① 先查（只读，不改任何东西）。-Peer 会同时查对端
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mwb\Test-MwbClipboard.ps1 -Peer

# ② 再修。哪台报 false 就在哪台跑
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mwb\Fix-MwbClipboard.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mwb\Fix-MwbClipboard.ps1
```

| 脚本 | 作用 | 关键行为 |
|---|---|---|
| `Test-MwbClipboard.ps1` | 只读体检 | 报两侧 `ShareClipboard` + 15101 链路；**绝不写文件** |
| `Fix-MwbClipboard.ps1` | 安全修复 | 备份 → 停 PowerToys → **只换 5 个字符** → 硬校验 → 失败自动还原 → Highest 拉起 |

## 为什么不是简单改个 JSON

`settings.json` 里 `MachinePool` / `Name2IP` / `SecurityKey` 一旦被写空**不会自愈**，
鼠标跨屏当场就断。2026-11-14 用「整份重写」踩过这个坑，靠备份还原才救回来。
所以 `Fix-MwbClipboard.ps1` 只做字节级替换，并且校验不过就自动还原、不启动。

## 铁律

**两台都不许再把 `ShareClipboard` 关掉，让它一直是 `true`。**
2026-11-10 关掉后 4 天没开回来，表现就是这个「复制不过去」。
要临时关必须立刻开回来，并在当天 `docs/log/` 留一行。
