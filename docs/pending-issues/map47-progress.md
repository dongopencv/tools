# map #47 正文追加：把 #49 的真实状态写进正文

> 归属：决策图 #47（wayfinder:map）。wayfinder 硬要求「结束前把这张票的真实状态写进正文」，
> 但 2026-11-08 01:16 起票库写操作中断，正文 PATCH 做不了。恢复后照下面执行。

## 要追加到 `## 进度` 末尾的内容

```markdown
- 2026-11-08 02:2x：**#49 交付物落地**。语音转写整理成 `docs/intake/`：
  `README.md` 定五段写法（原话 / 校正 / 实际需求 / 归属 / 待确认），
  `2026-11-07-voice-intake.md` 把那段话拆成九簇，每簇标注原话、校正依据、归属票号、待确认问题。
  捞出的同音词 8 个记在附表（IP 返代→反向代理、TREE CONNECT→`dsh-connect-trae`、
  WORK BABY CONNECT→`dsh-connect-workbuddy`、XD→`dsh-xdpool`、SQ→skill、MATT→`dsh-mattpocock-skills-deck`），
  「仓 CUDA」「OCI 点」两个无上下文，**如实标未定，没有硬猜**。
  末尾 7 条待确认按优先级排，第 1 条（"看不见的水印"是盲水印还是低对比度可见水印）
  不拍板则 #54 无法开工。
- 2026-11-08：**票库写操作中断一晚，已恢复**。本图 9 张子票全部建完且边已校验，
  那是中断之前做的；中断期间没有任何票库写操作。
  `deck_map_link` 另有一个与身份无关的 refId 缺陷（见独立缺陷票草稿）。
  **未推送提交 10 个，全在本机 master 上，`git push` 即可。**
```

## 执行

```bash
gh api repos/dongopencv/tools/issues/47 --jq .body > /tmp/i47.md
# 把上面那段贴到 /tmp/i47.md 的 "## 进度" 节末尾，然后：
gh api -X PATCH repos/dongopencv/tools/issues/47 -F body=@/tmp/i47.md
# 注意：本机前台跑这条会挂，放到后台（run_in_background）才成功 —— 2026-11-08 实测 7271 字节那次就是后台成的
gh api repos/dongopencv/tools/issues/47 --jq .body | wc -c   # 核对字节数变大
```

## 顺带要做的（同一批）

- #49 现在有交付物了，但**票本身留在 open**：它是 grilling 票，用户还没逐条确认那 7 个待确认问题。
  **不要替用户关它**——关票是用户的确认动作，不是 agent 的。
- 确认完之后：#49 可以 close，然后 #50–#57 里凡是"待确认"依赖 #49 结论的，把答案补进各自正文。
