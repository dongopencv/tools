/**
 * 「原始目标」还原回归测试（v1.1.5）。
 *
 * 一句话：链上每一棒的首条 user/message 都是上一棒注入的**整份交接简报**，
 * 旧实现直接 clampText(…, 1200) 写进「## 原始目标」，于是每深一层就多嵌一层旧文档。
 * 实测 depth 6 那份文档的「原始目标」只剩 693 字、本身又以 [自动交接] 开头，
 * 用户真正那句话（含 13 项验收清单）在第 2 层就丢了。
 *
 * 这里不跑真会话，而是**在临时目录里造一条真形状的交接链**（盘上文档 + 简报文本），
 * 逐条验证 unwrapGoal 的下钻、防环、截断与降级路径。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const results = []

async function loadPlugin() {
  const source = await readFile(join(process.cwd(), 'lib', 'index.js'), 'utf8')
  let rewritten = source.replace(
    "import z from '@deepseek-ai/schemastery'",
    'const z = globalThis.__SCHEMASTERY_STUB__',
  )
  assert.notEqual(rewritten, source, '测试需要能替换掉 schemastery 的 import')
  const chainable = () => {
    const n = {}
    n.step = () => n
    n.min = () => n
    n.max = () => n
    n.default = () => n
    n.description = () => n
    n.role = () => n
    return n
  }
  // array 是 v1.2 新增的（reviewBlockOn 是字符串数组），链式桩同样返回自身。
globalThis.__SCHEMASTERY_STUB__ = { object: (f) => f, boolean: chainable, number: chainable, string: chainable, array: () => chainable() }
  // 默认只导出 name/inject/Config/apply；测试要直接调内部函数，
  // 追加一行 export 即可（都是顶层函数声明，改写后仍在同一模块作用域里）。
  rewritten +=
    NL + 'export { unwrapGoal, goalSection, docPathFromText, goalFromDocPath, resolveOptions }' + NL
  const dir = await mkdtemp(join(tmpdir(), 'auto-handoff-goal-mod-'))
  const file = join(dir, 'index.mjs')
  await writeFile(file, rewritten, 'utf8')
  await writeFile(join(dir, 'claims.js'), await readFile(join(process.cwd(), 'lib', 'claims.js'), 'utf8'), 'utf8')
  await writeFile(join(dir, 'docs.js'), await readFile(join(process.cwd(), 'lib', 'docs.js'), 'utf8'), 'utf8')
  return import(pathToFileURL(file).href)
}

/** 造一份真形状的交接文档：五节齐全、原始目标排在第四节（与真实顺序一致）。 */
function docBody(goal) {
  return [
    '---',
    'session: session-test',
    'chain-depth: 1',
    '---',
    '',
    '# 会话交接文档 · 测试',
    '',
    '## 进度与下一步',
    '',
    '## 下一步',
    '1. 继续推进',
    '',
    '## 进度概述',
    '已完成一半。',
    '',
    '## 交接前 REVIEW',
    '',
    '**结论：通过**',
    '',
    '## 原始目标',
    '',
    goal,
    '',
    '## 最近的用户指令',
    '',
    '> 继续',
    '',
    '## 最近的助手输出',
    '',
    '> 已改好一段',
    '',
    '## 触及的文件',
    '',
    '- lib/index.js',
    '',
    '## 工具轨迹',
    '',
    '- read lib/index.js',
    '',
  ].join(NL)
}

/** 造一条真的注入简报：首行带「已把进度写入 `path`」，正文夹在两个分隔行之间。 */
function brief(docPath, body) {
  return (
    '[自动交接] 上一会话 session-prev 达到阈值（279805 tokens / 129 次工具调用），' +
    '已把进度写入 `' +
    docPath +
    '`。下面是同一份交接文档的全文，直接据此继续，不要重复已完成的工作。' +
    NL + NL + '===== 交接文档开始 =====' + NL + body + NL + '===== 交接文档结束 ====='
  )
}

async function writeDoc(root, name, goal) {
  const dir = join(root, '.dsh', 'handoff')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name + '.md')
  await writeFile(path, docBody(goal), 'utf8')
  return path
}

const check = (name, fn) => fn().then(() => { results.push('PASS ' + name); })

let root = ''

