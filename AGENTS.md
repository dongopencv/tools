# PC1 工具与工作区

这台机器（台式机 1，DESKTOP-OGBQE3B，192.168.1.38）上长期使用的工具、脚本与工作区相关文件。

## 目录

| 路径 | 用途 |
|---|---|
| `tools/` | 这台机器的工具与脚本（本仓库的主体内容） |
| `elevate/` | 提权辅助脚本（不提交，见 `.gitignore`） |
| `work/` | 临时工作区，大量实验产物（不提交） |
| `out/` | 截图、导出物（不提交） |
| `docs/agents/` | 工程技能（matt pocock skills deck）需要的配置 |

## 本机网络限制（重要）

**`github.com` 的 HTTPS（443）被墙**，直连 100% 超时。可达的只有：

- `api.github.com` — `gh` CLI 走这条，不受影响
- SSH `github.com:22`（约 4/5 成功率）与 `ssh.github.com:443`（5/5）— 这是唯一的 `git push` 通道

因此：

- **`git clone` / `git push` 一律用 SSH**：`git@github.com:owner/repo.git`。HTTPS 写操作在本机三条路全死（直连被墙 / 本地 8899 MITM 反代只读 / 镜像不转发写）。
- 下载 release 资产、raw 文件走网关脚本，别用 `gh release download`：
  `bash C:/Users/Admin/.skills-vault/download/scripts/github.sh asset owner/repo v1.2.3 file.zip -s <sha256>`
- 详见 `C:\Users\Admin\.skills-vault\download\SKILL.md` 的「GitHub 唯一入口」一节。

## 实测网络速度（2026-11-06）

上行 140–200 KB/s，下行同时段约 90 KB/s。20 MB 的 push 约 1.5–2.5 分钟。**大于 50 MB 的东西不要用 git push 传**，改用 release 资产。

## Agent skills

### Issue tracker

Issues live as GitHub issues in `dongopencv/tools`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.
