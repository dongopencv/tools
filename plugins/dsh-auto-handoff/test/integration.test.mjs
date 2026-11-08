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
  return {
    created,
    prompts,
    cancelled,
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
          prompts.push(request)
          return { accepted: true }
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

function userEvent(text, seq) {
  return { type: 'user/message', seq, time: 0, data: { role: 'user', content: [{ type: 'text', text }], id: 'm' + String(seq) } }
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
  }

  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-module-'))
  const file = join(dir, 'index.mjs')
  await writeFile(file, rewritten, 'utf8')
  // index.js 现在把占位表拆到了 ./claims.js，临时目录里也要有一份同目录副本，
  // 否则相对 import 解析失败，测试根本加载不起来。
  const claimsSource = await readFile(join(process.cwd(), 'lib', 'claims.js'), 'utf8')
  await writeFile(join(dir, 'claims.js'), claimsSource, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  return mod
}

async function scenario({ plugin, name, tokens, toolCalls, chainDepth, modelText, expect, extra, injectUser, cancelParent, manual }) {
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

  const events = [userEvent('把 F:\\proj 下的构建脚本改成跨平台', 1)]
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
    chainLimit: 8,
    summaryMaxChars: 1600,
    docMaxChars: 6000,
    summaryTimeoutMs: 45000,
    maxTrackedFiles: 40,
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

  const docPath = join(dir, '.dsh', 'handoff', 'sess-a.md')
  let doc
  try {
    doc = await readFile(docPath, 'utf8')
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

  const record = { name, dir, docPath, doc, created: harness.created, prompts: harness.prompts, cancelled: harness.cancelled, commands: ctx._commands, ctx, events, claims, llmRequests }
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
    assert.match(r.doc, /原始目标/, '文档应有原始目标')
    assert.match(r.doc, /把 F:\\proj 下的构建脚本改成跨平台/, '文档应含原始用户指令')
    assert.match(r.doc, /build\.ps1/, '文档应含触及文件')
    assert.match(r.doc, /跑一遍测试/, '文档应含模型摘要的下一步')
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
    assert.match(r.doc, /## 下一步/, '长摘要被裁剪后「下一步」这一节仍须存在')
    assert.match(r.doc, /KEYWORD_NEXT_STEP/, '「下一步」的正文不能被裁掉')
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
    assert.match(r.doc, /最近一次用户要求|先读取上面列出的文件|未完成的部分/, '应出现兜底摘要的语句')
    assert.equal(r.created.length, 1, '无模型仍应开新会话')
    results.push('PASS 无模型摘要时用兜底并照常交接')
  }

  // 5) 链深度上限
  {
    const r = await scenario({ plugin, name: 'chain-limit', tokens: 300000, toolCalls: 5, chainDepth: 8, modelText: '摘要' })
    assert.ok(r.doc !== undefined, '超链上限仍应写文档')
    assert.equal(r.created.length, 0, '超链上限不应再开新会话')
    results.push('PASS 交接链深度上限生效（只写文档不续作）')
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
      chainLimit: 8,
      summaryMaxChars: 1600,
      docMaxChars: 6000,
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
    const doc = await readFile(join(dir, '.dsh', 'handoff', 'sess-a.md'), 'utf8')
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
    const doc = await readFile(join(dir, '.dsh', 'handoff', 'sess-a.md'), 'utf8')
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
