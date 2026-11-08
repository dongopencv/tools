/**
 * dsh-auto-handoff — 长会话自动交接插件（Host 侧）。
 *
 * 目标：一个会话累计到一定 token 压力或一定工具调用次数后，自动把进度写成
 * 一份交接文档（`.dsh/handoff/<sessionId>.md`），再开一个全新会话并把交接
 * 文档塞进它的第一条消息，让新会话接着上一棒继续干，从而避免单会话上下文
 * 无限膨胀（例如一次长跑吃掉上亿 token）。
 *
 * 触发点：
 *   - `agent/turn-stopping`（每轮结束、工具调用都收尾时）读取 `tokenMeter`
 *     的会话压力与工具调用计数，超阈值即交接。
 *   - `/handoff` 命令可手动立即交接。
 *
 * 设计约束：
 *   - 绝不打断当前轮：所有失败都被吞掉并只记日志。
 *   - 每个会话最多自动交接一次（手动命令同样受此保护）。
 *   - 交接链有深度上限，防止模型无限自我续作。
 *   - 只使用 Node 内置模块，避免本地安装时的依赖解析问题。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { claimsPath, readClaims, reserveClaim, settleClaim } from './claims.js'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-auto-handoff'

/** 启动前必须就位的服务。 */
export const inject = ['commands', 'sessions']

/** 默认选项。 */
const DEFAULTS = {
  enabled: true,
  tokenThreshold: 300000,
  toolCallThreshold: 80,
  handoffDir: '.dsh/handoff',
  modelSummary: true,
  chainLimit: 8,
  summaryMaxChars: 1600,
  docMaxChars: 6000,
  summaryTimeoutMs: 45000,
  maxTrackedFiles: 40,
  summaryProvider: '',
  summaryModel: '',
  enforceMidTurn: true,
  claimTtlMs: 86400000,
  retryCooldownMs: 600000,
  maxAttempts: 3,
  cancelParentAfterHandoff: true,
}

const STATE_FILE = 'state.json'
const LOG_PREFIX = '[auto-handoff]'

/** 设置页表单：每个字段都带中文说明，缺省值即 DEFAULTS。 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('总开关。关闭后不注册任何监听与命令。'),
  tokenThreshold: z
    .number()
    .step(1)
    .min(1000)
    .default(DEFAULTS.tokenThreshold)
    .description('会话累计 token 压力达到该值即交接。'),
  toolCallThreshold: z
    .number()
    .step(1)
    .min(5)
    .default(DEFAULTS.toolCallThreshold)
    .description('会话工具调用次数达到该值即交接；与 token 阈值任一命中即可。'),
  handoffDir: z
    .string()
    .default(DEFAULTS.handoffDir)
    .description('交接文档目录，相对会话工作目录，默认 .dsh/handoff。'),
  modelSummary: z
    .boolean()
    .default(DEFAULTS.modelSummary)
    .description('是否用模型生成本轮摘要；关闭后使用本地兜底摘要（零额外 token）。'),
  chainLimit: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULTS.chainLimit)
    .description('自动续作链的深度上限，超过后只写文档不再自动开新会话。'),
  summaryMaxChars: z
    .number()
    .step(100)
    .min(400)
    .default(DEFAULTS.summaryMaxChars)
    .description('模型摘要写入文档前的字符上限。'),
  docMaxChars: z
    .number()
    .step(100)
    .min(1000)
    .default(DEFAULTS.docMaxChars)
    .description('交接文档总字符上限。'),
  summaryTimeoutMs: z
    .number()
    .step(1000)
    .min(5000)
    .default(DEFAULTS.summaryTimeoutMs)
    .description('单次摘要模型请求的超时（毫秒）。'),
  maxTrackedFiles: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULTS.maxTrackedFiles)
    .description('交接文档里最多列出多少个被触及的文件路径。'),
  summaryProvider: z
    .string()
    .default(DEFAULTS.summaryProvider)
    .description('生成摘要用的 provider；留空则自动沿用本会话最近使用的模型。'),
  summaryModel: z
    .string()
    .default(DEFAULTS.summaryModel)
    .description('生成摘要用的 model；留空则自动沿用本会话最近使用的模型。'),
  enforceMidTurn: z
    .boolean()
    .default(DEFAULTS.enforceMidTurn)
    .description('轮中硬兜底：不等本轮结束，工具调用一超阈值立刻交接（不依赖任何提示词规则）。'),
  claimTtlMs: z
    .number()
    .step(1000)
    .min(60000)
    .default(DEFAULTS.claimTtlMs)
    .description('同一会话的交接占位保留多久（毫秒）。占位落盘，进程重启后仍然有效。'),
  retryCooldownMs: z
    .number()
    .step(1000)
    .min(10000)
    .default(DEFAULTS.retryCooldownMs)
    .description('交接失败后多久才允许重试（毫秒），避免失败一次就每个回合重放。'),
  maxAttempts: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULTS.maxAttempts)
    .description('同一会话最多尝试交接几次；超过后不再自动重试，只留日志。'),
  cancelParentAfterHandoff: z
    .boolean()
    .default(DEFAULTS.cancelParentAfterHandoff)
    .description('交接成功后取消父会话的当前轮（保留未处理的队列）。关掉它，父会话会继续跑，和子会话同时烧 token。'),
})

/**
 * 插件自己的运行目录：`~/.dsh/auto-handoff`。
 * 账本、日志都放这里——它们是插件的运行状态，不该被用户的 git 提交带走。
 */
function runtimeDir() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home === '') return undefined
  return join(home, '.dsh', 'auto-handoff')
}

/** 单个日志文件的字节上限；超过就轮转成 .1。 */
const LOG_MAX_BYTES = 1024 * 1024

/** 把一行日志写进文件；任何失败都吞掉（日志绝不能影响主流程）。 */
function appendLogLine(level, message, detail) {
  try {
    const dir = runtimeDir()
    if (dir === undefined) return
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'auto-handoff.log')
    try {
      const info = statSync(file)
      if (info.size > LOG_MAX_BYTES) renameSync(file, join(dir, 'auto-handoff.1.log'))
    } catch {
      /* 文件还不存在，正常 */
    }
    const detailText =
      detail === undefined ? '' : detail instanceof Error ? ` | ${detail.message}` : ` | ${String(detail)}`
    appendFileSync(file, `${new Date().toISOString()} ${level} ${message}${detailText}\n`, 'utf8')
  } catch {
    /* 日志失败即放弃 */
  }
}

/** 一条警告日志；失败也不能影响主流程。 */
function logWarn(message, detail) {
  try {
    if (detail === undefined) console.warn(LOG_PREFIX, message)
    else console.warn(LOG_PREFIX, message, detail instanceof Error ? detail.message : String(detail))
  } catch {
    /* 控制台失败即放弃 */
  }
  appendLogLine('WARN', message, detail)
}

/** 日志：交接成功等常规信息。 */
function logInfo(message, detail) {
  try {
    if (detail === undefined) console.log(LOG_PREFIX, message)
    else console.log(LOG_PREFIX, message, String(detail))
  } catch {
    /* 同上 */
  }
  appendLogLine('INFO', message, detail)
}

