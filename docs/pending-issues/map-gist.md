11. **「链路不通」与「没有授权」必须分开报**（[#5 GitHub 网关与 gh CLI 落地](https://github.com/dongopencv/tools/issues/5)）——
    2026-11-08 实测推翻第 9 条的「只读，写仍只能 SSH」：`git -c http.proxy=http://127.0.0.1:8899 -c http.sslVerify=false
    -c http.extraheader="Authorization: Basic <base64(x-access-token:TOKEN)>" ls-remote https://github.com/dongopencv/tools.git HEAD`
    返回真实 SHA，**HTTPS 写通路过 relay 是活的**；同形态 `push` 报 403，原因是细粒度 PAT 缺 `Contents: Read and write`，
    不是链路坏。判据：403 且响应头出现 `X-Accepted-Github-Permissions: ...=write` → 授权问题；
    超时/连不上 → 链路问题。两类混一起会把「补个勾」误判成「要换通道」，白折腾一天。
    同一轮还确认：账号 `/users/dongopencv/keys` 数量为 0，SSH 通道**不是配置问题而是公钥被移除**，只能人去网页加回。

12. **同一个脚本不许留两份实现，哪怕其中一份「只是旧一点」。**
    `tools/github.sh` 的真身在仓库，`skills-vault` 里那份 2026-11-07 收敛成了转发器（29 行，逻辑只有定位 + `exec` 那 10 行；
    执行时 `exec` 到真身，可用 `GITHUB_GATEWAY` 覆盖）。判据：文档里出现的每个入口，都必须能 `exec` 到同一份实现；
    否则两份会各自长 bug（旧副本至今带着 `sha256sum "$老家"` 那条反斜杠 bug）。
    附带一条实测：MSYS bash 里 `ln -s <绝对路径>` **不建符号链接、而是复制实体文件**，所以收敛只能靠转发脚本。

13. **泄漏凭据的处理顺序：先删公开副本，再轮换，最后才谈历史改写。**
    2026-11-08 的实例：用 shell 内联正文发评论，反引号被命令替换执行，把 token 明文写进**公开仓库**的评论
    `6710513283`；GitHub secret scanning 在 2 秒后（`2026-11-07T17:14:17Z`）开告警并**自动吊销**了那枚 token，
    连带账号上的 SSH 公钥也被清空。教训有两条：一是**任何含代码块的正文一律 `-F body=@file`，禁止内联**，
    这条已固化成 `tools/issue-closeout.sh` 与 `AGENTS.md` 的脚本闸门；二是**吊销是自动化发生的，
    不是人手动删的**——查「谁动了我的 token」时先查 secret scanning 告警，别先怀疑人。
    同轮实测：本机无任何缓存凭据可兜底（无 credential helper、`cmdkey` 无 github 项、`hosts.yml` 无 oauth_token、
    环境变量里没有 `GH_`/`GITHUB_`），所以「等它自己恢复」这条路不存在，恢复必须有人在网页上操作。