async function run() {
  root = await mkdtemp(join(tmpdir(), 'auto-handoff-goal-'))
  const mod = await loadPlugin()
  const ROOT_GOAL = [
    '@AI 流程编排师  @AI 工程师  /wayfinder',
    '请帮我处理一个需求（严格遵循 wayfinder 技能规则）。',
    '仓库（已自动填入当前工作区）：https://github.com/dongopencv/tools',
    '',
    '## 澄清',
    '- [ ] 对目标 / 范围 / 偏好有假设时，先用 grilling 技能澄清，不默认',
    '',
    '# 关键决定与坑',
    '- 坑：D:/tools 与 D:/proj 两份副本同时存在',
  ].join(NL)

  // 1) 非交接型文本原样返回（只做截断，不折腾）
  await check('非交接型首条消息原样保留', async () => {
    assert.equal(mod.unwrapGoal(ROOT_GOAL, 4000), ROOT_GOAL)
    assert.equal(mod.unwrapGoal('  短目标  ', 4000), '短目标')
  })

  // 2) goalMaxChars 生效：超过上限就截断并显式标注
  await check('goalMaxChars 截断生效（并标注…（已截断））', async () => {
    const out = mod.unwrapGoal(ROOT_GOAL, 60)
    assert.ok(out.length <= 60 + '…（已截断）'.length, 'out.len=' + String(out.length))
    assert.match(out, /…（已截断）$/)
    // 缺省值必须来自 DEFAULTS.goalMaxChars，不是凭空写死的小钳位
    assert.equal(mod.DEFAULTS.goalMaxChars, 4000)
    assert.equal(mod.resolveOptions({}).goalMaxChars, 4000)
    assert.equal(mod.resolveOptions({ goalMaxChars: 8000 }).goalMaxChars, 8000)
  })

  // 3) 单跳：简报 → 盘上文档 → 真目标
  await check('单跳：从简报读盘取出真目标', async () => {
    const p = await writeDoc(root, 'hop1', ROOT_GOAL)
    const out = mod.unwrapGoal(brief(p, docBody(ROOT_GOAL)), 4000)
    assert.equal(out, ROOT_GOAL)
    assert.ok(!out.startsWith('[自动交接]'), '不应把简报当目标')
  })

  // 4) 多跳（真形状的嵌套）：每一棒的「原始目标」都是上一整条简报
  await check('多跳 6 层：一路下钻回链根，13 项清单一条不少', async () => {
    const chainRoot = await writeDoc(root, 'hop-root', ROOT_GOAL)
    let prevPath = chainRoot
    let prevBrief = brief(chainRoot, docBody(ROOT_GOAL))
    for (let hop = 1; hop <= 6; hop += 1) {
      const body = docBody(prevBrief)
      const path = await writeDoc(root, 'hop-' + String(hop), prevBrief)
      prevPath = path
      prevBrief = brief(prevPath, body)
    }
    const out = mod.unwrapGoal(prevBrief, 4000)
    assert.equal(out, ROOT_GOAL, '应还原成链根那句用户话')
    assert.equal((out.match(/- \[ \]/g) ?? []).length, 1, '清单项不应丢失')
    assert.ok(!out.includes('[自动交接] 上一会话'), '目标里不应残留简报壳')
  })

  // 5) 注入副本被 docMaxChars 截断（真实现场）：正文里根本没有「## 原始目标」，
  //    必须靠读盘救回来。这条是本次修复的第一个坑，正文递归单独用会失败。
  await check('注入副本被截断时仍能读盘还原（正文无该节也不影响）', async () => {
    const p = await writeDoc(root, 'truncated', ROOT_GOAL)
    const full = brief(p, docBody(ROOT_GOAL))
    // 真实现场里注入副本被 docMaxChars=6000 砍掉，而「原始目标」排在第四节，
    // 所以切口落在它之前——这里把切口精确放在该标题处，模拟同一件事。
    const cut = full.slice(0, full.indexOf('## 原始目标'))
    assert.equal(mod.goalSection(cut), '', '前提：截断副本正文里已没有该节')
    assert.equal(mod.unwrapGoal(cut, 4000), ROOT_GOAL, '读盘路径必须兜住')
  })

  // 6) 相邻两棒「原始目标」长度/尾部完全相同 → 不能据此误判成环
  //    （这是本次修复的第二个坑：指纹防环会把正常下钻截停在第一跳）
  await check('相邻两棒内容同形时不误判成环（继续下钻）', async () => {
    const sameish = '- 相同的 693 字尾部内容'.repeat(3)
    const rootPath = await writeDoc(root, 'same-root', ROOT_GOAL)
    const midPath = await writeDoc(root, 'same-mid', brief(rootPath, docBody(ROOT_GOAL)))
    const out = mod.unwrapGoal(brief(midPath, docBody(sameish)), 4000)
    assert.equal(out, ROOT_GOAL, '同形文本必须继续下钻到根')
  })

  // 7) 真环（A→B→A）：必须能停下来，不能挂死
  await check('文档互相引用成环时能停下', async () => {
    const dir = join(root, '.dsh', 'handoff')
    const aPath = join(dir, 'cycle-a.md')
    const bPath = join(dir, 'cycle-b.md')
    await writeFile(aPath, docBody(brief(bPath, 'x')), 'utf8')
    await writeFile(bPath, docBody(brief(aPath, 'x')), 'utf8')
    const out = mod.unwrapGoal(brief(aPath, 'x'), 4000)
    assert.ok(out.length > 0, '不能返回空')
  })

  // 8) 文档被删/路径不可读 → 退回正文下钻，一步都不能白跑
  await check('文档读不到时退回正文下钻（降级不炸）', async () => {
    const missing = join(root, '.dsh', 'handoff', 'not-there.md')
    const out = mod.unwrapGoal(brief(missing, docBody(ROOT_GOAL)), 4000)
    assert.equal(out, ROOT_GOAL, '正文里那层仍然可下钻')

    // 正文也没有该节 → 原样（截断后）返回，且不得抛错
    const bare = mod.unwrapGoal('[自动交接] 什么都没写', 4000)
    assert.equal(bare, '[自动交接] 什么都没写')
  })

  // 9) 端到端：真交接一遍，写出来的文档「原始目标」必须是链根那句话
  await check('端到端：交接生成的文档里「原始目标」是真目标、不含简报壳', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auto-handoff-goal-home-'))
    const work = await mkdtemp(join(tmpdir(), 'auto-handoff-goal-work-'))
    const previousHome = process.env.USERPROFILE
    process.env.USERPROFILE = home
    try {
      const rootDoc = await writeDoc(work, 'prev-hop', ROOT_GOAL)
      const incoming = brief(rootDoc, docBody(ROOT_GOAL))
      const events = [
        { type: 'user/message', seq: 1, time: 0, data: { role: 'user', content: [{ type: 'text', text: incoming }], id: 'm1' } },
        { type: 'tool/call', seq: 2, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: join(work, 'lib', 'index.js') }) } },
      ]
      const session = {
        id: 'sess-a',
        header: { version: 1, id: 'sess-a', createdAt: 0, cwd: work, isSeeded: false },
        ownEvents: () => events,
        requestContext: () => undefined,
        requestHeader: () => undefined,
      }
      const services = {
        sessions: { get: (id) => (String(id) === 'sess-a' ? session : undefined) },
        tokenMeter: { measure: () => ({ totalTokens: 300000 }) },
        sessionTitle: { get: () => ({ title: '续作' }) },
        workingDirectory: { get: () => work },
        llm: undefined,
        sessionController: {
          create: async () => ({ sessionId: 'sess-new-1' }),
          prompt: async (request, signal) => {
            assert.equal(typeof signal?.throwIfAborted, 'function', 'prompt 必须收到 AbortSignal')
            return { accepted: true }
          },
        },
      }
      const handlers = new Map()
      const ctx = {
        on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list) },
        emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args) },
        get(key) { return services[key] },
        get sessions() { return services.sessions },
        get commands() { return { register() { return () => {} } } },
      }
      const plugin = await loadPlugin()
      plugin.apply(ctx, { enabled: true, tokenThreshold: 300000, toolCallThreshold: 1, modelSummary: false, goalMaxChars: 4000 })
      ctx.emit('agent/turn-stopping', { agent: { id: 'sess-a' }, turn: 1, signal: new AbortController().signal })
      await new Promise((resolve) => setTimeout(resolve, 300))

      const doc = await readFile(join(work, '.dsh', 'handoff', 'sess-a', 'full.md'), 'utf8')
      const goal = mod.goalSection(doc)
      assert.equal(goal, ROOT_GOAL, '文档里的原始目标必须是链根那句用户话')
      assert.ok(!goal.startsWith('[自动交接]'), '不能把交接简报当成用户目标')
      assert.match(doc, /## 原始目标/, '该节必须还在')
      assert.match(doc, /- \[ \] 对目标 \/ 范围 \/ 偏好有假设时/, '验收清单不能被截断掉')
    } finally {
      if (previousHome === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousHome
      await rm(home, { recursive: true, force: true })
      await rm(work, { recursive: true, force: true })
    }
  })

  console.log(['', ...results, '', 'ALL GOAL TESTS PASSED'].join(NL))
}

run()
  .then(async () => { await rm(root, { recursive: true, force: true }) })
  .catch((error) => {
    console.error('TEST FAILED:', error && error.message ? error.message : error)
    console.error(error && error.stack)
    process.exitCode = 1
  })