/** 受限的整数读取。 */
function readInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 受限的字符串读取。 */
function readText(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** 布尔读取。 */
function readBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 把 patch 里的原始 config 归一化成完整选项。 */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: readBool(raw.enabled, DEFAULTS.enabled),
    tokenThreshold: readInt(raw.tokenThreshold, DEFAULTS.tokenThreshold),
    toolCallThreshold: readInt(raw.toolCallThreshold, DEFAULTS.toolCallThreshold),
    handoffDir: readText(raw.handoffDir, DEFAULTS.handoffDir),
    modelSummary: readBool(raw.modelSummary, DEFAULTS.modelSummary),
    chainLimit: readInt(raw.chainLimit, DEFAULTS.chainLimit),
    summaryMaxChars: readInt(raw.summaryMaxChars, DEFAULTS.summaryMaxChars),
    docMaxChars: readInt(raw.docMaxChars, DEFAULTS.docMaxChars),
    summaryTimeoutMs: readInt(raw.summaryTimeoutMs, DEFAULTS.summaryTimeoutMs),
    maxTrackedFiles: readInt(raw.maxTrackedFiles, DEFAULTS.maxTrackedFiles),
    summaryProvider: readText(raw.summaryProvider, DEFAULTS.summaryProvider),
    summaryModel: readText(raw.summaryModel, DEFAULTS.summaryModel),
    enforceMidTurn: readBool(raw.enforceMidTurn, DEFAULTS.enforceMidTurn),
    claimTtlMs: readInt(raw.claimTtlMs, DEFAULTS.claimTtlMs),
    retryCooldownMs: readInt(raw.retryCooldownMs, DEFAULTS.retryCooldownMs),
    maxAttempts: readInt(raw.maxAttempts, DEFAULTS.maxAttempts),
    cancelParentAfterHandoff: readBool(raw.cancelParentAfterHandoff, DEFAULTS.cancelParentAfterHandoff),
  }
}

/** 截断一段文本，超出时显式标注。 */
function clampText(text, maxChars) {
  if (typeof text !== 'string') return ''
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, maxChars) + '…（已截断）'
}

/**
 * 把摘要按 `## 小节` 切开。模型未按格式输出时整段作为一节（title 为空）。
 * 这样截断可以按节做，而不是把整段字符串一刀切——旧实现正是切掉了「下一步」。
 */
function splitSummarySections(summary) {
  const sections = []
  let current = { title: '', body: [] }
  for (const line of String(summary).split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      if (current.title !== '' || current.body.join('').trim() !== '') sections.push(current)
      current = { title: match[1], body: [] }
      continue
    }
    current.body.push(line)
  }
  sections.push(current)
  return sections
}

/** 模型摘要里是否已经有「下一步」这一节。 */
function hasNextStep(summary) {
  return splitSummarySections(summary).some((section) => section.title.includes('下一步'))
}

/**
 * 保证摘要一定带「下一步」：模型漏写时用本地兜底补一节。
 * 用户明确的验收口径是「新会话第一条 assistant 输出必须引用下一步」，
 * 所以这一节不能被模型自觉决定。
 */
function ensureNextStep(summary, facts) {
  if (summary === '') return summary
  if (hasNextStep(summary)) return summary
  return summary.trimEnd() + '\n\n## 下一步\n' + fallbackSummary(facts)
}

/**
 * 摘要输出预算是字符上限的函数，不是写死的常数。
 * 中文约 1.5–2 token/字，1600 字要 2400–3200 token；给 1200 必然在第三节中途断掉。
 * 取 2 token/字 + 400 余量，下限 800，上限 8000（避免把 summaryMaxChars 调大后失控）。
 */
function summaryTokenBudget(summaryMaxChars) {
  const budget = Math.ceil(summaryMaxChars * 2) + 400
  if (!Number.isFinite(budget)) return 4000
  return Math.min(Math.max(budget, 800), 8000)
}

/**
 * 把「下一步」这一节提到摘要最前面，再整体裁剪。
 * 裁剪仍然会发生，但被裁掉的只会是「进度概述」「关键决定与坑」的尾巴——
 * 实测 8 份交接文档里 4 份因为按原始顺序切 1600 字而整节丢掉「下一步」。
 */
function orderSummary(summary, maxChars) {
  const sections = splitSummarySections(summary)
  const next = sections.filter((section) => section.title.includes('下一步'))
  const rest = sections.filter((section) => !section.title.includes('下一步'))
  const rebuilt = [...next, ...rest]
    .map((section) => {
      const body = section.body.join('\n').trim()
      if (section.title === '') return body
      return body === '' ? `## ${section.title}` : `## ${section.title}\n${body}`
    })
    .filter((text) => text !== '')
  if (rebuilt.length === 0) return ''
  return clampText(rebuilt.join('\n\n'), maxChars)
}

/** 从一条 message 的 content 里拼出纯文本。 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 判断一个字符串是否像文件路径（用于从工具参数里抽文件）。
 *
 * 这里必须严格：交接文档会被整段喂给新会话，混进 `s://github.com/...`、
 * `D:\\tools\\x（lib/index.js`、`/DEFAULTS/resolveOptions` 这类伪路径，
 * 比「没识别到文件」更糟——新会话会照着它去找不存在的文件。
 */
function looksLikePath(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length === 0 || text.length > 400) return false
  if (text.includes('\n')) return false
  if (text.startsWith('http://') || text.startsWith('https://')) return false
  // 混进了 `://` 说明是从 URL 里截出来的半截；混进中文标点说明是从散文里截出来的。
  if (text.includes('://')) return false
  if (/[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/.test(text)) return false
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(text)
  const gitBashAbsolute = /^\/[A-Za-z]\//.test(text)
  const relative = /^\.{1,2}[\\/]/.test(text) || /^[A-Za-z0-9_.-]+[\\/][^\\/]+/.test(text)
  if (!windowsAbsolute && !gitBashAbsolute && !relative) return false
  // 至少得有个像样的文件名或目录层级，`C:\\` 这种只是盘符。
  return text.replace(/[\\/]+$/u, '').length >= 4
}

/** 工具参数里可能承载文件的键名。 */
const PATH_KEYS = new Set(['file_path', 'path', 'paths', 'target', 'source', 'destination', 'cwd'])

/** 深度有限地遍历工具参数，收集路径字符串。 */
function collectPaths(value, sink, depth) {
  if (depth > 4 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (looksLikePath(value)) sink.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, sink, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (PATH_KEYS.has(key)) {
        collectPaths(child, sink, depth + 1)
        continue
      }
      if (child !== null && typeof child === 'object') collectPaths(child, sink, depth + 1)
    }
  }
}

/** 参数里承载「代码/命令正文」的键：路径藏在正文里，不在键名上。 */
const CODE_KEYS = new Set(['code', 'command', 'script', 'script_path'])

/**
 * 从代码或命令正文里抽路径。
 * run_code / bash 这类工具把真实路径写在参数正文里，只按键名白名单抓一定抓不到
 * （实测：整个长会话的「触及的文件」全是「（未识别到文件路径）」，就是这个原因）。
 */
const CODE_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|;,*\n\r]+|\/[A-Za-z0-9_.-]+\/[^\s"'<>|;,*\n\r]+/g

function pathsFromCode(text, sink) {
  if (typeof text !== 'string' || text.length < 4) return
  const matches = text.match(CODE_PATH_RE)
  if (matches === null) return
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,:;)\]}]+$/u, '')
    if (cleaned.length < 6 || cleaned.includes('*')) continue
    if (looksLikePath(cleaned)) sink.add(cleaned)
  }
}

