/**
 * 交接链回归测试：多跳必须能一直走下去，到 chainLimit 必须真停住。
 *
 * 这三个 bug 都是离线探针（work/chain-probe.mjs）跑出来的，现网看不到：
 * 1. 新会话写 done → 终态 → 链条停在第二棒（已改 genesis）
 * 2. chainLimit 早退时不 settle → 占位停 inflight → TTL 过期后又能续作，
 *    实测 10 轮探针建出 35 个会话
 * 3. 轮中闸用累计计数，过线后每个后续工具调用都重新抢一次占位，
 *    实测一轮就开出 12 个新会话
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const CHAIN_LIMIT = 3
const NL = String.fromCharCode(10)

async function loadPlugin() {
  const source = await readFile(join(process.cwd(), 'lib', 'index.js'), 'utf8')
  const rewritten = source.replace("import z from '@deepseek-ai/schemastery'", 'const z = globalThis.__SCHEMASTERY_STUB__')
  const chainable = () => { const n = {}; n.step = () => n; n.min = () => n; n.max = () => n; n.default = () => n; n.description = () => n; n.role = () => n; return n }
  globalThis.__SCHEMASTERY_STUB__ = { object: (f) => f, boolean: chainable, number: chainable, string: chainable }
  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-chain-mod-'))
  const file = join(dir, 'index.mjs')
  await writeFile(file, rewritten, 'utf8')
  await writeFile(join(dir, 'claims.js'), await readFile(join(process.cwd(), 'lib', 'claims.js'), 'utf8'), 'utf8')
  return import(pathToFileURL(file).href)
}

function makeCtx(services) {
  const handlers = new Map()
  return {
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list) },
    emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args) },
    get(key) { return services[key] },
    get sessions() { return services.sessions },
    get commands() { return { register() { return () => {} } } },
  }
}

function makeSession(id, cwd) {
  const events = [{ type: 'user/message', seq: 1, time: 0, data: { content: [{ type: 'text', text: '推进长任务' }] } }]
  return {
    id,
    header: { version: 1, id, createdAt: 0, cwd, isSeeded: false },
    ownEvents: () => events,
    requestContext: () => undefined,
    requestHeader: () => undefined,
  }
}

const results = []
function check(name, ok, detail) { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail)) }

async function run() {
  const home = await mkdtemp(join(tmpdir(), 'auto-handoff-chain-home-'))
  const workDir = await mkdtemp(join(tmpdir(), 'auto-handoff-chain-work-'))
  process.env.USERPROFILE = home

  const plugin = await loadPlugin()
  const live = new Map()
  const created = []
  const fires = []

  const services = {
    sessions: { get: (id) => live.get(String(id)) },
    tokenMeter: { measure: () => ({ totalTokens: 400000 }) },
    sessionTitle: { get: () => ({ title: 'chain' }) },
    workingDirectory: { get: (s) => s.header.cwd },
    llm: undefined,
    sessionController: {
      create: async () => { const id = 'new-' + String(created.length + 1); created.push(id); live.set(id, makeSession(id, workDir)); return { sessionId: id } },
      prompt: async (request, signal) => {
        assert.equal(typeof signal?.throwIfAborted, 'function', 'prompt 必须收到 AbortSignal')
        signal.throwIfAborted()
        fires.push(request.sessionId)
        return { accepted: true }
      },
    },
  }

  const ctx = makeCtx(services)
  plugin.apply(ctx, {
    enabled: true,
    tokenThreshold: 300000,
    toolCallThreshold: 80,
    modelSummary: false,
    chainLimit: CHAIN_LIMIT,
    handoffDir: '.dsh/handoff',
    docMaxChars: 6000,
    maxTrackedFiles: 40,
    summaryMaxChars: 1600,
    claimTtlMs: 1,
    enforceMidTurn: false,
  })

  const start = makeSession('hop-0', workDir)
  live.set('hop-0', start)
  let current = 'hop-0'
  for (let hop = 0; hop < 6; hop += 1) {
    const before = created.length
    ctx.emit('agent/turn-stopping', { agent: { id: current }, turn: 1, signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 350))
    if (created.length === before) break
    current = created[created.length - 1]
    await new Promise((r) => setTimeout(r, 150))
  }

  const claims = JSON.parse(await readFile(join(home, '.dsh', 'auto-handoff', 'claims.json'), 'utf8')).claims
  const depths = Object.values(claims).map((entry) => entry.chainDepth)

  check('多跳能走下去（至少 3 棒）', created.length >= CHAIN_LIMIT, 'created=' + String(created.length))
  check('链深逐跳 +1', JSON.stringify([...new Set(depths)].sort((a, b) => a - b)) === JSON.stringify([0, 1, 2, 3]), JSON.stringify(depths))
  check('到 chainLimit 就停（不再新建会话）', created.length <= CHAIN_LIMIT + 1, 'created=' + String(created.length))
  const stopped = Object.entries(claims).filter(([, entry]) => entry.state === 'stopped')
  check('到顶那一棒落 stopped 终态（不是 inflight）', stopped.length === 1, JSON.stringify(Object.entries(claims).map(([k, v]) => k + ':' + v.state)))
  check('每棒只投递一次简报', fires.length === created.length, 'fires=' + String(fires.length) + ' created=' + String(created.length))
  check('父会话只交接一次（done 终态）', claims['hop-0'].state === 'done', claims['hop-0'].state)
  // 链条的关键：每一棒交接完自己是 done（终态，只交接一次），
  // 但别人交给它的那份记录必须是 genesis——写 done 会让新会话永远不能再交接，
  // 链条就断在第二棒。判据：最新那一棒不是 done。
  const newest = created[created.length - 1]
  check('最新一棒不是 done（genesis 或 stopped），否则链条断在这里',
    claims[newest] !== undefined && claims[newest].state !== 'done',
    newest + '=' + (claims[newest] === undefined ? 'missing' : claims[newest].state))
  check('中间每一棒都只交接了一次（done）',
    created.slice(0, -1).every((id) => claims[id] !== undefined && claims[id].state === 'done'),
    JSON.stringify(created.map((id) => id + ':' + (claims[id] === undefined ? 'missing' : claims[id].state))))

  console.log('claims=' + JSON.stringify(Object.entries(claims).map(([k, v]) => k + ':' + v.state + '@' + String(v.chainDepth))))

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? NL + 'ALL CHAIN TESTS PASSED' : NL + 'FAILED: ' + String(failed.length))
  if (failed.length > 0) process.exitCode = 1
}

await run()