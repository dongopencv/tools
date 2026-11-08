11. **「链路不通」与「没有授权」必须分开报**（[#5 GitHub 网关与 gh CLI 落地](https://github.com/dongopencv/tools/issues/5)）——
    判据很硬：**403 且响应头出现 `X-Accepted-Github-Permissions: ...=write` → 授权问题；超时/连不上 → 链路问题。**
    两类混一起会把「补个勾」误判成「要换通道」，白折腾一天。
    同一轮还确认：只要 SSH 报 `Permission denied (publickey)`，就是账号上没有这把公钥，只能人去
    https://github.com/settings/keys 加回；改 `~/.ssh/config` 无用。细粒度 PAT 读/写不了账号级公钥（403）。

12. **同一个脚本不许留两份实现，哪怕其中一份「只是旧一点」。**
    `tools/github.sh` 的真身在仓库，`skills-vault` 里那份 2026-11-07 收敛成了转发器（29 行，逻辑只有定位 + `exec` 那 10 行；
    执行时 `exec` 到真身，可用 `GITHUB_GATEWAY` 覆盖）。判据：文档里出现的每个入口，都必须能 `exec` 到同一份实现；
    否则两份会各自长 bug（旧副本至今带着 `sha256sum "$out"` 那条反斜杠 bug）。
    附带一条实测：MSYS bash 里 `ln -s <绝对路径>` **不建符号链接、而是复制实体文件**，所以收敛只能靠转发脚本。

13. **写正文一律 `-F body=@file`，禁止内联。**
    2026-11-08 的事故就是内联造成的：`-f body="$(cat body.md)"` 让 shell 把正文当命令再执行一遍，
    正文里的反引号被跑掉、把本地 token 文件的内容写进了公开仓库的评论，GitHub 侧随即作废了那枚 token。
    这类事故没有中间态：一条命令写错，代价是整条写通道停摆。现已固化成 `tools/credential-gate.sh`
    （`--text` / `--staged` / `--install`）与 `.git/hooks/{pre-commit,commit-msg}`，被拦时不要 `--no-verify` 糊过去。
