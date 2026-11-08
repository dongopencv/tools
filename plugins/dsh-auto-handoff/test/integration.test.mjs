/**
 * 离线集成测试：用假的 Cordis 上下文驱动插件，验证
 *   1) 阈值未达不触发
 *   2) 工具调用阈值触发 → 写文档 + 开新会话 + 投递消息
 *   3) token 阈值触发
 *   4) 同一会话只交接一次
 *   5) 链深度上限生效
 *   6) 模型摘要缺失时走兜底
 *   7) 交接失败不影响主轮（监听里不抛）
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

let failures = 0
const results = []

function makeCtx(state) {
  const handlers = new Map()
  const commands = []
  return {
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
    },
    emit(name, ...args) {
      for (const fn of handlers.get(name) ?? []) fn(...args)
    },
    get(key) {
      return state.services[key]
    },
    get sessions() {
      return state.services.sessions
    },
    get commands() {
      return {
        register(definition) {
          commands.push(definition)
          return () => {}
        },
      }
    },
    _commands: commands,
    _handlers: handlers,
  }
}

function buildSession(id, cwd, header, events) {
  return {
    id,
    header: { version: 1, id, createdAt: 0, cwd, isSeeded: false, origin: header.origin, agentPreset: header.agentPreset },
    ownEvents: () => events,
    requestContext: () => header.requestContext,
    requestHeader: () => (header.requestContext === undefined ? undefined : { config: header.requestContext }),
  }
}

function makeServices(options) {
  const created = []
  const prompts = []
  const cancelled = []
  // v1.2 的人工停点靠 sessionController.rename 落到 GUI 标题上（票 #18）：
  // 链到顶、REVIEW 未通过、排队中、孤儿这四类如果只写日志，人在侧栏认不出来。
  const renamed = []
  return {
    created,
    prompts,
    cancelled,
    renamed,
    services: {
      sessions: {
        get: (id) => options.sessions.get(String(id)),
      },
      tokenMeter: {
        measure: (session) => ({ totalTokens: options.tokensFor(String(session.id)) }),
      },
      sessionTitle: { get: () => ({ title: '测试任务' }) },
      workingDirectory: { get: (session) => session.header.cwd },
      llm: options.llm,
      sessionController: {
        create: async (request) => {
          const id = 'sess-new-' + String(created.length + 1)
          created.push({ id, cwd: request.cwd })
          return { sessionId: id }
        },
        // 真实签名是 prompt(request, signal)，宿主实现第一行就 signal.throwIfAborted()。
        // 假件必须同样严格，否则「少传 signal」这类契约 bug 100% 漏测
        // （这正是 0/86 简报送达的真因，旧假件写的是单参数、永不抛）。
        prompt: async (request, signal) => {
          if (signal === undefined || signal === null || typeof signal.throwIfAborted !== 'function') {
            throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
          }
          signal.throwIfAborted()
          // 宿主在会话已被关掉时会拒收；用来验证「孤儿会话」这条失败路径。
          if (options.promptFails === true) throw new Error('session/not-found')
          prompts.push(request)
          return { accepted: true }
        },
        // 宿主 rename({ sessionId, title }) → { title, seq }
        rename: async (request) => {
          renamed.push({ sessionId: request.sessionId, title: request.title })
          return { title: request.title, seq: renamed.length }
        },
        // 宿主 cancel({ sessionId }) → { accepted: true }；会话已 detach 时抛 session/not-found。
        cancel: async (request) => {
          cancelled.push(request.sessionId)
          return { accepted: true }
        },
      },
    },
  }
}

function toolCallEvent(turn, step, index, name, args) {
  return {
    type: 'tool/call',
    seq: index,
    time: 0,
    data: { turn, step, callId: 'c' + String(index), name, arguments: JSON.stringify(args) },
  }
}

function userEvent(text, seq, kind) {
  const data = { role: 'user', content: [{ type: 'text', text }], id: 'm' + String(seq) }
  // 真实宿主给每条 user/message 带 data.source.kind：人打的 是 'user'，
  // 其余（system-reminder / runtime-context / skill-catalog …）都是注入。
  // 不传 kind 时故意不写 source，用来覆盖「没有 source 字段时走前缀白名单兜底」这条旧路径。
  if (kind !== undefined) data.source = { kind }
  return { type: 'user/message', seq, time: 0, data }
}

function assistantEvent(text, seq) {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], id: 'a' + String(seq) }, stream: [] },
  }
}

/**
 * 把真实源码复制到临时目录，只把 schemastery 的 import 换成内置桩。
 * 这样做的好处是：测试跑的是真实实现，又不需要在包目录里塞 node_modules
 * （塞了会污染宿主对 schemastery 的真实解析）。
 */