/** 从一段 JSON 参数文本里抽路径。 */
function pathsFromArguments(argumentsText, sink) {
  if (typeof argumentsText !== 'string' || argumentsText.length === 0) return
  let parsed
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    // 参数不是合法 JSON（少见），直接在原文上兜底抽一次。
    pathsFromCode(argumentsText, sink)
    return
  }
  collectPaths(parsed, sink, 0)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (!CODE_KEYS.has(key) || typeof value !== 'string') continue
      pathsFromCode(value, sink)
    }
  }
}

/**
 * 系统注入的消息不是用户说的话。
 * 实测：system-reminder 是一条独立的 user/message（AGENTS.md 全文就挂在里面），
 * 旧代码把它当成「最近的用户指令」写进交接文档，新会话读到的是噪声。
 */
const INJECTED_PREFIXES = [
  '<system-reminder>',
  '<skill_content',
  '[Compressed conversation section]',
  'Current runtime context',
  'The following workspace instructions',
  'Updated instructions from:',
  // 宿主的采样时间戳也是一条独立 user/message，正文以这几句开头。
  // 实测它被当成「最近的用户指令」写进交接文档，把真正的指令挤掉了。
  'Time sampled while preparing turn',
  'Browser time zone for this request',
  'Elapsed since the preceding step context',
  // 后台任务完成回执也是宿主注入的，不是用户指令。
  'background job ',
]

function isInjectedUserText(text) {
  const head = text.trimStart()
  for (const prefix of INJECTED_PREFIXES) {
    if (head.startsWith(prefix)) return true
  }
  return false
}

/**
 * 只保留「真的存在」的路径，并且文件排在目录前面。
 *
 * 从工具参数正文里抽出来的东西天然带噪声（正则会把散文、URL 片段截成路径）。
 * 判据不该是「长得像路径」，而是「工作区里真的有它」——这条路走不通的就丢掉。
 * 全部都不存在时退回原列表，避免把「路径被删了」误报成「没识别到文件」。
 */
function pickExistingPaths(candidates, maxTrackedFiles) {
  const files = []
  const dirs = []
  const missing = []
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate)
      if (info.isFile()) files.push(candidate)
      else dirs.push(candidate)
    } catch {
      missing.push(candidate)
    }
  }
  const found = files.length + dirs.length
  const ordered = found === 0 ? candidates : [...files, ...dirs]
  return ordered.slice(0, maxTrackedFiles)
}

/** 从会话日志里抽取出可写进交接文档的事实。 */
function collectFacts(session, maxTrackedFiles) {
  const events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
  const userTexts = []
  const assistantTexts = []
  const toolCounts = new Map()
  const files = new Set()
  let toolCalls = 0
  let toolErrors = 0
  let injectedCount = 0

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (event.type === 'user/message') {
      const text = messageText(data)
      if (text === '') continue
      // system-reminder 之类是宿主注入，不是用户指令；写进交接文档只会误导新会话。
      if (isInjectedUserText(text)) {
        if (injectedCount === 0) logInfo('已跳过注入型 user/message（system-reminder 等）')
        injectedCount += 1
        continue
      }
      userTexts.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data !== null && typeof data === 'object' && data.message !== undefined ? data.message : data
      const text = messageText(message)
      if (text !== '') assistantTexts.push(text)
      continue
    }
    if (event.type === 'tool/call') {
      toolCalls += 1
      const toolName = data !== null && typeof data === 'object' && typeof data.name === 'string' ? data.name : 'unknown'
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1)
      if (data !== null && typeof data === 'object') pathsFromArguments(data.arguments, files)
      continue
    }
    if (event.type === 'tool/result') {
      if (data !== null && typeof data === 'object' && data.error !== undefined && data.error !== null) toolErrors += 1
    }
  }

  const firstUser = userTexts.length > 0 ? clampText(userTexts[0], 1200) : ''
  const recentUsers = userTexts.slice(-2).map((text) => clampText(text, 600))
  const recentAssistant = assistantTexts.slice(-2).map((text) => clampText(text, 1200))
  const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])
  const trackedFiles = pickExistingPaths([...files], maxTrackedFiles)

  return {
    firstUser,
    recentUsers,
    recentAssistant,
    toolCounts: sortedTools,
    files: trackedFiles,
    toolCalls,
    toolErrors,
    injectedCount,
    eventCount: events.length,
  }
}

/** 用事实拼出给模型看的摘要请求。 */
function buildSummaryPrompt(facts) {
  const toolLine =
    facts.toolCounts.length === 0
      ? '（无）'
      : facts.toolCounts
          .slice(0, 24)
          .map(([toolName, count]) => `${toolName}×${count}`)
          .join('、')
  return [
    '你在为一个即将结束的长会话撰写交接文档，新的会话会据此继续工作。',
    '请只输出下面三个小节，中文，简洁，不要寒暄，不要复述本指令。',
    '三个小节都要写，每节不超过 350 字；「下一步」必须写在最前面，因为它是新会话唯一真正要执行的东西。',
    '',
    '## 下一步',
    '（新会话应当立刻着手的具体动作，可执行、可验证）',
    '',
    '## 进度概述',
    '（这个任务已经做到哪一步，已产出什么）',
    '',
    '## 关键决定与坑',
    '（已确定的做法、已被排除的方向、失败过的地方）',
    '',
    '会话事实如下：',
    `- 原始目标：${facts.firstUser === '' ? '（未捕获）' : facts.firstUser}`,
    `- 最近的用户指令：${facts.recentUsers.length === 0 ? '（无）' : facts.recentUsers.join(' / ')}`,
    `- 最近的助手输出：${facts.recentAssistant.length === 0 ? '（无）' : facts.recentAssistant.join(' / ')}`,
    `- 工具使用：${toolLine}`,
    `- 触及文件：${facts.files.length === 0 ? '（未识别）' : facts.files.join('、')}`,
    `- 工具报错次数：${String(facts.toolErrors)}`,
  ].join('\n')
}

/**
 * 给 sessionController.prompt 造一个真正的 AbortSignal。
 *
 * 这不是防御性代码，是契约修复：宿主实现是 `async prompt(request, signal)`，
 * 第一行就 `signal.throwIfAborted()`。少传这个参数就抛 TypeError，
 * 而调用方（本插件旧版）在 catch 里删掉占位、下一轮重来，
 * 于是每轮都写一份文档、开一个空会话、简报一条都没送到。
 */
function promptSignal(signal) {
  if (signal !== undefined && signal !== null && typeof signal.throwIfAborted === 'function') return signal
  return new AbortController().signal
}

/**
 * 取会话实际运行的 agentPreset。
 * header.agentPreset 不可靠：实测 header 写 standard，日志里的 agent-preset/selected 写 ptc。
 * 优先用日志里最后一次选择，退化到 header。
 */
function resolvePreset(session) {
  try {
    const events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object' || event.type !== 'agent-preset/selected') continue
      const data = event.data
      const preset = data !== null && typeof data === 'object' ? data.agentPreset : undefined
      if (typeof preset === 'string' && preset !== '') return preset
    }
  } catch {
    /* 落到 header */
  }
  const header = session.header
  if (header !== null && typeof header === 'object' && typeof header.agentPreset === 'string' && header.agentPreset !== '') {
    return header.agentPreset
  }
  return undefined
}

/** 把 signal 与超时组合成一个可传下去的信号。 */
function withTimeout(signal, timeoutMs) {
  let timeoutSignal = null
  try {
    timeoutSignal = AbortSignal.timeout(timeoutMs)
  } catch {
    timeoutSignal = null
  }
  if (timeoutSignal === null) return signal
  if (signal === undefined || signal === null) return timeoutSignal
  try {
    return AbortSignal.any([signal, timeoutSignal])
  } catch {
    return timeoutSignal
  }
}

