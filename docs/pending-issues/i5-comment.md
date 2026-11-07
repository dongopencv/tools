## Resolution 补充（2026-11-07）：vault 副本已收敛成转发器

上一轮把这条记成「另一处未收敛」，现在收敛完了。

### 做法

`C:/Users/Admin/.skills-vault/download/scripts/github.sh` 从 421 行实现换成 **转发器**（29 行 / 1099 B，逻辑只有下面这 10 行，其余是注释）：

```bash
#!/usr/bin/env bash
set -euo pipefail
self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
candidates=("${GITHUB_GATEWAY:-}" "$HOME/proj/PC1/tools/github.sh" "/d/proj/PC1/tools/github.sh" "/D/proj/PC1/tools/github.sh")
for c in "${candidates[@]}"; do
  [[ -n "$c" && -f "$c" ]] && exec bash "$c" "$@"
done
echo "[fail] 找不到 github.sh 真身（设 GITHUB_GATEWAY 指向 D:/proj/PC1/tools/github.sh）" >&2
exit 1
```

旧文件备份成同目录 `github.sh.bak-2026-11-07-pre-shim`（16555 B / 421 行）。

### 为什么不建符号链接

试过：在这个 MSYS bash 里 `ln -s <绝对路径> <name>` **不建链接、而是把目标复制成实体文件**
（探测文件 46822 B，和仓库副本一样大）。所以只能用转发脚本。

### 验证

| 入口 | 结果 |
|---|---|
| `bash <vault>/scripts/github.sh status` | 全绿：gh 2.103.3 / token 41 B / api 认证 dongopencv / 各镜像可达 / SSH 22+443 都认证成功 |
| `... api repos/dongopencv/tools --jq .full_name` | `dongopencv/tools` |
| `~/.dsh/skills`（整根 junction） | 同一真身 |
| `~/.trae-cn/skills`（整根 junction） | 同上 |
| `~/.workbuddy/skills`（整根 junction） | 同上 |
| 真身不在默认位置 | `GITHUB_GATEWAY` 覆盖；都不存在时报 `[fail]` 并退出 1 |

三个 junction 都是 reparse point（0xa0000003）指向 `~/.skills-vault` 整根，所以换一处，三家客户端同时生效。

### 附带修掉的坑：SSH 443 的 `~/.ssh/config` 前提

2026-11-07 23:2x 实测 `git push` 报 `Connection reset by 20.205.243.166 port 22`；按文档改走 443，
却得到 `git@ssh.github.com: Permission denied (publickey)`。

原因：`~/.ssh/config` 只有 `Host github.com` 一段，`ssh.github.com` 不匹配任何 Host → 不带 `IdentityFile`。补上：

```
Host ssh.github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519_gh
  IdentitiesOnly yes
```

补完后 `ssh -T git@ssh.github.com` 与 `ssh -T git@github.com` 都是 authenticated，普通 `git push origin master` 也恢复正常。

### 落地提交

- `72133ac` docs: 收敛 vault 侧 github.sh 为转发器，单真身落在本仓库
- `ef6e6e7` docs: 补 SSH 443 的 `~/.ssh/config` 前提（Host ssh.github.com 段）

改到的文件：`AGENTS.md`、`tools/README.md`（「这份脚本与 skills-vault 里那份的关系」整节重写）、
`docs/network-baseline.md` 第三节；vault 侧 `SKILL.md` 同步（`scripts/github.sh` 那行改成「转发器」，
新增「只有一份实现」说明与 `## 变更记录` 条目）。