async function loadPluginUnderTest() {
  const source = await readFile(join(process.cwd(), 'lib', 'index.js'), 'utf8')
  const rewritten = source.replace(
    "import z from '@deepseek-ai/schemastery'",
    'const z = globalThis.__SCHEMASTERY_STUB__',
  )
  assert.notEqual(rewritten, source, '测试需要能替换掉 schemastery 的 import')

  // 简易链式桩：.step/.min/.max/.default/.description 全部返回自身。
  const chainable = () => {
    const node = {}
    node.step = () => node
    node.min = () => node
    node.max = () => node
    node.default = () => node
    node.description = () => node
    node.role = () => node
    return node
  }

  globalThis.__SCHEMASTERY_STUB__ = {
    object: (fields) => fields,
    boolean: chainable,
    number: chainable,
    string: chainable,
    // v1.2 的 reviewBlockOn 是字符串数组；链式桩同样返回自身。
    array: () => chainable(),
  }

  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-module-'))
  const file = join(dir, 'index.mjs')
  await writeFile(file, rewritten, 'utf8')
  // index.js 现在把占位表拆到了 ./claims.js，临时目录里也要有一份同目录副本，
  // 否则相对 import 解析失败，测试根本加载不起来。
  const claimsSource = await readFile(join(process.cwd(), 'lib', 'claims.js'), 'utf8')
  await writeFile(join(dir, 'claims.js'), claimsSource, 'utf8')
  // v1.2 把文档渲染拆到了 ./docs.js（三份文件：index.md / facts.jsonl / full.md），
  // 临时目录里没有它 import 直接失败。
  const docsSource = await readFile(join(process.cwd(), 'lib', 'docs.js'), 'utf8')
  await writeFile(join(dir, 'docs.js'), docsSource, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  return mod
}

async function scenario(options) {
  const { plugin, name, tokens, toolCalls, chainDepth, modelText, extra, injectUser, cancelParent, manual, promptFails, claimSeed, maxConcurrentHops, noFirstUser } = options
  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-test-'))
  // 链账本住在 ~/.dsh/auto-handoff/state.json（用户主目录），不是工作区。
  // 测试必须把 USERPROFILE 指到临时目录，否则会读写真实账本并互相污染。
  const previousHome = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  if (chainDepth !== undefined && chainDepth > 0) {
    await mkdir(join(dir, '.dsh', 'auto-handoff'), { recursive: true })
    const map = { sessions: { 'sess-a': { root: 'sess-a', depth: chainDepth } }, updatedAt: 'now' }
    await writeFile(join(dir, '.dsh', 'auto-handoff', 'state.json'), JSON.stringify(map), 'utf8')
  }
  // 有些场景必须先把占位表铺好（并发上限、deferred 到期重试），
  // 否则测的就不是那条分支，而是「第一次交接」。
  if (claimSeed !== undefined) {
    const claims = typeof claimSeed === 'function' ? claimSeed(dir) : claimSeed
    await mkdir(join(dir, '.dsh', 'auto-handoff'), { recursive: true })
    await writeFile(
      join(dir, '.dsh', 'auto-handoff', 'claims.json'),
      JSON.stringify({ claims, updatedAt: 'now' }),
      'utf8',
    )
  }

  // noFirstUser 用来构造「链上第一句话不是用户指令」这种脏现场，
  // 它是 REVIEW no-goal 的唯一触发条件，也是最容易在真实链上传下去的病。
  const events = noFirstUser === true ? [] : [userEvent('把 F:\\proj 下的构建脚本改成跨平台', 1)]
  if (injectUser !== undefined) events.push(userEvent(injectUser, 99))
  let seq = 2
  for (let i = 0; i < toolCalls; i += 1) {
    const targetFile = i % 2 === 0 ? 'F:\\proj\\build.ps1' : 'F:\\proj\\README.md'
    events.push(toolCallEvent(1, 1, seq, 'write', { file_path: targetFile, content: 'x' }))
    seq += 1
  }
  events.push(assistantEvent('已完成第一阶段改造。', seq))

  const sessions = new Map()
  // 提供模型路线，插件才会走「模型摘要」路径；不提供则验证兜底路径。
  const sessionHeader = modelText === undefined ? {} : { requestContext: { provider: 'test-provider', model: 'test-model' } }
  sessions.set('sess-a', buildSession('sess-a', dir, sessionHeader, events))

  const llmRequests = []
  const llm =
    modelText === undefined
      ? undefined
      : {
          async *stream(request) {
            // 记下请求参数：maxTokens 必须随 summaryMaxChars 缩放，
            // 否则中文摘要在第三节中途被输出预算截断（「下一步」整节消失的第四个来源）。
            llmRequests.push(request)
            yield { type: 'text-delta', index: 0, text: modelText }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }

  const harness = makeServices({
    sessions,
    tokensFor: () => tokens,
    llm,
    promptFails: promptFails === true,
  })

  // 允许某个场景故意破坏依赖，验证降级路径。
  if (extra !== undefined && typeof extra === 'object') Object.assign(harness.services, extra.services ?? {})

  const ctx = makeCtx(harness)
  plugin.apply(ctx, {
    enabled: true,
    tokenThreshold: 300000,
    toolCallThreshold: 80,
    handoffDir: '.dsh/handoff',
    modelSummary: modelText !== undefined,
    maxAutoHops: 8,
    summaryMaxChars: 1600,
    briefMaxChars: 6000,
    summaryTimeoutMs: 45000,
    maxTrackedFiles: 40,
    maxConcurrentHops: maxConcurrentHops === undefined ? 2 : maxConcurrentHops,
    // 不传时走 DEFAULTS 的 readBool 兜底（= true），这样默认行为也被测到。
    cancelParentAfterHandoff: cancelParent,
  })

  // 灌入工具调用事件（插件靠 session/event 计数）
  for (const event of events) {
    if (event.type === 'tool/call') ctx.emit('session/event', sessions.get('sess-a'), event)
  }

  if (manual === true) {
    // 手动路径：直接调 /handoff 的 handler（与用户敲命令等价）。
    const command = ctx._commands.find((item) => item.name === 'handoff')
    await command.handler({ agent: { id: 'sess-a' }, signal: new AbortController().signal })
  } else {
    // 触发一轮结束
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
  }
  // 异步交接，等一下
  await new Promise((resolve) => setTimeout(resolve, 300))

  // v1.2：一份交接变成三份文件，注入的是 <sessionId>/index.md，
  // full.md 是人看的完整版，facts.jsonl 是机读档案。
  const docsDir = join(dir, '.dsh', 'handoff', 'sess-a')
  const docPath = join(docsDir, 'index.md')
  const fullPath = join(docsDir, 'full.md')
  const factsPath = join(docsDir, 'facts.jsonl')
  let doc
  let full
  let facts
  try {
    doc = await readFile(docPath, 'utf8')
    full = await readFile(fullPath, 'utf8')
    facts = await readFile(factsPath, 'utf8')
  } catch {
    doc = undefined
  }

  // 占位表的最终状态要能断言：新会话必须是 genesis（可继续交接），
  // 写 done 会让链停在第二棒、chainLimit 永远不生效。
  let claims
  try {
    claims = JSON.parse(await readFile(join(dir, '.dsh', 'auto-handoff', 'claims.json'), 'utf8')).claims
  } catch {
    claims = undefined
  }

  // 结构化事件也是产品的一部分（票 #20）：没有它，现网复盘只能靠人读 809 行中文日志。
  let events_
  try {
    events_ = (await readFile(join(dir, '.dsh', 'auto-handoff', 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
  } catch {
    events_ = []
  }

  // chain.json 在临时目录里，scenario 一返回就删了，必须在这里读出来。
  let chainJson
  try {
    chainJson = JSON.parse(await readFile(join(dir, '.dsh', 'auto-handoff', 'chains', 'sess-a.json'), 'utf8'))
  } catch {
    chainJson = undefined
  }

  const record = {
    name,
    dir,
    docPath,
    doc,
    full,
    facts,
    created: harness.created,
    prompts: harness.prompts,
    cancelled: harness.cancelled,
    renamed: harness.renamed,
    commands: ctx._commands,
    ctx,
    events,
    events_,
    claims,
    chainJson,
    llmRequests,
  }
  if (previousHome === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousHome
  await rm(dir, { recursive: true, force: true })
  return record
}

async function run() {
  const plugin = await loadPluginUnderTest()
  assert.equal(typeof plugin.apply, 'function', 'apply must exist')
  assert.equal(typeof plugin.name, 'string', 'name must exist')

  // 1) 阈值未达：不写文档、不开会话
  {
    const r = await scenario({ plugin, name: 'below-threshold', tokens: 1000, toolCalls: 50, modelText: '摘要' })
    assert.equal(r.doc, undefined, '未达阈值不应写文档')
    assert.equal(r.created.length, 0, '未达阈值不应新建会话')
    assert.equal(r.prompts.length, 0, '未达阈值不应投递消息')
    results.push('PASS 阈值未达不触发')
  }

  // 2) 工具调用阈值触发
  {
    const r = await scenario({ plugin, name: 'tool-threshold', tokens: 1000, toolCalls: 80, modelText: '## 进度概述\n已改好构建脚本。\n\n## 下一步\n1. 跑一遍测试' })
    assert.ok(r.doc !== undefined, '达工具阈值应写文档')
    assert.equal(r.created.length, 1, '应新建一个会话')
    assert.equal(r.prompts.length, 1, '应向新会话投递一条消息')
    assert.match(r.doc, /# 交接简报/, 'index.md 应有标题行')
    assert.match(r.doc, /## 目标/, 'index.md 第一节应是「目标」')
    assert.match(r.doc, /## 下一步/, 'index.md 必须有「下一步」一节')
    assert.match(r.doc, /把 F:\\proj 下的构建脚本改成跨平台/, '文档应含原始用户指令')
    assert.match(r.doc, /跑一遍测试/, '文档应含模型摘要的下一步')
    assert.match(r.facts, /build\.ps1/, 'facts.jsonl 应含触及文件')
    // 六节顺序即裁剪优先级：「目标」「下一步」必须排在最前面的两节
    const order = ['## 目标', '## 下一步'].map((title) => r.doc.indexOf(title))
    assert.ok(order[0] >= 0 && order[0] < order[1], '「目标」必须排在「下一步」之前')
    for (const line of r.facts.trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line), 'facts.jsonl 每一行都必须是合法 JSON')
    }
    assert.equal(r.prompts[0].sessionId, r.created[0].id, '消息应投给新会话')
    assert.match(r.prompts[0].content[0].text, /交接文档开始/, '消息里应内嵌交接文档')
    // 占位语义：父会话 done（不再自动交接），新会话 genesis（可继续交接，链条才走得下去）
    assert.equal(r.claims?.['sess-a']?.state, 'done', '父会话应记为 done')
    assert.equal(r.claims?.[r.created[0].id]?.state, 'genesis', '新会话应记为 genesis 而不是 done')
    assert.equal(r.claims?.[r.created[0].id]?.chainDepth, 1, '新会话链深应为 1')
    assert.equal(r.claims?.['sess-a']?.chainDepth, 0, '父会话链深应为 0')
    // 接力棒交出去之后，父会话必须停：它不会自己停，实测会继续跑 70 分钟、和子会话同时烧 token。
    assert.deepEqual(r.cancelled, ['sess-a'], '自动交接后应取消父会话当前轮')
    results.push('PASS 工具调用阈值触发交接（占位：父 done / 新 genesis、链深 +1、父会话被取消）')
  }

  // 2b) 关掉 cancelParentAfterHandoff：退回「不打扰旧会话」的旧行为
  {
    const r = await scenario({
      plugin,
      name: 'no-cancel-parent',
      tokens: 300000,
      toolCalls: 5,
      modelText: '摘要',
      cancelParent: false,
    })
    assert.equal(r.created.length, 1, '仍应新建会话')
    assert.deepEqual(r.cancelled, [], 'cancelParentAfterHandoff=false 时不应取消父会话')
    results.push('PASS cancelParentAfterHandoff=false 时不取消父会话')
  }

  // 2c) 手动 /handoff 不能取消父会话：调用方就是它自己，取消会打断用户正在执行的命令
  {
    const r = await scenario({ plugin, name: 'manual', tokens: 300000, toolCalls: 5, modelText: '摘要', manual: true })
    assert.equal(r.created.length, 1, '手动交接应新建会话')
    assert.deepEqual(r.cancelled, [], '手动 /handoff 不应取消父会话')
    results.push('PASS 手动 /handoff 不取消父会话')
  }

  // 3) token 阈值触发
  {
    const r = await scenario({ plugin, name: 'token-threshold', tokens: 300000, toolCalls: 0, modelText: '## 下一步\n继续' })
    assert.ok(r.doc !== undefined, '达 token 阈值应写文档')
    assert.equal(r.created.length, 1, '应新建一个会话')
    results.push('PASS token 阈值触发交接')
  }

  // 3b) 长摘要：模型把「下一步」写在第三节，超过 summaryMaxChars 后也不能丢
  //     旧实现 clamp(1600) 一刀切，实测 8 份真实交接文档里 4 份整节丢掉「下一步」，
  //     新会话据此开工却无路可走。这里固定住修法：按节重排 + 只在末尾裁剪。
  {
    const filler = '已完成若干阶段的排查与修复。'.repeat(180) // ≈ 1800 字
    const modelText = '## 进度概述\n' + filler + '\n\n## 关键决定与坑\n' + filler + '\n\n## 下一步\n先跑 KEYWORD_NEXT_STEP 再收尾'
    assert.ok(modelText.length > 1600, '构造的摘要必须超过 summaryMaxChars')
    const r = await scenario({ plugin, name: 'long-summary', tokens: 300000, toolCalls: 5, modelText })
    assert.ok(r.doc !== undefined, '应写文档')
    assert.match(r.full, /## 下一步/, '长摘要被裁剪后 full.md 的「下一步」仍须存在')
    assert.match(r.full, /KEYWORD_NEXT_STEP/, 'full.md 里「下一步」的正文不能被裁掉')
    assert.match(r.doc, /## 下一步/, 'index.md 必须有「下一步」一节')
    assert.match(r.doc, /KEYWORD_NEXT_STEP/, 'index.md 里「下一步」也要带上正文')
    // 注入给新会话的那一份（受 docMaxChars 限制）同样不能丢
    const injected = r.prompts[0].content[0].text
    assert.match(injected, /## 下一步/, '注入副本里也必须有「下一步」')
    assert.match(injected, /KEYWORD_NEXT_STEP/, '注入副本里「下一步」的正文也必须完整')
    // 输出预算必须覆盖中文摘要：1600 字要 2400–3200 token，
    // 写死 1200 会让模型在第三节中途被截断——这是「下一步」消失的第四个来源，
    // 也解释了实测文档里「下一步」只有半句就断（2026-11-08 e2e 实跑证据）。
    const maxTokens = r.llmRequests[0]?.maxTokens
    assert.ok(maxTokens !== undefined, '应当向模型发出摘要请求')
    assert.ok(maxTokens >= 3200, '输出预算必须 >= summaryMaxChars 的中文 token 需求，实际 ' + String(maxTokens))
    results.push('PASS 超长摘要裁剪后仍保留「下一步」')
    results.push('PASS 摘要输出预算随 summaryMaxChars 缩放')
  }

  // 3c) 模型漏写「下一步」：必须用本地兜底补一节，不能交给模型自觉
  {
    const r = await scenario({ plugin, name: 'no-next-step', tokens: 300000, toolCalls: 5, modelText: '## 进度概述\n做了一半。' })
    assert.ok(r.doc !== undefined, '应写文档')
    assert.match(r.doc, /## 下一步/, '模型漏写时应由本地兜底补上「下一步」')
    const injected = r.prompts[0].content[0].text
    assert.match(injected, /## 下一步/, '注入副本同样要有兜底「下一步」')
    results.push('PASS 模型漏写「下一步」时本地兜底补一节')
  }

  // 4) 模型摘要不可用时走兜底
  {
    const r = await scenario({ plugin, name: 'fallback-summary', tokens: 300000, toolCalls: 3, modelText: undefined })
    assert.ok(r.doc !== undefined, '无模型也应写文档')
    {
      // facts.jsonl 是 JSONL：路径里的反斜杠被转义成 \\，不能再拿正则直接匹配原文，
      // 解析后再断言才不会被转义层骗过去。
      const entries = r.facts.trim().split('\n').map((line) => JSON.parse(line))
      assert.ok(
        entries.some((entry) => entry.type === 'user' && entry.text.includes('构建脚本改成跨平台')),
        'facts.jsonl 应有 user 事实条目',
      )
    }
    assert.match(r.doc, /## 下一步/, '没有模型时兜底摘要也必须自带「下一步」一节')
    assert.match(r.doc, /最近一次用户要求|先读取上面列出的文件|未完成的部分/, 'index.md 的「下一步」应是兜底摘要')
    assert.equal(r.created.length, 1, '无模型仍应开新会话')
    results.push('PASS 无模型摘要时用兜底并照常交接')
  }

  // 5) 链深度上限：到顶不是「什么都没发生」，而是三件可见的事（票 #18）
  {
    const r = await scenario({ plugin, name: 'chain-limit', tokens: 300000, toolCalls: 5, chainDepth: 8, modelText: '## 下一步\n继续' })
    assert.ok(r.doc !== undefined, '超链上限仍应写文档')
    assert.equal(r.created.length, 0, '超链上限不应再开新会话')
    // ① 文档自己说清楚为什么停了：人读 index.md 就知道要人工 /handoff
    assert.match(r.doc, /自动续作已到第 9\/8 棒/, 'index.md 的「未决问题」必须写死到顶原因')
    // ② 占位落 stopped 终态。留 inflight 的话 TTL 一过又能再交接，上限形同废纸。
    assert.equal(r.claims?.['sess-a']?.state, 'stopped', '到顶那一棒必须落 stopped 终态')
    assert.equal(r.claims?.['sess-a']?.stoppedReason, 'chain-limit', '停止原因要能查')
    // ③ 会话改名：GUI 侧栏里必须认得出「这一棒到顶了」
    assert.ok(
      r.renamed.some((item) => item.sessionId === 'sess-a' && item.title.startsWith('[链到顶 9/8]')),
      '到顶那一棒必须被改名成 [链到顶 N/M]',
    )
    // ④ 冷数据账本 chain.json：几棒、停没停
    assert.equal(r.chainJson?.stopped, true, 'chain.json 要记「这条链停了」')
    assert.equal(r.chainJson?.limit, 8, 'chain.json 要记上限')
    assert.ok(r.events_.some((e) => e.event === 'chain/limit'), '必须有 chain/limit 结构化事件')
    results.push('PASS 交接链深度上限生效（文档写死原因 + 占位 stopped + 改名 + chain.json）')
  }

  // 5b) REVIEW block：链上第一句话不是用户指令 → 不建会话、父会话落 failed、改名叫人来看
  //     这是 v1.1.5 里**数学上不可能发生**的一条路径（add('block') 命中 0 处），
  //     所以必须专门测：它一旦回归成 warn，脏现场就会被静默递给下一棒。
  {
    const r = await scenario({ plugin, name: 'review-block', tokens: 300000, toolCalls: 5, modelText: '## 下一步\n继续', noFirstUser: true })
    assert.ok(r.doc !== undefined, 'block 也要写文档（人得能看到为什么不交棒）')
    assert.match(r.doc, /交接前 REVIEW/, 'index.md 要记录 REVIEW 结论')
    assert.match(r.doc, /没有捕获到原始目标/, 'block 理由必须写进文档')
    assert.equal(r.created.length, 0, 'REVIEW 未通过时绝不能建新会话')
    assert.equal(r.prompts.length, 0, 'REVIEW 未通过时绝不能投递简报')
    assert.equal(r.claims?.['sess-a']?.state, 'failed', '父会话应落 failed（可重试，不是终态）')
    assert.equal(r.claims?.['sess-a']?.note, 'review-block', '失败原因要能查')
    assert.ok(
      r.renamed.some((item) => item.sessionId === 'sess-a' && item.title.startsWith('[REVIEW 未通过]')),
      'REVIEW 未通过必须在 GUI 上可见',
    )
    assert.ok(r.events_.some((e) => e.event === 'review/verdict' && e.verdict === 'block' && e.blocked === true), '必须留 block 事件')
    results.push('PASS REVIEW block 生效（不建会话 + 父落 failed + 改名可见）')
  }

  // 5c) 同目录并发超限：不是失败，是排队（deferred 非终态，下一轮自动重试）
  {
    const r = await scenario({
      plugin,
      name: 'concurrent-deferred',
      tokens: 300000,
      toolCalls: 5,
      modelText: '## 下一步\n继续',
      maxConcurrentHops: 1,
      // 已有两棒活在同目录：一棒 genesis（随时能再交接）、一棒 inflight。
      claimSeed: (dir) => ({
        'sess-peer-1': { at: Date.now(), attempts: 1, state: 'genesis', cwd: dir, chainRoot: 'sess-peer-1', chainDepth: 1 },
        'sess-peer-2': { at: Date.now(), attempts: 1, state: 'inflight', cwd: dir, chainRoot: 'sess-peer-2', chainDepth: 1 },
      }),
    })
    assert.ok(r.doc !== undefined, '排队也要写文档')
    assert.equal(r.created.length, 0, '并发超限不应再建会话')
    assert.equal(r.claims?.['sess-a']?.state, 'deferred', '应落 deferred 而不是 failed')
    assert.ok((r.claims?.['sess-a']?.deferredUntil ?? 0) > Date.now(), '排队必须有到期时间')
    assert.ok(
      r.renamed.some((item) => item.sessionId === 'sess-a' && item.title.startsWith('[排队交接')),
      '排队状态必须在 GUI 上可见',
    )
    results.push('PASS 同目录并发超限落 deferred（排队 + 改名，不判失败）')
  }

  // 5d) 简报投递失败：新会话已经建出来了但没收到简报 → 孤儿，改名标记，绝不 cancel
  {
    const r = await scenario({ plugin, name: 'orphan', tokens: 300000, toolCalls: 5, modelText: '## 下一步\n继续', promptFails: true })
    assert.equal(r.created.length, 1, '会话已经建出来了')
    assert.equal(r.prompts.length, 0, '简报没投进去')
    assert.equal(r.claims?.['sess-a']?.state, 'failed', '父会话落 failed 可重试')
    const orphanTitle = r.renamed.find((item) => item.sessionId === r.created[0].id)
    assert.ok(orphanTitle !== undefined && orphanTitle.title.startsWith('[孤儿·无简报]'), '孤儿会话必须改名让人认出来')
    assert.deepEqual(r.cancelled, [], '孤儿不 cancel：它可能已经开始干活了')
    results.push('PASS 简报投递失败留下孤儿（改名可见、不 cancel）')
  }

  // 5e) 简报第一行必须是链元信息（票 #18）：人在侧栏只看到标题，
  //     模型看到的第一行就是这个。棒次 / 上限 / 根 / 触发 / 同伴棒五项决定还能不能接着干。
  {
    const r = await scenario({ plugin, name: 'brief-meta', tokens: 300000, toolCalls: 5, modelText: '## 下一步\n继续' })
    const injected = r.prompts[0].content[0].text
    const firstLine = injected.split(String.fromCharCode(10))[0]
    assert.match(firstLine, /^链：第 1 棒 \/ 上限 8/, '简报第一行必须是链元信息，实际：' + firstLine)
    assert.ok(firstLine.includes('同伴棒：'), '必须带上同目录同伴棒数量')
    // 「[自动交接]」这一句也不能丢：下一棒靠它识别「这是交接简报」，
    // 进而去读盘还原真正的原始目标（goal.test.mjs 的 6 层下钻依赖它）。
    assert.ok(injected.includes('[自动交接] 上一会话'), '简报必须保留 [自动交接] 标识')
    assert.ok(injected.indexOf('交接前 REVIEW 结论') > 0, '任何 verdict 都要把 REVIEW 结论写进简报')
    results.push('PASS 简报第一行是链元信息，且保留 [自动交接] 标识与 REVIEW 结论')
  }

  // 5f) 阈值走比例：不传 tokenThreshold 时按 ratio × 窗口换算，
  //     实测窗口 1000000、p25 交接点 45% —— 30% 的绝对值太保守（票 #20）。
  {
    const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-ratio-'))
    const previousHome = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    const sessions = new Map()
    sessions.set(
      'sess-a',
      buildSession('sess-a', dir, { requestContext: { provider: 'p', model: 'm', contextWindow: 1000000 } }, [
        userEvent('目标', 1),
        assistantEvent('做到一半。', 2),
      ]),
    )
    // 40% 窗口：低于默认 45%，不该触发
    const low = makeServices({ sessions, tokensFor: () => 400000, llm: undefined })
    const ctxLow = makeCtx(low)
    plugin.apply(ctxLow, { enabled: true, modelSummary: false, toolCallThreshold: 80 })
    ctxLow.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(low.created.length, 0, '40% 窗口不应触发（默认 45%）')

    // 50% 窗口：高于 45%，应当触发
    const high = makeServices({ sessions, tokensFor: () => 500000, llm: undefined })
    const ctxHigh = makeCtx(high)
    plugin.apply(ctxHigh, { enabled: true, modelSummary: false, toolCallThreshold: 80 })
    ctxHigh.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(high.created.length, 1, '50% 窗口应触发（默认 45%）')

    if (previousHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome
    await rm(dir, { recursive: true, force: true })
    results.push('PASS 阈值按窗口比例换算（40% 不触发 / 50% 触发）')
  }

  // 5g) tokenMeter 缺失：不能静默按 0 处理（那会让 token 闸永远不响），
  //     必须留下可查的降级证据，并且仍靠工具调用闸工作。
  {
    const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-notokens-'))
    const previousHome = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    const events = [userEvent('目标', 1), assistantEvent('做到一半。', 2)]
    for (let i = 0; i < 5; i += 1) events.push(toolCallEvent(1, 1, i + 3, 'read', { file_path: 'D:\\a\\b.ts' }))
    const sessions = new Map()
    sessions.set('sess-a', buildSession('sess-a', dir, {}, events))
    const harness = makeServices({ sessions, tokensFor: () => 300000, llm: undefined })
    harness.services.tokenMeter = undefined
    const ctx = makeCtx(harness)
    plugin.apply(ctx, { enabled: true, modelSummary: false, toolCallThreshold: 80 })
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 250))

    const statusHandler = ctx._commands.find((item) => item.name === 'handoff-status')
    const statusText = (await statusHandler.handler({ agent: { id: 'sess-a' }, signal: new AbortController().signal })).text
    assert.match(statusText, /token 读数不可信/, '/handoff-status 必须如实报告 token 读数不可信')

    let events_
    try {
      events_ = (await readFile(join(dir, '.dsh', 'auto-handoff', 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    } catch {
      events_ = []
    }
    assert.ok(
      events_.some((e) => e.event === 'gate/skip' && String(e.reason).startsWith('token-unavailable')),
      'tokenMeter 缺失必须落一条 gate/skip 事件，而不是静默',
    )
    if (previousHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome
    await rm(dir, { recursive: true, force: true })
    results.push('PASS tokenMeter 缺失时显式降级留痕（事件 + /handoff-status）')
  }

  // 5h) 结构化事件：一次成功交接必须留下可复盘的九类决策点，
  //     而不是 809 行中文日志里靠人 grep（票 #20）。
  {
    const r = await scenario({ plugin, name: 'events', tokens: 300000, toolCalls: 5, modelText: '## 下一步\n继续' })
    const kinds = new Set(r.events_.map((e) => e.event))
    for (const kind of ['review/verdict', 'doc/write', 'session/create', 'prompt/deliver', 'claim/settle']) {
      assert.ok(kinds.has(kind), '缺少结构化事件 ' + kind)
    }
    const done = r.events_.find((e) => e.event === 'claim/settle' && e.state === 'done')
    assert.ok(done !== undefined, '必须有一条 claim/settle done')
    for (const key of ['at', 'sessionId', 'cwd', 'trigger', 'tokens', 'toolCalls', 'depth', 'docPath', 'newSessionId', 'reviewVerdict', 'outcome']) {
      assert.ok(Object.prototype.hasOwnProperty.call(done, key), 'claim/settle 事件缺字段 ' + key)
    }
    // toolCalls 必须记闸门用的那个数（与本轮累计计数一致），不能记 facts.toolCalls——
    // 两个数对不上，等于没法复盘「到底哪个闸把它推过线的」。
    assert.equal(done.toolCalls, 5, '事件里的 toolCalls 应是闸门计数')
    results.push('PASS 结构化事件覆盖五个决策点且字段齐全')
  }

  // 6) 同一会话只交接一次：连发两次 turn-stopping，只应新建一个会话
  {
    const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-once-'))
    // 占位表住在 ~/.dsh/auto-handoff/claims.json，必须隔离到临时目录，
    // 否则上一场景写下的 sess-a=done 会把这一场景挡住（测试互相污染）。
    const previousHome = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    const events = [userEvent('目标：修 bug', 1)]
    for (let i = 0; i < 90; i += 1) events.push(toolCallEvent(1, 1, i + 2, 'read', { file_path: 'D:\\a\\b.ts' }))
    const sessions = new Map()
    sessions.set('sess-a', buildSession('sess-a', dir, { requestContext: { provider: 'p', model: 'm' } }, events))
    const harness = makeServices({ sessions, tokensFor: () => 1000, llm: undefined })
    const ctx = makeCtx(harness)
    plugin.apply(ctx, {
      enabled: true,
      tokenThreshold: 300000,
      toolCallThreshold: 80,
      handoffDir: '.dsh/handoff',
      modelSummary: false,
      maxAutoHops: 8,
      summaryMaxChars: 1600,
      briefMaxChars: 6000,
      summaryTimeoutMs: 45000,
      maxTrackedFiles: 40,
    })
    for (const event of events) if (event.type === 'tool/call') ctx.emit('session/event', sessions.get('sess-a'), event)
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 250))
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 2, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(harness.created.length, 1, '同一会话只应交接一次')
    assert.equal(harness.prompts.length, 1, '同一会话只应投递一次')
    if (previousHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome
    await rm(dir, { recursive: true, force: true })
    results.push('PASS 同一会话只交接一次')
  }

  // 7) 缺少 sessionController：只写文档，不抛异常
  {
    const r = await scenario({
      plugin,
      name: 'no-controller',
      tokens: 300000,
      toolCalls: 5,
      modelText: undefined,
      extra: { services: { sessionController: undefined } },
    })
    assert.ok(r.doc !== undefined, '缺 sessionController 时仍应写文档')
    assert.equal(r.created.length, 0, '缺 sessionController 时不应新建会话')
    results.push('PASS 缺 sessionController 时降级为只写文档')
  }

  // 9) 注入型 user/message（system-reminder）不能被当成用户指令写进交接文档
  {
    const r = await scenario({
      plugin,
      name: 'injected',
      tokens: 300000,
      toolCalls: 3,
      modelText: undefined,
      injectUser: '<system-reminder>' + String.fromCharCode(10) + 'The following workspace instructions may be relevant to your work.',
    })
    assert.ok(r.doc !== undefined, '应写文档')
    assert.doesNotMatch(r.doc, /The following workspace instructions/, '不应把 system-reminder 当成最近的用户指令')
    results.push('PASS 注入型消息被过滤')
  }

  // 10) run_code / bash 把真实路径写在参数正文里，也必须能抽出来
  {
    const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-code-'))
    const previousHome = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    const events = [userEvent('改插件', 1)]
    events.push(
      toolCallEvent(1, 1, 2, 'run_code', {
        description: 'patch plugin',
        code: "await tools.edit({ file_path: 'D:/tools/dsh-auto-handoff/lib/index.js', old_string: 'a', new_string: 'b' })",
      }),
    )
    const sessions = new Map()
    sessions.set('sess-a', buildSession('sess-a', dir, {}, events))
    const harness = makeServices({ sessions, tokensFor: () => 300000, llm: undefined })
    const ctx = makeCtx(harness)
    plugin.apply(ctx, { enabled: true, tokenThreshold: 300000, toolCallThreshold: 80, modelSummary: false })
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const doc = await readFile(join(dir, '.dsh', 'handoff', 'sess-a', 'full.md'), 'utf8')
    assert.match(doc, /dsh-auto-handoff[\\/]lib[\\/]index\.js/, '应从 run_code 的 code 正文里抽出文件路径')
    if (previousHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome
    await rm(dir, { recursive: true, force: true })
    results.push('PASS run_code 参数正文里的路径被抽取')
  }

  // 11) 纯工具轮（PTC）的助手消息只带 reasoning / tool-call 块时，也必须抽出「最近的助手输出」
  //     真实 provider（trae-enterprise / DeepSeek-V4.1-Flash）实测 block 统计是
  //     {reasoning:71, tool-call:80, text:1}——80 条 assistant/message 里几乎没有 text 块。
  //     旧实现只认 text，recentAssistant 恒为空，交接文档写「（未捕获）」、REVIEW 每次误报。
  {
    const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-ptc-'))
    const previousHome = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    const events = [userEvent('修插件', 1)]
    events.push({
      type: 'assistant/message',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'a2',
          content: [
            { type: 'reasoning', text: '先读源码，确认 messageText 只认 text 块。' },
            { type: 'tool-call', name: 'run_code', arguments: '{}', id: 'tc2' },
          ],
        },
        stream: [],
      },
    })
    events.push(toolCallEvent(1, 1, 3, 'read', { file_path: 'D:/tools/dsh-auto-handoff/lib/index.js' }))
    const sessions = new Map()
    sessions.set('sess-a', buildSession('sess-a', dir, {}, events))
    const harness = makeServices({ sessions, tokensFor: () => 300000, llm: undefined })
    const ctx = makeCtx(harness)
    plugin.apply(ctx, { enabled: true, tokenThreshold: 300000, toolCallThreshold: 80, modelSummary: false })
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const doc = await readFile(join(dir, '.dsh', 'handoff', 'sess-a', 'full.md'), 'utf8')
    assert.doesNotMatch(doc, /（未捕获）/, '纯工具轮不应再写「（未捕获）」')
    assert.match(doc, /先读源码，确认 messageText 只认 text 块/, '应从上一条 assistant 的 reasoning 块取到助手输出')
    assert.match(doc, /调用工具：run_code/, '应带上这一条消息发出的工具调用名')
    if (previousHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome
    await rm(dir, { recursive: true, force: true })
    results.push('PASS 纯工具轮也能抽出最近的助手输出（reasoning + tool-call 块）')
  }

  // 8) 手动命令存在且可调用
  {
    const r = await scenario({ plugin, name: 'commands', tokens: 1000, toolCalls: 0, modelText: undefined })
    const names = r.commands.map((command) => command.name).sort()
    assert.deepEqual(names, ['handoff', 'handoff-status'], '应注册 /handoff 与 /handoff-status')
    results.push('PASS 注册了 /handoff 与 /handoff-status')
  }

  console.log(['', ...results, '', 'ALL TESTS PASSED'].join('\n'))
}

run().catch((error) => {
  failures += 1
  console.error('TEST FAILED:', error && error.message ? error.message : error)
  console.error(error && error.stack)
  process.exitCode = 1
})