/**
 * 解析摘要该用哪个 provider/model。按可靠性从高到低依次尝试：
 *   1. 配置里显式指定的 summaryProvider / summaryModel
 *   2. 会话最近一次请求的 requestContext
 *   3. 会话最近一次请求头的 config
 *   4. 宿主默认模型（agentDefaultModel）
 *   5. 日志里最后一条 assistant 消息自带的 source
 * 任何一步拿到完整 (provider, model) 就返回；全失败返回 undefined，
 * 由调用方改用本地兜底摘要。
 */
function resolveSummaryRoute(ctx, session, options) {
  const usable = (provider, model) =>
    typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''

  if (usable(options.summaryProvider, options.summaryModel)) {
    return { provider: options.summaryProvider, model: options.summaryModel }
  }

  try {
    const requestContext = typeof session.requestContext === 'function' ? session.requestContext() : undefined
    if (requestContext !== undefined && requestContext !== null) {
      if (usable(requestContext.provider, requestContext.model)) {
        return { provider: requestContext.provider, model: requestContext.model }
      }
    }
  } catch {
    /* 下一步 */
  }

  try {
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    if (header !== undefined && header !== null && header.config !== undefined && header.config !== null) {
      if (usable(header.config.provider, header.config.model)) {
        return { provider: header.config.provider, model: header.config.model }
      }
    }
  } catch {
    /* 下一步 */
  }

  try {
    const agentDefaultModel = optionalService(ctx, 'agentDefaultModel')
    if (agentDefaultModel !== undefined && agentDefaultModel !== null && typeof agentDefaultModel.currentSelection === 'function') {
      const selection = agentDefaultModel.currentSelection()
      if (selection !== undefined && selection !== null && usable(selection.provider, selection.model)) {
        return { provider: selection.provider, model: selection.model }
      }
    }
  } catch {
    /* 下一步 */
  }

  try {
    const events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
      const data = event.data
      const message = data !== null && typeof data === 'object' && data.message !== undefined ? data.message : data
      const source = message !== null && typeof message === 'object' ? message.source : undefined
      if (source !== null && typeof source === 'object' && usable(source.provider, source.model)) {
        return { provider: source.provider, model: source.model }
      }
    }
  } catch {
    /* 放弃 */
  }

  return undefined
}

/** 请求模型生成摘要；任何失败都返回 undefined，让调用方走兜底。 */
async function requestModelSummary(ctx, session, facts, options, signal) {
  if (options.modelSummary !== true) return undefined
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') return undefined

  const route = resolveSummaryRoute(ctx, session, options)
  if (route === undefined) return undefined

  const chunks = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildSummaryPrompt(facts) }] }],
    // 输出预算必须跟着摘要上限走：中文摘要写满 1600 字要远超 1200 token，
    // 硬写 1200 会让模型在第三节中途被截断——那正是「下一步」整节消失的第四个来源。
    maxTokens: summaryTokenBudget(options.summaryMaxChars),
    signal: withTimeout(signal, options.summaryTimeoutMs),
  })

  const parts = []
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
    if (chunk.type === 'finish') break
  }
  const raw = parts.join('').trim()
  if (raw === '') return undefined
  // 按节裁剪，而不是把整段字符串一刀切：
  // 旧实现直接 clamp(1600) 砍尾巴，而「## 下一步」是模型的第三节，
  // 于是 8 份交接文档里 4 份整节丢掉「下一步」——新会话据此开工，却无路可走。
  return orderSummary(ensureNextStep(raw, facts), options.summaryMaxChars)
}

/** 兜底摘要：不调模型，只按事实给出一段可执行的下一步。 */
function fallbackSummary(facts) {
  const lines = []
  if (facts.recentUsers.length > 0) {
    lines.push(`- 最近一次用户要求：${facts.recentUsers[facts.recentUsers.length - 1]}`)
  }
  if (facts.toolCounts.length > 0) {
    const top = facts.toolCounts.slice(0, 6).map(([toolName, count]) => `${toolName}×${count}`).join('、')
    lines.push(`- 已使用工具：${top}`)
  }
  if (facts.toolErrors > 0) {
    lines.push(`- 有 ${String(facts.toolErrors)} 次工具调用报错，继续前先确认对应文件的真实状态，不要假设上一次操作成功。`)
  }
  if (facts.files.length > 0) {
    lines.push('- 先读取上面列出的文件确认当前内容，再继续。')
  }
  lines.push('- 从上面「最近一次用户要求」未完成的部分接着做；不要重做已经完成的步骤。')
  return lines.join('\n')
}

/**
 * 交接前 REVIEW：开新会话之前，先用确定性规则核对「这一棒交出去的东西能不能用」。
 *
 * 为什么是确定性规则而不是模型审（票 #13 的决定）：模型审要等 30–60 秒、还会随模型漂移；
 * 而这里要挡的是「交出去的东西缺东西」这类可以枚举的事实。模型审留作可选 L2。
 * 输出会同时写进交接文档和简报，让新会话第一眼就知道哪里没做完、下一步先修什么。
 */
function reviewHandoff(facts, meta, options) {
  const items = []
  const add = (level, title, detail) => items.push({ level, title, detail })

  if (facts.files.length === 0) {
    add('warn', '没有识别到任何触及的文件', '新会话没有锚点，只能靠文字复述找现场；检查工具参数里是不是把路径藏在正文里。')
  }
  if (facts.toolErrors > 0) {
    add('warn', `本轮有 ${String(facts.toolErrors)} 次工具报错`, '先确认这些报错是已解决还是被绕过；没解决的不要当成已完成。')
  }
  if (facts.injectedCount > 0) {
    add('info', `已滤除 ${String(facts.injectedCount)} 条宿主注入消息`, 'system-reminder / 时间戳 / 压缩段不是用户指令，不写进交接文档。')
  }
  const openTasks = countOpenChecklist(facts)
  if (openTasks > 0) {
    add('warn', `待办清单还有 ${String(openTasks)} 项未勾选`, '新会话必须先核对这些项的真实状态，不要直接当成已完成。')
  }
  if (facts.files.length > 0 && facts.toolCalls > 0 && facts.recentAssistant.length === 0) {
    add('warn', '没有捕获到助手输出', '交接文档会缺少「已经做到哪」的判断依据。')
  }
  const remaining = options.chainLimit - meta.chainDepth
  if (remaining <= 1) {
    add('warn', `交接链只剩 ${String(Math.max(0, remaining))} 棒`, `chainLimit=${String(options.chainLimit)}；再往下就会停在只写文档、不开新会话。`)
  }

  const blocking = items.filter((item) => item.level === 'block')
  const verdict = blocking.length > 0 ? 'block' : items.some((item) => item.level === 'warn') ? 'warn' : 'ok'
  return { verdict, items, openTasks }
}

/** 统计「- [ ]」形式的未完成项（只数用户自己列的清单）。 */
function countOpenChecklist(facts) {
  const texts = [facts.firstUser, ...facts.recentUsers]
  let total = 0
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue
    const matches = text.match(/^\s*[-*]\s+\[ \]/gmu)
    if (matches !== null) total += matches.length
  }
  return total
}

