# 待发：#30 map 的 B 线落地结果（暂存）

写权限：当前 PAT 没有 issues 写权限，所以 #37 / #38 / map #30 本轮无法写回。

## 已落地（PC1 + PC0 双向验证）

- 插件 `dsh-capswriter-speech`：把 DSH 语音输入（麦克风按钮）后端换成 CapsWriter-Offline（Fun-ASR-Nano）
- PC1 源 `D:/tools/dsh-capswriter-speech`，PC0 副本 `D:/PC0/plugins/dsh-capswriter-speech`
- 两端都插在 `@deepseek-ai/dsh-experimental-voice-input-bundle` 之后（补丁顺序决定覆盖是否生效）
- provider id `capswriter-remote`，`location` 必须是 `cloud`（`host-local` 会触发 UI 安装引导）
- PC1 `ws://127.0.0.1:6016`、PC0 `ws://192.168.1.38:6016`
- 实测：31.7 s 音频 → PC1 2.9 s / PC0 2.86 s，文本逐字一致
- 光标：`D:/tools/cursors/ibeam-dark-halo-*.cur`（黑 I 本体 + 白描边），PC1/PC0 的 `HKCU\Control Panel\Cursors\IBeam` 都已指过去

## 还剩一步（需人工）

- 两端都要**重启 DSH**，插件在宿主启动时加载；重启后「语音识别服务」下拉应出现 CapsWriter

## 回写目标

- #37：补实测数据与拓扑，去掉「路线 3 自研 2–4 人日」（已被插件方案取代）
- #38：标注 SenseVoice 模型其实已下载 229 MB，问题在运行时；改用 CapsWriter 后不再需要
- map #30：B 线完成、A 线（I-beam）完成，剩余只有「重启 DSH 人工确认」

## 收尾复核（2026-11-08 09:11，PC0 侧经 SSH 实测）

- PC0 `reg query "HKCU\Control Panel\Cursors" /v IBeam` → `D:\PC0\cursors\ibeam-dark-halo-48.cur`（已生效）
- PC0 `profiles/desktop/package.json` 仍有 `"dsh-capswriter-speech": "link:D:/PC0/plugins/dsh-capswriter-speech"` 与 bundles 里的同名项
- PC0 `cordis.patch.yml` 的 `url:` 仍是 `ws://192.168.1.38:6016`
- PC1 `reg query ... IBeam` → `D:\tools\cursors\ibeam-dark-halo-48.cur`；`D:/tools/cursors` 四档 + apply 脚本齐全
- PC1 profile：dependencies 含 link 项，bundles 24 项，插件在 `@deepseek-ai/dsh-experimental-voice-input-bundle` 之后（idx=17），junction 有效
- 结论：**两端配置全部就位，唯一未完成项是重启 DSH**（插件在宿主启动时加载，当前 23708/32904 这批进程是 01:10 起的，早于改动）
