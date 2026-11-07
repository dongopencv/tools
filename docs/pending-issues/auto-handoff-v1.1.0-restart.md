# dsh-auto-handoff v1.1.0：待重启验证 + 待补票

代码与文档已改完（D:/tools/dsh-auto-handoff，版本 1.1.0），离线测试全绿，真实会话探针跑通。
**但现网 DSH 仍加载旧模块**（Node ESM 缓存），必须重启桌面版 DSH 才生效。

## 重启后按这个顺序核验（四条，任一失败说明新代码没加载）

1. 新生成的交接文档里有 "## 交接前 REVIEW" 一节（现在是 0/8 份）。
2. auto-handoff.log 里出现 "已交接：… → session-…"，而不是停在 "已跳过注入型 user/message"。
3. 新会话的首条 assistant 输出引用交接文档里的「下一步」。
4. 空壳会话不再涨：数一下 C:/Users/Admin/.dsh/sessions/--D-proj-PC1--/ 下的目录数，30 分钟内不再增长（重启前 675 → 1001）。

## 待补的票（凭据恢复后）

- #46（打通简报投递）：四条验收的 ①②④ 已由本轮修复覆盖，③ 杀进程后占位仍有效由 claims.json 覆盖。重启验证通过后可写 resolution 并 close。
- #15（检测强制执行）：新增证据——现网空壳会话 675→1001，根因是失败即删除占位；已修为 failed + 冷却 + 次数上限。
- #29（交接文档结构定稿）：本轮先给了六节结构与「落盘全文 / 注入裁剪」分离，字段级定稿仍待这张票。
- 地图 #12：进度一节需补 v1.1.0 这一轮。

## 仍然做不到的事

- deck_ 全部报 backend-unsupported / repo.refId missing: pc1；gh api user → 401 Bad credentials。
- 公钥已从账号移除（GET /users/dongopencv/keys → []），git push 不可用，本轮提交只能留在本地。