/** 把 REVIEW 结果渲染成一节。 */
function renderReview(review) {
  if (review === undefined) return []
  const label = { ok: '通过', warn: '有需要新会话注意的地方', block: '未通过' }[review.verdict] ?? review.verdict
  const lines = [`**结论：${label}**`, '']
  if (review.items.length === 0) {
    lines.push('- 未发现需要提示的问题。')
    return lines
  }
  const mark = { block: '⛔', warn: '⚠️', info: 'ℹ️' }
  for (const item of review.items) {
    lines.push(`- ${mark[item.level] ?? '-'} **${item.title}** —— ${item.detail}`)
  }
  return lines
}


/** 渲染交接文档。 */
function renderDoc(meta, facts, summary) {
  const toolTrail =
    facts.toolCounts.length === 0
      ? '（本轮没有工具调用）'
      : facts.toolCounts
          .slice(0, 20)
          .map(([toolName, count]) => `- \`${toolName}\` × ${String(count)}`)
          .join('\n')
  const fileList = facts.files.length === 0 ? '（未识别到文件路径）' : facts.files.map((file) => `- \`${file}\``).join('\n')
  const recentUserBlock = facts.recentUsers.length === 0 ? '（未捕获）' : facts.recentUsers.map((text) => `> ${text}`).join('\n>\n')
  const recentAssistantBlock =
    facts.recentAssistant.length === 0 ? '（未捕获）' : facts.recentAssistant.map((text) => `> ${text}`).join('\n>\n')

  return [
    '---',
    `session: ${meta.sessionId}`,
    `previous: ${meta.previousSessionId === '' ? '(none)' : meta.previousSessionId}`,
    `chain-root: ${meta.chainRoot}`,
    `chain-depth: ${String(meta.chainDepth)}`,
    `tokens: ${String(meta.tokens)}`,
    `tool-calls: ${String(facts.toolCalls)}`,
    `events: ${String(facts.eventCount)}`,
    `created-at: ${meta.createdAt}`,
    `created-by: ${LOG_PREFIX}`,
    '---',
    '',
    `# 会话交接文档 · ${meta.title}`,
    '',
    '> 本文件由 DSH 自动交接插件在上一会话达到阈值时生成。新会话请把它当作开工简报，' +
      '按「下一步」继续，不要重做已完成的部分。',
    '',
    // 顺序是刻意的：「进度与下一步」和「交接前 REVIEW」必须排在最前。
    // 注入副本会被 docMaxChars 截断，排在后面的段落先被砍；而这两节恰恰是
    // 新会话唯一必须读到的东西。实测旧顺序下 8 份文档有 4 份整节丢掉「下一步」。
    '## 进度与下一步',
    '',
    summary,
    '',
    '## 交接前 REVIEW',
    '',
    ...renderReview(meta.review),
    '',
    '## 原始目标',
    '',
    facts.firstUser === '' ? '（未捕获最早的用户指令）' : facts.firstUser,
    '',
    '## 最近的用户指令',
    '',
    recentUserBlock,
    '',
    '## 最近的助手输出',
    '',
    recentAssistantBlock,
    '',
    '## 触及的文件',
    '',
    fileList,
    '',
    '## 工具轨迹',
    '',
    toolTrail,
    '',
  ].join('\n')
}

/** 解析交接目录相对路径，兼容 `/` 与 `\\`。 */
function handoffDirectory(cwd, relativeDir) {
  const segments = relativeDir.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  return segments.length === 0 ? join(cwd, '.dsh', 'handoff') : join(cwd, ...segments)
}

/**
 * 链状态文件放在用户主目录下，不进工作区仓库：
 * 它是插件自己的运行账本，不该被用户的 git 提交带走。
 * 交接文档本体才写进工作区（用户要在新会话里读它）。
 */
function chainStatePath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home === '') return undefined
  return join(home, '.dsh', 'auto-handoff', STATE_FILE)
}

/** 读取链状态文件（不存在就返回空表）。 */
async function readChainState(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    const map = new Map()
    if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object') {
      for (const [sessionId, value] of Object.entries(parsed.sessions)) {
        if (value !== null && typeof value === 'object') {
          map.set(sessionId, {
            root: typeof value.root === 'string' ? value.root : sessionId,
            depth: Number.isFinite(Number(value.depth)) ? Number(value.depth) : 0,
          })
        }
      }
    }
    return map
  } catch {
    return new Map()
  }
}

/** 写链状态文件，最多保留 200 条；失败由调用方吞掉。 */
async function writeChainState(path, map) {
  const entries = [...map.entries()].slice(-200)
  const payload = { sessions: Object.fromEntries(entries), updatedAt: new Date().toISOString() }
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
}

/** 解析会话所在工作目录。 */
function resolveSessionCwd(ctx, session) {
  try {
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function') {
      const resolved = workingDirectory.get(session)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    }
  } catch {
    /* 继续走兜底 */
  }
  if (typeof session.header === 'object' && session.header !== null && typeof session.header.cwd === 'string') {
    return session.header.cwd
  }
  return process.cwd()
}

/** 读取会话标题（可能不存在）。 */
function resolveTitle(ctx, session) {
  try {
    const sessionTitle = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    if (sessionTitle !== undefined && sessionTitle !== null && typeof sessionTitle.get === 'function') {
      const snapshot = sessionTitle.get(session)
      if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string' && snapshot.title !== '') {
        return snapshot.title
      }
    }
  } catch {
    /* 忽略 */
  }
  return `会话 ${String(session.id).slice(0, 8)}`
}

/** 读取 token 压力；拿不到就返回 0（此时只靠工具调用计数触发）。 */
function measureTokens(ctx, session) {
  try {
    const tokenMeter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined
    if (tokenMeter === undefined || tokenMeter === null || typeof tokenMeter.measure !== 'function') return 0
    const measurement = tokenMeter.measure(session)
    if (measurement === null || typeof measurement !== 'object') return 0
    const total = Number(measurement.totalTokens)
    return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  } catch {
    return 0
  }
}

