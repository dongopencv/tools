/**
 * 轮中硬兜底测试：验证「不依赖任何提示词规则」这条路径。
 *
 * 关键断言：只灌工具调用事件、**完全不发 turn-stopping**（模拟一个
 * 还在跑、永远不结束、模型完全不理规则的长任务），交接仍必须发生。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const results = []

async function loadPluginUnderTest() {
  const source = await readFile(join(process.cwd(), 'lib', 'index.js'), 'utf8')
  const rewritten = source.replace(
    "import z from '@deepseek-ai/schemastery'",
    'const z = globalThis.__SCHEMASTERY_STUB__',
  )
  assert.notEqual(rewritten, source, 'must rewrite schemastery import')

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
  globalThis.__SCHEMASTERY_STUB__ = { object: (f) => f, boolean: chainable, number: chainable, string: chainable }

  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-midturn-mod-'))
  const file = join(dir, 'index.mjs')
  await writeFile(file, rewritten, 'utf8')
  // 占位表在 ./claims.js；临时目录里要有同目录副本，相对 import 才解析得到。
  const claimsSource = await readFile(join(process.cwd(), 'lib', 'claims.js'), 'utf8')
  await writeFile(join(dir, 'claims.js'), claimsSource, 'utf8')
  return import(pathToFileURL(file).href)
}

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
  }
}

function buildSession(id, cwd, events) {
  return {
    id,
    header: { version: 1, id, createdAt: 0, cwd, isSeeded: false },
    ownEvents: () => events,
    requestContext: () => undefined,
    requestHeader: () => undefined,
  }
}

function toolCall(seq, name, args) {
  return { type: 'tool/call', seq, time: 0, data: { turn: 1, step: 1, callId: 'c' + String(seq), name, arguments: JSON.stringify(args) } }
}

async function scenario({ plugin, toolCalls, enforce, fireTurnStopping }) {
  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-midturn-'))
  const previousHome = process.env.USERPROFILE
  process.env.USERPROFILE = dir

  const events = [{ type: 'user/message', seq: 1, time: 0, data: { role: 'user', content: [{ type: 'text', text: '长任务：批量改 300 个文件' }] } }]
  for (let i = 0; i < toolCalls; i += 1) events.push(toolCall(i + 2, 'write', { file_path: `D:/bulk/f${String(i)}.ts` }))

  const created = []
  const prompts = []
  const session = buildSession('sess-a', dir, events)
  const sessions = new Map([['sess-a', session]])

  const services = {
    sessions: { get: (id) => sessions.get(String(id)) },
    tokenMeter: { measure: () => ({ totalTokens: 5000 }) },
    sessionTitle: { get: () => ({ title: '长任务' }) },
    workingDirectory: { get: (s) => s.header.cwd },
    llm: undefined,
    sessionController: {
      create: async (request) => {
        const id = 'new-' + String(created.length + 1)
        created.push({ id, cwd: request.cwd, agentPreset: request.agentPreset })
        return { sessionId: id }
      },
      // 真实签名：第二参数必须是可用 AbortSignal，否则宿主第一行就抛。
      prompt: async (request, signal) => {
        if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
          throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
        }
        signal.throwIfAborted()
        prompts.push(request)
        return { accepted: true }
      },
    },
  }

  const ctx = makeCtx({ services })
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
    enforceMidTurn: enforce,
  })

  // 灌入工具调用事件 —— 模拟一个一直在跑、永远不收尾的轮次
  for (const event of events) if (event.type === 'tool/call') ctx.emit('session/event', session, event)
  await new Promise((r) => setTimeout(r, 300))

  if (fireTurnStopping) {
    ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 200))
  }

  let doc
  try {
    doc = await readFile(join(dir, '.dsh', 'handoff', 'sess-a.md'), 'utf8')
  } catch {
    doc = undefined
  }

  if (previousHome === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousHome
  await rm(dir, { recursive: true, force: true })

  return { doc, created, prompts }
}

async function run() {
  const plugin = await loadPluginUnderTest()

  // 1) 核心场景：只灌工具调用，永不触发 turn-stopping。
  //    这是「模型不理规则 / 轮次永远不结束」的最坏情况。
  {
    const r = await scenario({ plugin, toolCalls: 85, enforce: true, fireTurnStopping: false })
    assert.ok(r.doc !== undefined, '轮中硬兜底必须写文档（完全不依赖 turn-stopping）')
    assert.equal(r.created.length, 1, '轮中硬兜底必须开新会话')
    assert.equal(r.prompts.length, 1, '轮中硬兜底必须投递文档')
    assert.match(r.prompts[0].content[0].text, /交接文档开始/, '新会话必须收到文档全文')
    results.push('PASS 轮中硬兜底：不发 turn-stopping 也能交接（规则失效场景）')
  }

  // 2) 关掉硬兜底、只灌工具调用、不发 turn-stopping → 确认不做任何事（对照组）
  {
    const r = await scenario({ plugin, toolCalls: 85, enforce: false, fireTurnStopping: false })
    assert.equal(r.doc, undefined, '关闭硬兜底时应保持旧行为（等轮末）')
    assert.equal(r.created.length, 0, '关闭硬兜底时不应新建会话')
    results.push('PASS 对照组：关闭硬兜底后只依赖轮末触发')
  }

  // 3) 硬兜底在阈值以下不应触发
  {
    const r = await scenario({ plugin, toolCalls: 70, enforce: true, fireTurnStopping: false })
    assert.equal(r.doc, undefined, '未到阈值不应触发')
    assert.equal(r.created.length, 0, '未到阈值不应新建会话')
    results.push('PASS 轮中硬兜底不早触发（70 < 80）')
  }

  // 4) 硬兜底与轮末触发同时存在时，只交接一次（不重复开会话）
  {
    const r = await scenario({ plugin, toolCalls: 85, enforce: true, fireTurnStopping: true })
    assert.equal(r.created.length, 1, '两条路径共存时应只交接一次')
    assert.equal(r.prompts.length, 1, '不应重复投递')
    results.push('PASS 硬兜底与轮末触达共存时不重复交接')
  }

  console.log(['', ...results, '', 'ALL MID-TURN TESTS PASSED'].join('\n'))
}

run().catch((error) => {
  console.error('TEST FAILED:', error && error.message ? error.message : error)
  console.error(error && error.stack)
  process.exitCode = 1
})