/** 只要服务在就返回它，否则 undefined（不做硬依赖）。 */
function optionalService(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

export { DEFAULTS, STATE_FILE }

/**
 * 插件入口：注册自动交接监听与 `/handoff` 命令。
 * @param ctx Cordis 上下文
 * @param config patch 里的原始配置
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)

  /**
   * 占位文件：跨进程存活的「这个会话已经交接过了」记录。
   * 原实现用内存 Set，进程一重启就忘，同一会话被反复交接——这是空会话疯涨的根因。
   */
  const claimsFile = claimsPath()

  /** sessionId → 工具调用次数（内存计数，重启归零；它只用于「这一轮」的判定） */
  const toolCallCounts = new Map()

  /**
   * 轮中闸只对每个会话开一次。
   * 计数是累计值，越过阈值之后每一次工具调用都会满足 next >= threshold，
   * 于是每个后续调用都重新抢一次占位——探针里一轮就开出 12 个新会话。
   * 占位表能挡住「同时两个」，但挡不住「一个接一个」这种串行重试。
   */
  const midTurnFired = new Set()

  /**
   * 已经为「终态但仍在跑」这件事记过一次证据的会话。
   * 交接不会关掉父会话（宿主有 cancel API，但直接 cancel 会打断用户正在做的事），
   * 所以父会话继续烧 token 是当前的设计后果。每个会话只记一次，避免又变成刷屏。
   */
  const terminalSeen = new Set()

  /** 把某个会话的占位状态说成人话（/handoff-status 用）。 */
  function describeClaim(sessionId) {
    const entry = readClaims(claimsFile).get(sessionId)
    if (entry === undefined) return '否'
    const at = entry.at === 0 ? '未知时间' : new Date(entry.at).toISOString()
    return `是（${entry.state}，${at}，第 ${String(entry.attempts)} 次）`
  }

  if (options.enabled !== true) {
    // 只读状态：给用户看当前会话离交接还有多远。
  ctx.commands.register({
    name: 'handoff-status',
    description: '查看当前会话的 token 压力、工具调用次数与交接阈值（只读，不触发交接）',
    handler: (invocation) => {
      try {
        const sessionId = String(invocation.agent.id)
        const session = ctx.sessions.get(invocation.agent.id)
        if (session === undefined || session === null) {
          return { kind: 'error', text: '找不到当前会话的日志。' }
        }
        const tokens = measureTokens(ctx, session)
        const toolCalls = toolCallCounts.get(sessionId) ?? 0
        const facts = collectFacts(session, options.maxTrackedFiles)
        const tokenPct = Math.min(100, Math.round((tokens / options.tokenThreshold) * 100))
        const toolPct = Math.min(100, Math.round((toolCalls / options.toolCallThreshold) * 100))
        const nearest = Math.max(tokenPct, toolPct)
        return {
          kind: 'success',
          text: [
            `会话 ${sessionId}`,
            `- token 压力：${String(tokens)} / ${String(options.tokenThreshold)}（${String(tokenPct)}%）`,
            `- 工具调用：${String(toolCalls)} / ${String(options.toolCallThreshold)}（${String(toolPct)}%）`,
            `- 日志事件数：${String(facts.eventCount)}，工具报错 ${String(facts.toolErrors)} 次`,
            `- 累计工具调用（含未入账）：${String(facts.toolCalls)}`,
            `- 距最近阈值：还剩 ${String(Math.max(0, 100 - nearest))}%`,
            `- 已交接：${describeClaim(sessionId)}；交接目录 ${handoffDirectory(resolveSessionCwd(ctx, session), options.handoffDir)}`,
            '任一阈值到 100% 的下一轮结束时自动交接；也可随时用 /handoff 手动触发。',
          ].join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: `读取状态失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  logInfo('已禁用（enabled=false），不注册任何监听。')
    return
  }

  /** sessionId → { root, depth }；懒加载 */
  let chainState = null
  const statePath = chainStatePath()

  /**
   * 取链状态，必要时从磁盘读一次。
   * 两个来源：占位表（每棒交接都会写，跨进程可靠）与旧 state.json（兼容历史数据）。
   * 占位表优先——旧账本实测从来没被写过（写它的代码在 prompt 之后，而 prompt 一直抛错）。
   */
  async function chainFor(sessionId) {
    const claim = readClaims(claimsFile).get(sessionId)
    if (claim !== undefined && typeof claim.chainRoot === 'string') {
      return { root: claim.chainRoot, depth: Number.isFinite(claim.chainDepth) ? claim.chainDepth : 0 }
    }
    if (statePath === undefined) return { root: sessionId, depth: 0 }
    if (chainState === null) chainState = await readChainState(statePath)
    const known = chainState.get(sessionId)
    return known === undefined ? { root: sessionId, depth: 0 } : known
  }

  // 工具调用计数：只统计非子代理的根会话，O(1)/事件。
  ctx.on('session/event', (session, event) => {
    try {
      if (session === null || session === undefined || event === null || event === undefined) return
      if (event.type !== 'tool/call') return
      const header = session.header
      if (header !== null && typeof header === 'object' && header.origin === 'subagent') return
      const id = session.id
      if (typeof id !== 'string') return
      const next = (toolCallCounts.get(id) ?? 0) + 1
      toolCallCounts.set(id, next)

      // 轮中硬兜底：不等本轮结束、不等模型自觉、不依赖任何提示词规则。
      // 工具调用数一过线就立刻交接，哪怕这一轮还在跑第 200 个工具调用。
      if (options.enforceMidTurn === true && next >= options.toolCallThreshold && !midTurnFired.has(id)) {
        const live = ctx.sessions.get(id)
        if (live === undefined || live === null) return
        const now = Date.now()
        const reserved = reserveClaim(claimsFile, id, options, now, false)
        if (!reserved.reserved) {
          midTurnFired.add(id)
          if (reserved.reason === 'done' || reserved.reason === 'stopped') {
            // 这一棒已经交接过（终态），之后每一次工具调用都是「旧会话还在继续跑」，
            // 不是重复触发，没有新信息。旧实现每次都记一行 INFO，实测刷出 926 行、
            // 占整个日志的 95%，把真正的失败信息埋掉了。
            // 但「父会话交接后还在烧 token」是真实成本，所以每个会话只留一条证据行，
            // 然后清零计数（留着不清又要重新累加到阈值才再进这里，纯属浪费）。
            if (!terminalSeen.has(id)) {
              terminalSeen.add(id)
              logInfo(`[${id}] 已交接（${reserved.reason}），但该会话仍在产生工具调用：交接不会关掉父会话。`)
            }
            toolCallCounts.delete(id)
            return
          }
          // 剩下的（inflight / cooldown / 次数用尽）是真正的竞态，值得留痕。
          logInfo(`[${id}] 轮中触发被占位拦下（${reserved.reason}），不重复交接`)
          return
        }
        midTurnFired.add(id)
        logInfo(`[${id}] 轮中触发：工具调用已达 ${String(next)} 次（阈值 ${String(options.toolCallThreshold)}），立即交接`)
        void (async () => {
          try {
            await performHandoff(live, 'mid-turn', undefined)
          } catch (error) {
            // 失败要放开闸门，否则这一棒就再也没有机会交接了。
            midTurnFired.delete(id)
            settleClaim(claimsFile, id, { state: 'failed', note: 'midturn-threw' }, Date.now())
            logWarn('轮中交接失败（已跳过，不影响当前轮）', error)
          }
        })()
      }
    } catch (error) {
      logWarn('统计工具调用失败', error)
    }
  })

  /** 执行一次完整交接，返回结果描述。 */
  async function performHandoff(session, trigger, signal) {
    const sessionId = String(session.id)
    const cwd = resolveSessionCwd(ctx, session)
    const dir = handoffDirectory(cwd, options.handoffDir)
    const tokens = measureTokens(ctx, session)
    const facts = collectFacts(session, options.maxTrackedFiles)
    const title = resolveTitle(ctx, session)
    const chain = await chainFor(sessionId)
    const nextDepth = chain.depth + 1

    let summary
    try {
      summary = await requestModelSummary(ctx, session, facts, options, signal)
    } catch (error) {
      logWarn('模型摘要失败，改用兜底摘要', error)
      summary = undefined
    }
    const summaryUsed = typeof summary === 'string' && summary !== ''
    if (!summaryUsed) summary = fallbackSummary(facts)

    const createdAt = new Date().toISOString()
    // REVIEW 必须在渲染之前：它要能把「这一棒交出去会缺什么」写进文档，
    // 也让「接下来会卡在哪里」对上一棒可见，而不是等新会话撞墙才发现。
    const review = reviewHandoff(facts, { chainDepth: nextDepth }, options)
    if (review.verdict !== 'ok') {
      logInfo(`交接前 REVIEW ${review.verdict}：${review.items.map((item) => item.title).join('；')}`)
    }
    const docBody = renderDoc(
      {
        sessionId,
        previousSessionId: chain.depth === 0 ? '' : chain.root,
        chainRoot: chain.root,
        chainDepth: nextDepth,
        tokens,
        createdAt,
        title,
        review,
      },
      facts,
      summary,
    )
    // 盘上写全文，只把注入新会话的那一份裁到 docMaxChars。
    // 旧实现把整篇裁到 6000 字再落盘，结果「进度与下一步」这一节（全篇最有用的部分）
    // 因为排在最后被整段砍掉——实测 10780 字的文档只剩 6006 字，下一步一个字没留。
    const docText = clampText(docBody, Math.max(options.docMaxChars * 4, 40000))
    const injectedText = clampText(docBody, options.docMaxChars)
    const docPath = join(dir, `${sessionId}.md`)

    await mkdir(dir, { recursive: true })
    await writeFile(docPath, docText, 'utf8')

    const base = {
      sessionId,
      docPath,
      tokens,
      toolCalls: facts.toolCalls,
      trigger,
      summaryUsed,
      chainRoot: chain.root,
      chainDepth: nextDepth,
    }

    if (nextDepth > options.chainLimit) {
      // 到顶之后必须把占位落成 stopped（终态），否则它会停在 inflight，
      // TTL 一过又能再交接一次——实测探针里同一棒被反复续作 35 次，chainLimit 形同废纸。
      // 落 stopped 的含义是：这条链到此为止，要再往前走请人工 /handoff。
      settleClaim(
        claimsFile,
        sessionId,
        { state: 'stopped', docPath, chainRoot: chain.root, chainDepth: chain.depth, note: 'chain-limit' },
        Date.now(),
      )
      logWarn(`交接链深度已达上限 ${String(options.chainLimit)}，本次只写文档不自动续作：${docPath}`)
      return { ...base, newSessionId: undefined, stoppedByChainLimit: true }
    }

    const controller = optionalService(ctx, 'sessionController')
    if (controller === undefined || controller === null || typeof controller.create !== 'function') {
      logWarn(`缺少 sessionController，无法自动开新会话；交接文档已写入 ${docPath}`)
      settleClaim(claimsFile, sessionId, { state: 'stopped', docPath, note: 'no-session-controller' }, Date.now())
      return { ...base, newSessionId: undefined, stoppedByChainLimit: false }
    }

    // 新会话必须继承原会话实际运行的 agentPreset，否则工具集可能与上一棒不一致。
    // 注意：header.agentPreset 实测不可靠（header 记 standard，日志里 agent-preset/selected 记 ptc），
    // 所以优先从事件里取最后一次选择。
    const preset = resolvePreset(session)

    // 先把「这一棒的新会话」记进链状态，再建会话：
    // 顺序反了的话，新会话一开起来就看不到自己属于哪条链，链深永远是 0。
    const depthForNew = nextDepth
    settleClaim(
      claimsFile,
      sessionId,
      { state: 'inflight', docPath, chainRoot: chain.root, chainDepth: chain.depth },
      Date.now(),
    )

    let created
    try {
      created = await controller.create(preset === undefined ? { cwd } : { cwd, agentPreset: preset })
    } catch (error) {
      settleClaim(claimsFile, sessionId, { state: 'failed', docPath, note: 'create-failed' }, Date.now())
      throw error
    }
    const newSessionId = created !== null && typeof created === 'object' ? String(created.sessionId) : ''
    if (newSessionId === '') {
      logWarn('新建会话未返回 id，交接中止')
      settleClaim(claimsFile, sessionId, { state: 'failed', docPath, note: 'create-no-id' }, Date.now())
      return { ...base, newSessionId: undefined, stoppedByChainLimit: false }
    }

    const reviewLine =
      review.verdict === 'ok'
        ? ''
        : `\n交接前 REVIEW 结论：${review.verdict}。${review.items.map((item) => item.title).join('；')}。开工前先核对这几条，别当成已完成。\n`
    const promptText = [
      `[自动交接] 上一会话 ${sessionId} 达到阈值（${String(tokens)} tokens / ${String(facts.toolCalls)} 次工具调用），` +
        `已把进度写入 \`${docPath}\`。下面是同一份交接文档的全文，直接据此继续，不要重复已完成的工作。`,
      reviewLine,
      '===== 交接文档开始 =====',
      injectedText,
      '===== 交接文档结束 =====',
      '',
      '请立刻从「下一步」开始推进；如果发现文档与工作区实际不一致，以工作区实际为准并说明差异。',
    ].join('\n')

    // 记账必须在 prompt 之前：prompt 是唯一会抛错的步骤，
    // 而旧实现把账本写在 prompt 之后，于是账本一次都没被写过（实测停在 197 字节 / 2026-11-05）。
    // 新会话登记的只是「链上第几棒」，不是「已经交接过」——
    // 用 inflight/done 会让它 24 小时内（或永远）没法再交接，链条就停在第二棒。
    // 未知状态在 canAutoHandoff 里等价于「可以交接」，正好是这里要的语义。
    reserveClaim(claimsFile, newSessionId, options, Date.now(), true)
    settleClaim(
      claimsFile,
      newSessionId,
      { state: 'genesis', docPath, chainRoot: chain.root, newSessionId, chainDepth: depthForNew },
      Date.now(),
    )

    try {
      // 第二参数是 AbortSignal，不是可选的：宿主实现第一行就是 signal.throwIfAborted()。
      // 旧代码只传一个参数 → TypeError → 简报永远送不出去（实测 86 个会话 0 送达）。
      await controller.prompt(
        {
          requestId: `auto-handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: newSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        },
        promptSignal(signal),
      )
    } catch (error) {
      settleClaim(
        claimsFile,
        sessionId,
        { state: 'failed', docPath, newSessionId, note: 'prompt-failed: ' + (error instanceof Error ? error.message : String(error)) },
        Date.now(),
      )
      settleClaim(claimsFile, newSessionId, { state: 'failed', docPath, note: 'prompt-failed' }, Date.now())
      logWarn(`交接简报投递失败：${sessionId} → ${newSessionId}；文档已写入 ${docPath}`, error)
      return { ...base, newSessionId, stoppedByChainLimit: false, promptFailed: true }
    }

    settleClaim(
      claimsFile,
      sessionId,
      { state: 'done', docPath, newSessionId, chainRoot: chain.root, chainDepth: chain.depth },
      Date.now(),
    )
    // 新会话这一条不能写 done：done 是终态，canAutoHandoff 会一直拦它，
    // 于是链条永远停在第二棒、chainLimit 形同废纸。
    // 写 genesis 表示「这一棒刚开出来，链深已登记，随时可以再交接」。
    settleClaim(
      claimsFile,
      newSessionId,
      { state: 'genesis', docPath, chainRoot: chain.root, newSessionId, chainDepth: depthForNew },
      Date.now(),
    )

    // 简报已经送达，子会话开始接棒。父会话此刻还活着——它不会因为交接而停下，
    // 实测会继续跑 70 分钟、和子会话一起烧 token（用户抱怨的正是这个）。
    // 宿主其实给了 cancel({ sessionId })：它会取消当前轮，但 keepInbox 保留未处理队列。
    // 默认取消；cancelParentAfterHandoff=false 可退回「不打扰旧会话」的旧行为。
    let parentCancelled = false
    // 手动 /handoff 不取消：调用方就是那个会话自己，取消会把它正在执行的命令打断。
    // 自动路径（轮中 / 轮末）才属于「接力棒已经递出去，旧的那一棒该停了」。
    if (options.cancelParentAfterHandoff === true && trigger !== 'manual') {
      const canceller = optionalService(ctx, 'sessionController')
      if (canceller !== undefined && canceller !== null && typeof canceller.cancel === 'function') {
        try {
          // 宿主实现是同步返回 { accepted: true }，但远程壳层可能包成 Promise；
          // 两种都要兜住，否则一次未捕获的 rejection 会冒到宿主的事件循环里。
          const accepted = canceller.cancel({ sessionId })
          parentCancelled = true
          if (accepted !== null && typeof accepted === 'object' && typeof accepted.then === 'function') {
            accepted.then(undefined, (error) => {
              logInfo(`父会话取消请求被拒绝（${error instanceof Error ? error.message : String(error)}）`)
            })
          }
        } catch (error) {
          // 旧会话已经 detach（跑完自然结束）时会抛 session/not-found —— 这是正常情况。
          logInfo(`父会话无需取消或已结束（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
    }

    if (statePath !== undefined) {
      if (chainState === null) chainState = new Map()
      chainState.set(newSessionId, { root: chain.root, depth: nextDepth })
      chainState.set(sessionId, { root: chain.root, depth: chain.depth })
      try {
        await writeChainState(statePath, chainState)
      } catch (error) {
        logWarn('写入链状态失败（不影响本次交接）', error)
      }
    }

    logInfo(
      `已交接：${sessionId} → ${newSessionId}（${String(tokens)} tokens / ${String(facts.toolCalls)} 次工具调用）` +
        (parentCancelled ? '，父会话当前轮已取消' : ''),
      docPath,
    )
    return { ...base, newSessionId, stoppedByChainLimit: false, parentCancelled }
  }

  // 每轮结束（工具调用全部收尾）时检查阈值。这里同步判定、异步执行：
  // 绝不把这轮关轮拖住 40 秒去等摘要。
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      if (agent === null || agent === undefined || typeof agent.id !== 'string') return
      const sessionId = String(agent.id)

      const session = ctx.sessions.get(agent.id)
      if (session === undefined || session === null) return
      const header = session.header
      if (header !== null && typeof header === 'object' && header.origin === 'subagent') return

      const tokens = measureTokens(ctx, session)
      const toolCalls = toolCallCounts.get(sessionId) ?? 0
      if (tokens < options.tokenThreshold && toolCalls < options.toolCallThreshold) return

      // 同步占位（落盘），避免同一轮内与跨进程重复派发。
      const reserved = reserveClaim(claimsFile, sessionId, options, Date.now(), false)
      if (!reserved.reserved) {
        // 终态说明这一棒早就交接过，父会话只是还在跑——每个会话只留一条证据行。
        if (reserved.reason === 'done' || reserved.reason === 'stopped') {
          if (!terminalSeen.has(sessionId)) {
            terminalSeen.add(sessionId)
            logInfo(`[${sessionId}] 已交接（${reserved.reason}），但该会话仍在产生工具调用：交接不会关掉父会话。`)
          }
          return
        }
        logInfo(`[${sessionId}] 阈值已过但占位拦下（${reserved.reason}），不重复交接`)
        return
      }
      void (async () => {
        try {
          await performHandoff(session, 'threshold', undefined)
        } catch (error) {
          // 抛在半路（写盘失败之类）会把占位留在 inflight，24 小时内谁都接不了这一棒。
          // 落成 failed：有冷却、有次数上限，过一会儿还能重试。
          settleClaim(claimsFile, sessionId, { state: 'failed', note: 'handoff-threw' }, Date.now())
          logWarn('自动交接失败（已跳过，不影响当前轮）', error)
        }
      })()
    } catch (error) {
      logWarn('交接阈值检查失败（已跳过）', error)
    }
  })

  // 手动触发：/handoff
  ctx.commands.register({
    name: 'handoff',
    description: '立即把当前会话压缩成交接文档，并开新会话继续（自动交接的手动版）',
    handler: async (invocation) => {
      try {
        const sessionId = String(invocation.agent.id)
        const session = ctx.sessions.get(invocation.agent.id)
        if (session === undefined || session === null) {
          return { kind: 'error', text: '找不到当前会话的日志，无法生成交接文档。' }
        }
        // 手动路径：允许在被占位拦下之后强制再来一次（人明确要求了），
        // 但正在进行中的那一次不能被打断，否则会两条链并行。
        const reserved = reserveClaim(claimsFile, sessionId, options, Date.now(), true)
        if (!reserved.reserved) {
          return {
            kind: 'error',
            text: `本会话正在交接中（${reserved.reason}），请等这一步结束后再试；或到新会话里继续。`,
          }
        }
        const result = await performHandoff(session, 'manual', invocation.signal)
        if (result.newSessionId === undefined) {
          const extra = result.stoppedByChainLimit ? `（交接链已达上限 ${String(options.chainLimit)}）` : '（未能自动开新会话）'
          return { kind: 'success', text: `交接文档已写入 ${result.docPath} ${extra}。请手动开一个新会话并粘贴该文档继续。` }
        }
        const delivery = result.promptFailed === true ? '简报投递失败（见日志），请手动把交接文档贴进新会话。' : '新会话已收到交接文档并开始继续；本会话可以关掉了。'
        return {
          kind: result.promptFailed === true ? 'error' : 'success',
          text:
            `已交接：本会话 ${sessionId} → 新会话 ${result.newSessionId}\n` +
            `文档：${result.docPath}\n` +
            `阈值状态：${String(result.tokens)} tokens / ${String(result.toolCalls)} 次工具调用\n` +
            `摘要来源：${result.summaryUsed ? '模型生成' : '本地兜底'}\n` +
            delivery,
        }
      } catch (error) {
        logWarn('手动交接失败', error)
        return { kind: 'error', text: `交接失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // 只读状态：给用户看当前会话离交接还有多远。
  ctx.commands.register({
    name: 'handoff-status',
    description: '查看当前会话的 token 压力、工具调用次数与交接阈值（只读，不触发交接）',
    handler: (invocation) => {
      try {
        const sessionId = String(invocation.agent.id)
        const session = ctx.sessions.get(invocation.agent.id)
        if (session === undefined || session === null) {
          return { kind: 'error', text: '找不到当前会话的日志。' }
        }
        const tokens = measureTokens(ctx, session)
        const toolCalls = toolCallCounts.get(sessionId) ?? 0
        const facts = collectFacts(session, options.maxTrackedFiles)
        const tokenPct = Math.min(100, Math.round((tokens / options.tokenThreshold) * 100))
        const toolPct = Math.min(100, Math.round((toolCalls / options.toolCallThreshold) * 100))
        const nearest = Math.max(tokenPct, toolPct)
        return {
          kind: 'success',
          text: [
            `会话 ${sessionId}`,
            `- token 压力：${String(tokens)} / ${String(options.tokenThreshold)}（${String(tokenPct)}%）`,
            `- 工具调用：${String(toolCalls)} / ${String(options.toolCallThreshold)}（${String(toolPct)}%）`,
            `- 日志事件数：${String(facts.eventCount)}，工具报错 ${String(facts.toolErrors)} 次`,
            `- 距最近阈值：还剩 ${String(Math.max(0, 100 - nearest))}%`,
            `- 已交接：${describeClaim(sessionId)}`,
            `- 交接目录：${handoffDirectory(resolveSessionCwd(ctx, session), options.handoffDir)}`,
            '任一阈值到 100% 的下一轮结束时自动交接；也可随时用 /handoff 手动触发。',
          ].join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: `读取状态失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  logInfo(
    `已启用：token 阈值 ${String(options.tokenThreshold)} / 工具调用阈值 ${String(options.toolCallThreshold)}，` +
      `交接目录 ${options.handoffDir}，模型摘要 ${options.modelSummary ? '开' : '关'}，链上限 ${String(options.chainLimit)}`,
  )
}
