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
import { claimsPath, readClaims, reserveClaim, settleClaim, activeHops } from './claims.js'
import { DOC_BEGIN, DOC_END, INDEX_SECTIONS, renderBriefMeta, renderFacts, renderIndex, stripBriefMeta } from './docs.js'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-auto-handoff'

/** 启动前必须就位的服务。 */
export const inject = ['commands', 'sessions']

/** 默认选项。 */
const DEFAULTS = {
  enabled: true,
  // 0 表示「没显式指定」，按 tokenThresholdRatio × 模型窗口换算。
  // 旧版写死 300000：本机窗口实测 1,000,000，等于 30% 就满足，token 闸长期在 30% 抖动。
  tokenThreshold: 0,
  tokenThresholdRatio: 0.45,
  toolCallThreshold: 80,
  handoffDir: '.dsh/handoff',
  modelSummary: true,
  maxAutoHops: 8,
  maxConcurrentHops: 2,
  concurrentWindowMs: 1800000,
  summaryMaxChars: 1600,
  briefMaxChars: 6000,
  briefTargetChars: 3000,
  goalMaxChars: 4000,
  summaryTimeoutMs: 45000,
  maxTrackedFiles: 40,
  summaryProvider: '',
  summaryModel: '',
  enforceMidTurn: true,
  claimTtlMs: 86400000,
  retryCooldownMs: 600000,
  maxAttempts: 3,
  cancelParentAfterHandoff: true,
  modelReview: false,
  reviewBlockOn: ['no-goal', 'no-next-step', 'chain-limit'],
  toolErrorWarnRatio: 0.2,
}

const STATE_FILE = 'state.json'
const LOG_PREFIX = '[auto-handoff]'

/** 设置页表单：每个字段都带中文说明，缺省值即 DEFAULTS。 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('总开关。关闭后不注册任何监听与命令。'),
  tokenThreshold: z
    .number()
    .step(1000)
    .min(0)
    .default(DEFAULTS.tokenThreshold)
    .description('会话累计 token 压力的绝对阈值；填 0 表示不设绝对值，改用下面的比例换算（默认）。'),
  tokenThresholdRatio: z
    .number()
    .step(0.01)
    .min(0.1)
    .max(0.95)
    .default(DEFAULTS.tokenThresholdRatio)
    .description('按模型上下文窗口的比例触发交接（0.45 = 窗口用到 45%）。实测窗口 1,000,000，写死绝对值会在窗口变化后失效。'),
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
  maxAutoHops: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULTS.maxAutoHops)
    .description('自动续作链最多几棒（chainLimit 是它的旧名，仍然认）。到顶后只写文档、不再自动开新会话，并在会话标题标出。'),
  maxConcurrentHops: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULTS.maxConcurrentHops)
    .description('同一工作目录同时最多有几棒在跑（genesis/inflight 计数）。超限落 deferred 排队，不判失败。'),
  concurrentWindowMs: z
    .number()
    .step(60000)
    .min(60000)
    .default(DEFAULTS.concurrentWindowMs)
    .description('排队多久后自动重试（毫秒）。这是 deferred 的等待窗口，不是超时。'),
  summaryMaxChars: z
    .number()
    .step(100)
    .min(400)
    .default(DEFAULTS.summaryMaxChars)
    .description('模型摘要写入文档前的字符上限。'),
  briefMaxChars: z
    .number()
    .step(100)
    .min(1000)
    .default(DEFAULTS.briefMaxChars)
    .description('注入新会话的 index.md 硬上限（字符）。必留两节超了也按行截断，但不丢整节。'),
  briefTargetChars: z
    .number()
    .step(100)
    .min(500)
    .default(DEFAULTS.briefTargetChars)
    .description('index.md 的目标长度；超过就从最末一个非必留小节往前丢，直到落进目标。'),
  goalMaxChars: z
    .number()
    .step(100)
    .min(400)
    .default(DEFAULTS.goalMaxChars)
    .description('「原始目标」一节的字符上限。比摘要上限大得多是刻意的：它要装得下整条交接链的原始目标。'),
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
  modelReview: z
    .boolean()
    .default(DEFAULTS.modelReview)
    .description('交接前 REVIEW 的 L2 模型审：多一次模型调用，只提醒不刹车。默认关——L1 确定性规则已经覆盖可枚举的事实。'),
  reviewBlockOn: z
    .array(z.string())
    .default(DEFAULTS.reviewBlockOn)
    .description('L1 里哪些项判 block（不建新会话、父会话落 failed 等人工 /handoff）。可选 no-goal / no-next-step / chain-limit。'),
  toolErrorWarnRatio: z
    .number()
    .step(0.05)
    .min(0.05)
    .max(1)
    .default(DEFAULTS.toolErrorWarnRatio)
    .description('工具报错占比超过它就 warn（报错数 / 工具调用数）。按比例而不是按次数，短会话不会因一两次失败被判 warn。'),
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

/** 结构化事件文件：一行一 JSON，只写决策点（票 #20 定稿）。 */
const EVENTS_FILE = 'events.jsonl'
const EVENTS_MAX_BYTES = 5 * 1024 * 1024
const EVENTS_KEEP = 5

/**
 * 追加一条结构化事件。
 *
 * 为什么另开一个文件、而不是把 .log 改成 JSON：
 *   · .log 是给人读的，handoff-check 之类脚本已经在按行匹配中文；
 *   · events.jsonl 是给脚本断言的，字段固定、一行一个 JSON。
 * 两者混在一起，任何一方改格式都会打断另一方。
 */
function appendEvent(event) {
  try {
    const dir = runtimeDir()
    if (dir === undefined) return
    mkdirSync(dir, { recursive: true })
    const file = join(dir, EVENTS_FILE)
    try {
      if (statSync(file).size > EVENTS_MAX_BYTES) {
        for (let index = EVENTS_KEEP - 1; index >= 1; index -= 1) {
          try {
            renameSync(join(dir, `events.${String(index)}.jsonl`), join(dir, `events.${String(index + 1)}.jsonl`))
          } catch {
            /* 该份还不存在 */
          }
        }
        renameSync(file, join(dir, 'events.1.jsonl'))
      }
    } catch {
      /* 首次写，正常 */
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8')
  } catch {
    /* 事件失败即放弃 */
  }
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

/** 读一个小数（比例用；0 也算有效值）。 */
function readFloat(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 读一个字符串数组（reviewBlockOn 用）。 */
function readList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return list.length === 0 ? fallback : list
}

/** 把 patch 里的原始 config 归一化成完整选项。 */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  // chainLimit 是 maxAutoHops 的旧名：老配置、老文档、老测试都还在用，必须继续认。
  const hops = readInt(raw.maxAutoHops, readInt(raw.chainLimit, DEFAULTS.maxAutoHops))
  return {
    enabled: readBool(raw.enabled, DEFAULTS.enabled),
    // tokenThreshold 填 0（或不填）表示不设绝对值，走窗口比例。
    tokenThreshold: readInt(raw.tokenThreshold, DEFAULTS.tokenThreshold),
    tokenThresholdRatio: readFloat(raw.tokenThresholdRatio, DEFAULTS.tokenThresholdRatio),
    toolCallThreshold: readInt(raw.toolCallThreshold, DEFAULTS.toolCallThreshold),
    handoffDir: readText(raw.handoffDir, DEFAULTS.handoffDir),
    modelSummary: readBool(raw.modelSummary, DEFAULTS.modelSummary),
    maxAutoHops: hops,
    // chainLimit 保留为别名，供旧代码路径与 /handoff 文案引用。
    chainLimit: hops,
    maxConcurrentHops: readInt(raw.maxConcurrentHops, DEFAULTS.maxConcurrentHops),
    concurrentWindowMs: readInt(raw.concurrentWindowMs, DEFAULTS.concurrentWindowMs),
    summaryMaxChars: readInt(raw.summaryMaxChars, DEFAULTS.summaryMaxChars),
    briefMaxChars: readInt(raw.briefMaxChars, DEFAULTS.briefMaxChars),
    briefTargetChars: readInt(raw.briefTargetChars, DEFAULTS.briefTargetChars),
    goalMaxChars: readInt(raw.goalMaxChars, DEFAULTS.goalMaxChars),
    summaryTimeoutMs: readInt(raw.summaryTimeoutMs, DEFAULTS.summaryTimeoutMs),
    maxTrackedFiles: readInt(raw.maxTrackedFiles, DEFAULTS.maxTrackedFiles),
    summaryProvider: readText(raw.summaryProvider, DEFAULTS.summaryProvider),
    summaryModel: readText(raw.summaryModel, DEFAULTS.summaryModel),
    enforceMidTurn: readBool(raw.enforceMidTurn, DEFAULTS.enforceMidTurn),
    claimTtlMs: readInt(raw.claimTtlMs, DEFAULTS.claimTtlMs),
    retryCooldownMs: readInt(raw.retryCooldownMs, DEFAULTS.retryCooldownMs),
    maxAttempts: readInt(raw.maxAttempts, DEFAULTS.maxAttempts),
    cancelParentAfterHandoff: readBool(raw.cancelParentAfterHandoff, DEFAULTS.cancelParentAfterHandoff),
    modelReview: readBool(raw.modelReview, DEFAULTS.modelReview),
    reviewBlockOn: readList(raw.reviewBlockOn, DEFAULTS.reviewBlockOn),
    toolErrorWarnRatio: readFloat(raw.toolErrorWarnRatio, DEFAULTS.toolErrorWarnRatio),
  }
}

/** 截断一段文本，超出时显式标注。 */
function clampText(text, maxChars) {
  if (typeof text !== 'string') return ''
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, maxChars) + '…（已截断）'
}

/** 交接简报的首行前缀：出现它说明这条 user/message 是上一棒塞进来的整份简报。 */
const HANDOFF_PREFIX = '[自动交接]'

/** 文档正文里可能出现的二级小节标题（用于判断「原始目标」到哪为止）。 */
const DOC_SECTION_TITLES = new Set([
  // full.md（人看）的八节
  '进度与下一步',
  '交接前 REVIEW',
  '原始目标',
  '最近的用户指令',
  '最近的助手输出',
  '触及的文件',
  '工具轨迹',
  // index.md（注入）的六节
  '目标',
  '下一步',
  '约束与禁区',
  '未决问题',
  '档案索引',
])

/**
 * 从一段文本里取出 `## 原始目标` 这一节的正文。
 *
 * 只看行首精确匹配的标题，遇到下一个已知小节标题或文档结束分隔行就停——
 * 不用「下一个 ## 任意标题」当边界，因为用户的目标本身可能就带 Markdown 标题
 * （链根那份 1489 字目标里就有 `# 关键决定与坑` 一类的行）。
 */
function goalSection(text) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split('\n')
  // 两种标题都认：v1.2 起 index.md 的第一节叫「## 目标」（短），
  // full.md 里的第五节仍叫「## 原始目标」（全）。两者取到的都是用户原话。
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '## 原始目标' || trimmed === '## 目标') {
      start = index + 1
      break
    }
  }
  if (start === -1) return ''
  const body = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === DOC_END) break
    const heading = /^##\s+(.+?)\s*$/.exec(trimmed)
    if (heading !== null && DOC_SECTION_TITLES.has(heading[1])) break
    body.push(line)
  }
  return body.join('\n').trim()
}

/** 交接简报首行里的文档路径：`已把进度写入 \`<path>\``。 */
const DOC_PATH_RE = /已把进度写入\s*`([^`]+\.md)`/u

/**
 * 从简报正文里解析出上一棒交接文档的路径，再**读盘**取它的「## 原始目标」一节。
 *
 * 为什么必须读盘：注入副本被字数上限截断（v1.1 的 `docMaxChars`、v1.2 的 `briefMaxChars`），
 * 正文里的嵌套文档只是残缺开头，递归下钻到第二层就没有再下一层的 `## 原始目标` 了（实测 693 字处断掉）。
 * 而盘上那份是全的——每一棒的文档都在 `.dsh/handoff/<session>/` 里（v1.2 前是平铺的 `<session>.md`），
 * 顺着简报里的路径一跳一跳读回链根，才能拿到用户的原话。
 */
function docPathFromText(text) {
  const match = DOC_PATH_RE.exec(text)
  return match === null ? '' : match[1]
}

function goalFromDocPath(docPath) {
  if (typeof docPath !== 'string' || docPath === '') return ''
  try {
    if (statSync(docPath).isFile() !== true) return ''
    return goalSection(readFileSync(docPath, 'utf8'))
  } catch {
    // 文档被删了、路径不可读——都不是错误，退回正文下钻即可。
    return ''
  }
}

/**
 * 还原「用户真正说的第一句话」。
 *
 * 链上每一棒的首条 user/message 都是上一棒注入的**整份交接简报**，而旧实现直接
 * `clampText(userTexts[0], 1200)` 塞进「## 原始目标」，于是每深一层就多嵌一层旧文档：
 * 实测 depth 6 那份文档的「原始目标」只剩 693 字、本身又以 `[自动交接]` 开头，
 * 真正的目标（含 13 项验收清单）在第 2 层就丢了。
 *
 * 下钻分两条路，按可靠性排序：
 *   1. **读盘**：从简报首行取出上一棒文档路径，读全文再取它的「## 原始目标」——
 *      盘上那份不截断，可以一路读到链根；
 *   2. 读不到盘（文档被删/挪走）时，退回在正文里找 `## 原始目标` 一节，
 *      能穿透一层就是一层。
 * 两条都拿不到新内容就停，最多 10 层；末尾按 `goalMaxChars` 截断。
 */
function unwrapGoal(text, maxChars) {
  // v1.2 的简报在第一行插了「链：第 N 棒 / 上限 M …」元信息，它在「[自动交接]」之前。
  // 不先剥掉，startsWith(HANDOFF_PREFIX) 会判成「这不是交接简报」，于是整份嵌套简报
  // 被当成用户原话写进「原始目标」——I-14 刚修完的同类事故会立刻复发。
  let current = typeof text === 'string' ? stripBriefMeta(text).trim() : ''
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULTS.goalMaxChars
  // 防环靠「读过哪些文档路径」，不是靠文本指纹：链上相邻两棒的「原始目标」经常
  // 长度相同、尾 64 字也相同（都是被同一处截断的嵌套开头），用指纹会把正常下钻误判成环。
  const seenDocs = new Set()
  for (let depth = 0; depth < 12; depth += 1) {
    if (!current.startsWith(HANDOFF_PREFIX)) break

    const docPath = docPathFromText(current)
    if (docPath !== '') {
      if (seenDocs.has(docPath)) break
      seenDocs.add(docPath)
      const fromDisk = goalFromDocPath(docPath)
      if (fromDisk !== '' && fromDisk !== current) {
        current = fromDisk
        continue
      }
    }

    const section = goalSection(current)
    if (section === '' || section === current) break
    current = section
  }
  return clampText(current, limit)
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
 * 「下一步」这一节有多少实质内容。
 * 去掉列表符号（- * 1. 2)）、勾选框、行内空白后数剩下的字数：
 * 空壳写法（「（待定）」「TODO」「…」）会被算成 0–4 个字。
 */
function nextStepSubstance(text) {
  if (typeof text !== 'string') return 0
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\[.?\]|\s+/gu, ''))
    .join('')
  // 空壳占位写法单独判：它们字数不多不少，纯数长度会被当成有效内容。
  if (/^(?:待定|暂无|无|todo|tbd|n\/a|…|\.{2,})$/iu.test(stripped)) return 0
  return stripped.length
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

/** 从一条 message 的 content 里拼出纯文本（只认 text 块：用户消息走的都是这条）。 */
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
 * 助手消息的正文提取：text 块之外，还要认 reasoning 与 tool-call。
 *
 * 原实现只认 text 块，而当前 provider（trae-enterprise / DeepSeek-V4.1-Flash）
 * 的助手消息几乎从不带 text：实测 session-5ddd6bb5 的 80 条 `assistant/message` 里
 * block 统计是 `{"reasoning":71,"tool-call":80,"text":1}`——整条消息常常只有
 * 「一段思考 + 一个工具调用」。于是：
 *   · 「最近的助手输出」必然为空，交接文档里永远是「（未捕获）」；
 *   · REVIEW 每次都误报「没有捕获到助手输出」；
 *   · 摘要请求里这一段写「（无）」，新会话失去唯一一条「已经做到哪」的依据。
 *
 * 退一步的判据：没有 text 就用 reasoning（模型的自我说明），再附上这一条消息
 * 里发出的工具调用名。都不是最终答案，但足以说明「做到哪一步、在动什么」。
 */
function assistantText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const texts = []
  const reasoning = []
  const calls = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
      continue
    }
    if ((block.type === 'reasoning' || block.type === 'thinking') && typeof block.text === 'string') {
      reasoning.push(block.text)
      continue
    }
    if (block.type === 'tool-call' && typeof block.name === 'string' && block.name !== '') calls.push(block.name)
  }
  // text 是真正的答复，优先；没有 text 才退到 reasoning。
  const body = (texts.length > 0 ? texts : reasoning).join('\n').trim()
  const digest = calls.length === 0 ? '' : `（调用工具：${[...new Set(calls)].join('、')}）`
  return [body, digest].filter((part) => part !== '').join('\n').trim()
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
 * 这条 user/message 的**来源**（票 #29 定稿的主判据）。
 *
 * 前缀白名单是猜的，source.kind 是宿主自己标的。实测扫最近 60 个会话：
 *   真用户轮 68 条，前缀白名单误杀 0；
 *   注入轮 1038 条，前缀白名单漏 42 条（ptc-mode 11 / agent-message-relay 10 /
 *   subagent-settled 9 / model-selection 8 / repeat-tool-reminder 2 / user-approval 2）。
 * 漏掉的那些会被当成「最近的用户指令」写进交接文档，新会话读到的是宿主噪声。
 */
function userSourceKind(data) {
  if (data === null || typeof data !== 'object') return undefined
  const source = data.source
  if (source === null || typeof source !== 'object') return undefined
  return typeof source.kind === 'string' && source.kind !== '' ? source.kind : undefined
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
function collectFacts(session, maxTrackedFiles, goalMaxChars) {
  const events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
  const userTexts = []
  const assistantTexts = []
  // 只有工具调用、没有一句说明的助手消息。单独存一份是为了「有正文时不用它」：
  // 交接文档要的是「做到哪」，纯工具名只能当没有正文时的最后兜底。
  const assistantDigests = []
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
      // 判据顺序：宿主标的 source.kind 优先（真值），前缀白名单只做兜底
      // （老会话日志没有 source 字段，那时候只能靠前缀猜）。
      const kind = userSourceKind(data)
      const injected = kind === undefined ? isInjectedUserText(text) : kind !== 'user'
      if (injected) {
        if (injectedCount === 0) logInfo('已跳过注入型 user/message（system-reminder 等）')
        injectedCount += 1
        continue
      }
      userTexts.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data !== null && typeof data === 'object' && data.message !== undefined ? data.message : data
      const text = assistantText(message)
      if (text === '') continue
      if (text.startsWith('（调用工具：')) assistantDigests.push(text)
      else assistantTexts.push(text)
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

  // 「原始目标」不能用摘要上限那种小钳位，也不能原样收录交接简报（会层层嵌套）。
  const firstUser = userTexts.length > 0 ? unwrapGoal(userTexts[0], goalMaxChars) : ''
  const recentUsers = userTexts.slice(-2).map((text) => clampText(text, 600))
  const assistantBodies = assistantTexts.length > 0 ? assistantTexts : assistantDigests
  const recentAssistant = assistantBodies.slice(-2).map((text) => clampText(text, 1200))
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

  /**
   * block 必须在 reviewBlockOn 里点名才生效。
   *
   * 旧实现 `const blocking = items.filter(i => i.level === 'block')` 恒为空——
   * 全仓 grep "add('block'" 命中 0 处，日志里 REVIEW block 也是 0 次，
   * 于是「判不通过怎么办」根本没有触发路径（票 #17 的证据）。
   */
  const blockOn = Array.isArray(options.reviewBlockOn) ? options.reviewBlockOn : []
  const blocks = (key) => blockOn.includes(key)
  const bad = (key, title, detail) => add(blocks(key) ? 'block' : 'warn', title, detail)

  // ① 没有原始目标：新会话不知道自己在为谁干活，交出去等于交出一份无主文档。
  if (facts.firstUser === '' || facts.firstUser.trim() === '') {
    bad('no-goal', '没有捕获到原始目标', '链上第一句话不是用户指令，新会话无法判断自己在做什么；先人工确认目标再交棒。')
  }
  // ② 摘要里没有「## 下一步」：实测 4 份简报有 3 份被模型漏写（票 #29 的证据）。
  // 兜底生成失败时不能硬交——新会话第一句读到的是「接着做」，但接着做什么没人说。
  const summaryText = typeof meta.summaryText === 'string' ? meta.summaryText : ''
  // 只判「有没有这一节」不够：模型很爱写「## 下一步\n（待定）」这种空壳，
  // 标题在、正文是废话，新会话照样无路可走。
  // 判据取「去掉列表符号与空白之后还剩多少字」，外加一份空壳占位词表
  // （待定 / 暂无 / TODO / …）：「1. 跑一遍测试」「继续」都算有效，
  // 「## 下一步\n（待定）」不算。
  const nextStepText = hasNextStep(summaryText) ? summarySectionText(summaryText, '下一步') : ''
  if (nextStepSubstance(nextStepText) < 2) {
    bad('no-next-step', '摘要里没有可执行的「下一步」', '模型摘要漏了下一步（或只写了空壳），兜底也没生成出来；新会话打开简报的第一件事会是重新摸索，先补一句再交棒。')
  }
  if (facts.files.length === 0) {
    add('warn', '没有识别到任何触及的文件', '新会话没有锚点，只能靠文字复述找现场；检查工具参数里是不是把路径藏在正文里。')
  }
  // ② 工具报错改成按比例：短会话一两次失败不该被判 warn，长会话 20% 才算真的不稳。
  const errorRatio = facts.toolCalls > 0 ? facts.toolErrors / facts.toolCalls : 0
  const warnRatio = Number.isFinite(options.toolErrorWarnRatio) ? options.toolErrorWarnRatio : 0.2
  if (errorRatio > warnRatio) {
    add(
      'warn',
      `工具报错占比 ${String(Math.round(errorRatio * 100))}%`,
      `本轮 ${String(facts.toolCalls)} 次工具调用里 ${String(facts.toolErrors)} 次报错，超过 ${String(Math.round(warnRatio * 100))}% 的阈值；先确认这些报错是已解决还是被绕过。`,
    )
  }
  // ③ 注入消息是每次 48–177 条的常态，原来按 info 也刷了 6 行，降成 debug（不进 items）。
  const openTasks = countOpenChecklist(facts)
  if (openTasks > 0) {
    add('warn', `待办清单还有 ${String(openTasks)} 项未勾选`, '新会话必须先核对这些项的真实状态，不要直接当成已完成。')
  }
  if (facts.files.length > 0 && facts.toolCalls > 0 && facts.recentAssistant.length === 0) {
    add('warn', '没有捕获到助手输出', '交接文档会缺少「已经做到哪」的判断依据。')
  }
  // ④ 链到顶：这一棒交不出去任何后续，交出去只会让人以为还在自动推进。
  const limit = Number.isFinite(options.maxAutoHops) ? options.maxAutoHops : options.chainLimit
  const remaining = limit - meta.chainDepth
  if (remaining < 0) {
    bad('chain-limit', `自动续作已到第 ${String(meta.chainDepth)}/${String(limit)} 棒`, '这一棒不会再自动开新会话，需要人工 /handoff 才能继续。')
  } else if (remaining <= 1) {
    add('warn', `交接链只剩 ${String(Math.max(0, remaining))} 棒`, `maxAutoHops=${String(limit)}；再往下就会停在只写文档、不开新会话。`)
  }

  const blocking = items.filter((item) => item.level === 'block')
  const verdict = blocking.length > 0 ? 'block' : items.some((item) => item.level === 'warn') ? 'warn' : 'ok'
  return { verdict, items, openTasks, blocked: blocking.length > 0 }
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
    // 注入副本会按字数上限截断（v1.1 的 docMaxChars、v1.2 的 briefMaxChars），排在后面的段落先被砍；而这两节恰恰是
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

/** 从摘要里取某一节的正文（按标题关键字，没有就返回空串）。 */
function summarySectionText(summary, keyword) {
  for (const section of splitSummarySections(summary)) {
    if (section.title.includes(keyword)) return section.body.join('\n').trim()
  }
  return ''
}

/**
 * 组装 index.md 的六节（票 #29 定稿）。
 *
 * 六节的**顺序即裁剪优先级**：前两节 required，预算不够时从最后一节往前丢。
 * 「目标」和「下一步」是必留——新会话缺了前者不知道为谁干活，缺了后者不知道做什么。
 */
function indexSections(facts, summary, review, paths, pendingLine) {
  const nextStep = summarySectionText(summary, '下一步')
  const decision = summarySectionText(summary, '决定') || summarySectionText(summary, '关键')
  const open = []
  if (typeof pendingLine === 'string' && pendingLine !== '') open.push(pendingLine)
  if (review !== undefined && review !== null && review.openTasks > 0) {
    open.push('- 交接时待办清单还有 ' + String(review.openTasks) + ' 项未勾选，新会话必须先核对真实状态。')
  }
  for (const item of review === undefined || review === null ? [] : review.items) {
    if (item.level === 'block' || item.level === 'warn') open.push('- ' + item.title + '：' + item.detail)
  }
  const reviewText = review === undefined || review === null ? '' : renderReview(review).join('\n')
  const indexLines = facts.files.slice(0, 20).map((file) => '- ' + file)
  if (paths !== undefined && paths !== null) {
    indexLines.push('- 完整档案（人看）：' + paths.fullPath)
    indexLines.push('- 事实档案（机读，不注入）：' + paths.factsPath)
  }
  return {
    '目标': facts.firstUser,
    '下一步': nextStep,
    '约束与禁区': decision,
    '未决问题': open.join('\n'),
    '交接前 REVIEW': reviewText,
    '档案索引': indexLines.join('\n'),
  }
}

/**
 * 把事实摊平成 facts.jsonl 的条目（票 #29 定稿的六类 type）。
 *
 * 为什么单独存一份：这些内容**不注入**新会话（注入只花 token 不给收益），
 * 但人复盘、脚本断言、以及以后要「按需查」时需要一个可 parse 的底座。
 */
function factsEntries(facts, review, meta) {
  const entries = []
  let seq = 0
  const push = (type, text, ref) => {
    seq += 1
    entries.push({ id: 'f' + String(seq), type, text, ref: ref === undefined ? '' : ref, at: meta.createdAt })
  }
  if (facts.firstUser !== '') push('user', facts.firstUser, 'first')
  for (const text of facts.recentUsers) push('user', text, 'recent')
  for (const text of facts.recentAssistant) push('assistant', text, '')
  for (const file of facts.files) push('file', file, '')
  for (const pair of facts.toolCounts.slice(0, 20)) push('tool', pair[0] + ' × ' + String(pair[1]), '')
  if (facts.toolErrors > 0) push('error', '本轮工具报错 ' + String(facts.toolErrors) + ' 次', '')
  if (review !== undefined && review !== null) {
    const titles = review.items.map((item) => item.title).join('；')
    push('decision', '交接前 REVIEW ' + review.verdict + (titles === '' ? '' : '：' + titles), 'review')
  }
  return entries
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

/**
 * 读取 token 压力。
 *
 * 返回 { tokens, reason }，reason 为空表示读数可信；否则说明**为什么**是 0。
 * 旧实现一律 return 0 且零留痕，于是 tokenMeter 服务缺失时 token 闸静默归零，
 * 表面上插件「在跑」，实际只剩工具调用闸在工作（票 #15 的第二类现网故障）。
 */
function measureTokens(ctx, session) {
  let tokenMeter
  try {
    tokenMeter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined
  } catch (error) {
    return { tokens: 0, reason: 'tokenMeter-unavailable: ' + (error instanceof Error ? error.message : String(error)) }
  }
  if (tokenMeter === undefined || tokenMeter === null) return { tokens: 0, reason: 'no-tokenMeter' }
  if (typeof tokenMeter.measure !== 'function') return { tokens: 0, reason: 'no-measure' }
  try {
    const measurement = tokenMeter.measure(session)
    if (measurement === null || typeof measurement !== 'object') return { tokens: 0, reason: 'empty-measurement' }
    const total = Number(measurement.totalTokens)
    if (!Number.isFinite(total)) return { tokens: 0, reason: 'non-numeric-total' }
    return { tokens: total > 0 ? Math.floor(total) : 0, reason: total > 0 ? '' : 'zero' }
  } catch (error) {
    return { tokens: 0, reason: 'measure-threw: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 会话当前路由的上下文窗口。
 *
 * 宿主（app.asar 类型表）里 RequestContext = { provider, model, contextWindow?, ... }，
 * session.requestContext() 拿的就是它。contextWindow 缺席说明 adapter 没有声明容量，
 * 这时不能猜，只能退回保守默认值。
 */
function contextWindowOf(session) {
  try {
    if (typeof session.requestContext !== 'function') return 0
    const rc = session.requestContext()
    if (rc === null || typeof rc !== 'object') return 0
    const window = Number(rc.contextWindow)
    return Number.isFinite(window) && window > 0 ? Math.floor(window) : 0
  } catch {
    return 0
  }
}

/** 窗口读不到时的保守默认值：本机实测所有路由都是 1,000,000。 */
const FALLBACK_CONTEXT_WINDOW = 1000000

/**
 * token 闸的生效阈值（票 #20 定稿）。
 *
 * 写死 300000 等于「不管什么模型都按 30% 切」，而实测窗口 1,000,000、
 * 真实交接发生在 45%–84%——真正的限制是「轮末才检查」这个时机，不是阈值。
 * 所以默认走比例，绝对值只用来显式覆盖。
 */
function effectiveTokenThreshold(session, options) {
  const ratio = Number.isFinite(options.tokenThresholdRatio) ? options.tokenThresholdRatio : 0.45
  if (Number.isFinite(options.tokenThreshold) && options.tokenThreshold > 0) {
    return { threshold: options.tokenThreshold, source: 'absolute', window: contextWindowOf(session), ratio }
  }
  const window = contextWindowOf(session)
  if (window > 0) {
    return { threshold: Math.max(1000, Math.floor(window * ratio)), source: 'ratio', window, ratio }
  }
  return { threshold: Math.max(1000, Math.floor(FALLBACK_CONTEXT_WINDOW * ratio)), source: 'ratio-fallback', window: 0, ratio }
}

/**
 * 一条链的可读账本：`~/.dsh/auto-handoff/chains/<root>.json`（票 #18 定稿）。
 *
 * 为什么与 claims.json 分开：claims 是每个会话一行的**热路径**（每轮闸门都要同步读），
 * chain.json 是每条链一份的**冷数据**（人看、脚本查「这条链走了几棒、谁变孤儿」）。
 * 混在一张表里，热路径每次都要扫全链。
 */
function chainJsonPath(root) {
  const dir = runtimeDir()
  if (dir === undefined || typeof root !== 'string' || root === '') return undefined
  return join(dir, 'chains', `${root}.json`)
}

/** 读一条链的账本；没有或坏了都返回一个空壳（不能让观测数据阻断交接）。 */
function readChainJson(root) {
  const path = chainJsonPath(root)
  const empty = { root, cwd: '', startedAt: new Date().toISOString(), limit: 0, hops: [], orphans: [], stopped: false }
  if (path === undefined) return empty
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return empty
    return {
      root: typeof parsed.root === 'string' && parsed.root !== '' ? parsed.root : root,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : empty.startedAt,
      limit: Number.isFinite(Number(parsed.limit)) ? Number(parsed.limit) : 0,
      hops: Array.isArray(parsed.hops) ? parsed.hops : [],
      orphans: Array.isArray(parsed.orphans) ? parsed.orphans : [],
      stopped: parsed.stopped === true,
    }
  } catch {
    return empty
  }
}

/** 写一条链的账本；失败只记日志，不影响交接。 */
function writeChainJson(root, data) {
  const path = chainJsonPath(root)
  if (path === undefined || data === null || typeof data !== 'object') return
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const payload = { ...data, updatedAt: new Date().toISOString() }
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    logWarn('写入链账本失败（不影响本次交接）', error)
  }
}

/**
 * 给会话改名，让它在 GUI 侧栏里能被人认出来（票 #18）。
 *
 * 实测重启后 7 个 root 会话 header 的 title 全为 null，人在侧栏看到一排
 * 一模一样的「新会话」——链到顶、REVIEW 未通过、排队中、孤儿这四类人工停点
 * 如果只写在日志里，等于没写。rename 是宿主给的正式 API，失败不影响主流程。
 */
function renameSession(ctx, sessionId, title) {
  try {
    const controller = optionalService(ctx, 'sessionController')
    if (controller === null || controller === undefined || typeof controller.rename !== 'function') return false
    const result = controller.rename({ sessionId, title })
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(undefined, (error) => {
        logInfo(`会话改名被拒绝（${error instanceof Error ? error.message : String(error)}）`)
      })
    }
    return true
  } catch (error) {
    logInfo(`会话改名失败（${error instanceof Error ? error.message : String(error)}）`)
    return false
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

  /**
   * 「被占位拦下」的原因去重表：同一会话同一原因只记一条。
   * 只用来去重日志，**绝不阻止**它之后再触发——被 inflight/cooldown 拦下是暂时的，
   * 把「暂时」当「永久」写进 midTurnFired 就会让链条静默停摆（ISSUES I-12）。
   */
  const blockedNoted = new Set()

  /**
   * 同一 cwd 里还活着（genesis / inflight）的其它棒有几个。
   *
   * 实测重启后 19 分钟里同一目录发生了 6 次交接、合计 376 万 token，
   * 6 个父会话全都还活着——并发不是理论风险，是现状（票 #18）。
   */
  function countActiveHops(cwd, sessionId, now) {
    try {
      return activeHops(readClaims(claimsFile), cwd, sessionId, now).length
    } catch {
      return 0
    }
  }
  /** 把某个会话的占位状态说成人话（/handoff-status 用）。 */
  function describeClaim(sessionId) {
    const entry = readClaims(claimsFile).get(sessionId)
    if (entry === undefined) return '否'
    const at = entry.at === 0 ? '未知时间' : new Date(entry.at).toISOString()
    return `是（${entry.state}，${at}，第 ${String(entry.attempts)} 次）`
  }

  /**
   * /handoff-status 的正文。
   *
   * 两个注册点（enabled=false 与正常路径）共用一份实现：旧实现各写一份，
   * 停用态那份还在用 options.tokenThreshold 做除法，改成比例阈值后必然除零。
   */
  function describeStatus(ctx, session, sessionId) {
    const tokenInfo = measureTokens(ctx, session)
    const tokens = tokenInfo.tokens
    const window = effectiveTokenThreshold(session, options)
    const toolCalls = toolCallCounts.get(sessionId) ?? 0
    const facts = collectFacts(session, options.maxTrackedFiles, options.goalMaxChars)
    const tokenPct = window.threshold > 0 ? Math.min(100, Math.round((tokens / window.threshold) * 100)) : 0
    const toolPct = options.toolCallThreshold > 0 ? Math.min(100, Math.round((toolCalls / options.toolCallThreshold) * 100)) : 0
    const nearest = Math.max(tokenPct, toolPct)
    const claim = readClaims(claimsFile).get(sessionId)
    const siblings = countActiveHops(resolveSessionCwd(ctx, session), sessionId, Date.now())
    const lines = [
      '会话 ' + sessionId,
      '- token 压力：' + String(tokens) + ' / ' + String(window.threshold) + '（' + String(tokenPct) + '%，' +
        window.source + '；窗口 ' + String(window.window === 0 ? '未知' : window.window) + '）',
      '- 工具调用：' + String(toolCalls) + ' / ' + String(options.toolCallThreshold) + '（' + String(toolPct) + '%）',
      '- 日志事件数：' + String(facts.eventCount) + '，工具报错 ' + String(facts.toolErrors) + ' 次',
      '- 距最近阈值：还剩 ' + String(Math.max(0, 100 - nearest)) + '%',
      '- 已交接：' + describeClaim(sessionId),
      '- 同目录同伴棒：' + String(siblings) + ' 个（上限 ' + String(options.maxConcurrentHops) + '）',
      '- 交接目录：' + handoffDirectory(resolveSessionCwd(ctx, session), options.handoffDir),
    ]
    if (tokenInfo.reason !== '' && tokenInfo.reason !== 'zero') {
      lines.push('- ⚠️ token 读数不可信：' + tokenInfo.reason + '（token 闸已按比例兜底）')
    }
    if (claim !== undefined && Number.isFinite(claim.chainDepth)) {
      lines.push('- 链：第 ' + String(claim.chainDepth) + ' 棒 / 上限 ' + String(options.maxAutoHops) + ' ｜ 根 ' + String(claim.chainRoot ?? sessionId))
    }
    lines.push('任一阈值到 100% 的下一轮结束时自动交接；也可随时用 /handoff 手动触发。')
    return lines.join('\n')
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
        const statusText = describeStatus(ctx, session, sessionId)
        return { kind: 'success', text: statusText }
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
          // 剩下的（inflight / cooldown / 次数用尽）是真正的竞态，值得留痕——
          // 但只留一次：同一个会话同一个原因重复喊没有新信息。
          // 关键是**不能**在这里 midTurnFired.add(id)：那等于把「暂时被拦」当成
          // 「这一棒永远不用再管」，占位一放开链条就永久停摆，而日志看上去一切正常
          // （本会话就这么停了一整轮，见 ISSUES.md I-12）。
          const noteKey = id + '|' + reserved.reason
          if (!blockedNoted.has(noteKey)) {
            blockedNoted.add(noteKey)
            logInfo(`[${id}] 轮中触发被占位拦下（${reserved.reason}），不重复交接`)
          }
          return
        }
        midTurnFired.add(id)
        blockedNoted.clear()
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
    const tokenInfo = measureTokens(ctx, session)
    const tokens = tokenInfo.tokens
    const windowInfo = effectiveTokenThreshold(session, options)
    // 闸门判定用的是这个累计计数，日志里也必须记它。
    // 旧实现日志写的是 facts.toolCalls（collectFacts 数的历史总数），
    // 与判定用的 toolCallCounts 是两个数，复盘时永远对不上（票 #20）。
    const gateToolCalls = toolCallCounts.get(sessionId) ?? 0
    const facts = collectFacts(session, options.maxTrackedFiles, options.goalMaxChars)
    const title = resolveTitle(ctx, session)
    const chain = await chainFor(sessionId)
    const nextDepth = chain.depth + 1
    const now0 = Date.now()
    const siblings = countActiveHops(cwd, sessionId, now0)
    if (tokenInfo.reason !== '' && tokenInfo.reason !== 'zero') {
      appendEvent({ event: 'gate/skip', sessionId, cwd, reason: 'token-unavailable: ' + tokenInfo.reason })
    }

    let summary
    try {
      summary = await requestModelSummary(ctx, session, facts, options, signal)
    } catch (error) {
      logWarn('模型摘要失败，改用兜底摘要', error)
      summary = undefined
    }
    const summaryUsed = typeof summary === 'string' && summary !== ''
    // 兜底摘要必须自带「## 下一步」这一节：
    // REVIEW 的 no-next-step 规则看的是**有没有这一节且有正文**，而 fallbackSummary
    // 返回的是若干条项目符号、没有节标题，直接塞进去会让「模型不可用」被判成
    // 「交接内容缺东西」，于是无模型时整条链一次都交不出去。
    if (!summaryUsed) summary = '## 下一步' + String.fromCharCode(10) + fallbackSummary(facts)

    const createdAt = new Date().toISOString()
    const maxHops = Number.isFinite(options.maxAutoHops) ? options.maxAutoHops : options.chainLimit
    const overLimit = nextDepth > maxHops
    // REVIEW 必须在渲染之前：它要能把「这一棒交出去会缺什么」写进文档，
    // 也让「接下来会卡在哪里」对上一棒可见，而不是等新会话撞墙才发现。
    const review = reviewHandoff(facts, { chainDepth: nextDepth, summaryText: summary }, options)
    const reviewTitles = review.items.map((item) => item.title).join('；')
    appendEvent({
      event: 'review/verdict',
      sessionId,
      cwd,
      verdict: review.verdict,
      itemCount: review.items.length,
      blocked: review.blocked,
      openTasks: review.openTasks,
      items: reviewTitles,
    })
    if (review.verdict !== 'ok') logInfo('交接前 REVIEW ' + review.verdict + '：' + reviewTitles)

    // 三份文件（票 #29 定稿）：index.md 注入、facts.jsonl 不注入、full.md 人看。
    // 旧实现只有一份被 6000 字截断的文档，最贵的两节排在末尾，实测 8 份里 4 份整节丢「下一步」。
    const docsDir = join(dir, sessionId)
    const docPath = join(docsDir, 'index.md')
    const factsPath = join(docsDir, 'facts.jsonl')
    const fullPath = join(docsDir, 'full.md')

    // 到顶那一棒必须把「为什么停了」写进文档本身（票 #18 三件事之一）。
    const pendingLine = overLimit
      ? '- 自动续作已到第 ' + String(nextDepth) + '/' + String(maxHops) + ' 棒，这一棒之后不会再自动开新会话；要继续请人工 /handoff。'
      : ''
    const indexText = renderIndex({
      meta: {
        sessionId,
        title,
        chainRoot: chain.root,
        chainDepth: nextDepth,
        hopLimit: maxHops,
        tokens,
        toolCalls: gateToolCalls,
        trigger,
        reviewVerdict: review.verdict,
        createdAt,
      },
      sections: indexSections(facts, summary, review, { fullPath, factsPath }, pendingLine),
      options,
    })
    const fullText = clampText(
      renderDoc(
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
      ),
      Math.max(options.briefMaxChars * 4, 40000),
    )
    const factsText = renderFacts(factsEntries(facts, review, { createdAt }))

    await mkdir(docsDir, { recursive: true })
    await writeFile(docPath, indexText, 'utf8')
    await writeFile(factsPath, factsText === '' ? '' : factsText + '\n', 'utf8')
    await writeFile(fullPath, fullText, 'utf8')
    appendEvent({
      event: 'doc/write',
      sessionId,
      cwd,
      docPath,
      chars: indexText.length,
      factsChars: factsText.length,
      fullChars: fullText.length,
      reviewVerdict: review.verdict,
    })

    const base = {
      sessionId,
      docPath,
      tokens,
      toolCalls: gateToolCalls,
      trigger,
      summaryUsed,
      chainRoot: chain.root,
      chainDepth: nextDepth,
      reviewVerdict: review.verdict,
    }

    // ── 链到顶：只写文档 + 三件可见的事（票 #18） ──
    if (overLimit) {
      // 到顶之后必须把占位落成 stopped（终态），否则它会停在 inflight，
      // TTL 一过又能再交接一次——实测探针里同一棒被反复续作 35 次，上限形同废纸。
      // 落 stopped 的含义是：这条链到此为止，要再往前走请人工 /handoff。
      settleClaim(
        claimsFile,
        sessionId,
        {
          state: 'stopped',
          docPath,
          chainRoot: chain.root,
          chainDepth: chain.depth,
          note: 'chain-limit',
          stoppedReason: 'chain-limit',
          stoppedAt: new Date().toISOString(),
          reviewVerdict: review.verdict,
          tokens,
          toolCalls: gateToolCalls,
        },
        Date.now(),
      )
      renameSession(ctx, sessionId, '[链到顶 ' + String(nextDepth) + '/' + String(maxHops) + '] ' + title)
      const chainData = readChainJson(chain.root)
      writeChainJson(chain.root, { ...chainData, root: chain.root, cwd, limit: maxHops, stopped: true })
      appendEvent({ event: 'chain/limit', sessionId, cwd, depth: nextDepth, limit: maxHops, docPath })
      logWarn('交接链已达上限 ' + String(maxHops) + '，本次只写文档不自动续作：' + docPath)
      return { ...base, newSessionId: undefined, stoppedByChainLimit: true }
    }

    // ── REVIEW 不通过：这一棒根本不建新会话（票 #17 定稿） ──
    // 旧实现里 block 规则一条都没有，verdict 只可能是 ok/warn，所以「判不通过怎么办」
    // 从来没被触发过。现在 block 的三种情形都是「交出去必然坏事」：没目标、没下一步、链到顶。
    if (review.blocked === true) {
      settleClaim(
        claimsFile,
        sessionId,
        {
          state: 'failed',
          docPath,
          chainRoot: chain.root,
          chainDepth: chain.depth,
          note: 'review-block',
          reviewVerdict: review.verdict,
          tokens,
          toolCalls: gateToolCalls,
        },
        Date.now(),
      )
      renameSession(ctx, sessionId, '[REVIEW 未通过] ' + title)
      appendEvent({ event: 'claim/settle', sessionId, cwd, state: 'failed', reason: 'review-block', reviewVerdict: review.verdict })
      logWarn('交接前 REVIEW 未通过，本次不建新会话：' + reviewTitles + '；文档已写入 ' + docPath)
      return { ...base, newSessionId: undefined, stoppedByChainLimit: false, blockedByReview: true }
    }

    // ── 同目录并发超限：不判失败，排队（deferred 是非终态，下一轮自动重试） ──
    if (siblings >= options.maxConcurrentHops) {
      const deferredUntil = now0 + options.concurrentWindowMs
      settleClaim(
        claimsFile,
        sessionId,
        {
          state: 'deferred',
          docPath,
          chainRoot: chain.root,
          chainDepth: chain.depth,
          note: 'concurrent-limit',
          deferredUntil,
          reviewVerdict: review.verdict,
          tokens,
          toolCalls: gateToolCalls,
        },
        Date.now(),
      )
      renameSession(ctx, sessionId, '[排队交接 ' + String(siblings + 1) + '/' + String(options.maxConcurrentHops) + '] ' + title)
      appendEvent({
        event: 'gate/skip',
        sessionId,
        cwd,
        reason: 'concurrent-limit',
        siblings,
        deferredUntil: new Date(deferredUntil).toISOString(),
      })
      logInfo('[' + sessionId + '] 同目录已有 ' + String(siblings) + ' 棒在跑，超过上限 ' + String(options.maxConcurrentHops) + '，本次排队到 ' + new Date(deferredUntil).toISOString())
      return { ...base, newSessionId: undefined, stoppedByChainLimit: false, deferred: true }
    }

    const controller = optionalService(ctx, 'sessionController')
    if (controller === undefined || controller === null || typeof controller.create !== 'function') {
      logWarn('缺少 sessionController，无法自动开新会话；交接文档已写入 ' + docPath)
      settleClaim(claimsFile, sessionId, { state: 'stopped', docPath, note: 'no-session-controller' }, Date.now())
      const chainData = readChainJson(chain.root)
      writeChainJson(chain.root, { ...chainData, root: chain.root, cwd, limit: maxHops, stopped: true })
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
    appendEvent({ event: 'session/create', sessionId, cwd, depth: nextDepth, preset: preset === undefined ? '' : preset })

    let created
    try {
      created = await controller.create(preset === undefined ? { cwd } : { cwd, agentPreset: preset })
    } catch (error) {
      settleClaim(claimsFile, sessionId, { state: 'failed', docPath, note: 'create-failed' }, Date.now())
      appendEvent({ event: 'error', sessionId, cwd, stage: 'create', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const newSessionId = created !== null && typeof created === 'object' ? String(created.sessionId) : ''
    if (newSessionId === '') {
      logWarn('新建会话未返回 id，交接中止')
      settleClaim(claimsFile, sessionId, { state: 'failed', docPath, note: 'create-no-id' }, Date.now())
      return { ...base, newSessionId: undefined, stoppedByChainLimit: false }
    }

    // 简报首行永远是元信息（票 #18）：链第几棒、上限、根、触发点、同伴数。
    // 人在侧栏只能看到标题（实测 7/7 为 null），模型看的第一行就是这行。
    const reviewLabel = { ok: '通过', warn: '有需要新会话注意的地方', block: '未通过' }[review.verdict] ?? review.verdict
    const reviewLine =
      '交接前 REVIEW 结论：' + reviewLabel + (reviewTitles === '' ? '。' : '。' + reviewTitles + '。开工前先核对这几条，别当成已完成。')
    const promptText = [
      renderBriefMeta({
        hop: nextDepth,
        limit: maxHops,
        root: chain.root,
        trigger,
        tokens,
        toolCalls: gateToolCalls,
        siblings,
      }),
      '[自动交接] 上一会话 ' + sessionId + ' 达到阈值（' + String(tokens) + ' tokens / ' + String(gateToolCalls) + ' 次工具调用），' +
        '已把进度写入 ' + docPath + '（全文 ' + fullPath + '，事实档案 ' + factsPath + '）。' +
        '下面是交接简报，直接据此继续，不要重复已完成的工作。',
      reviewLine,
      DOC_BEGIN,
      indexText,
      DOC_END,
      '',
      '请立刻从「下一步」开始推进；如果发现文档与工作区实际不一致，以工作区实际为准并说明差异。',
    ].join('\n')

    // 记账必须在 prompt 之前：prompt 是唯一会抛错的步骤，
    // 而旧实现把账本写在 prompt 之后，于是账本一次都没被写过（实测停在 197 字节 / 2026-11-05）。
    // 新会话登记的只是「链上第几棒」，不是「已经交接过」——
    // 用 inflight/done 会让它 24 小时内（或永远）没法再交接，链条就停在第二棒。
    reserveClaim(claimsFile, newSessionId, options, Date.now(), true)
    settleClaim(
      claimsFile,
      newSessionId,
      { state: 'genesis', docPath, chainRoot: chain.root, newSessionId, chainDepth: depthForNew, cwd, trigger, tokens, toolCalls: gateToolCalls, reviewVerdict: review.verdict },
      Date.now(),
    )

    try {
      // 第二参数是 AbortSignal，不是可选的：宿主实现第一行就是 signal.throwIfAborted()。
      // 旧代码只传一个参数 → TypeError → 简报永远送不出去（实测 86 个会话 0 送达）。
      await controller.prompt(
        {
          requestId: 'auto-handoff-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          sessionId: newSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
        },
        promptSignal(signal),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      settleClaim(
        claimsFile,
        sessionId,
        { state: 'failed', docPath, newSessionId, note: 'prompt-failed: ' + message },
        Date.now(),
      )
      settleClaim(claimsFile, newSessionId, { state: 'failed', docPath, note: 'prompt-failed' }, Date.now())
      // 孤儿会话：建出来了但没收到简报。不 cancel（可能已开始干活），只改名让人能认出来。
      renameSession(ctx, newSessionId, '[孤儿·无简报] ' + title)
      appendEvent({ event: 'error', sessionId, cwd, stage: 'prompt', newSessionId, message })
      logWarn('交接简报投递失败：' + sessionId + ' → ' + newSessionId + '；文档已写入 ' + docPath, error)
      return { ...base, newSessionId, stoppedByChainLimit: false, promptFailed: true }
    }

    appendEvent({
      event: 'prompt/deliver',
      sessionId,
      cwd,
      newSessionId,
      depth: nextDepth,
      chars: promptText.length,
      reviewVerdict: review.verdict,
    })
    settleClaim(
      claimsFile,
      sessionId,
      { state: 'done', docPath, newSessionId, chainRoot: chain.root, chainDepth: chain.depth, reviewVerdict: review.verdict, tokens, toolCalls: gateToolCalls },
      Date.now(),
    )
    // 新会话这一条不能写 done：done 是终态，canAutoHandoff 会一直拦它，
    // 于是链条永远停在第二棒、上限形同废纸。
    // 写 genesis 表示「这一棒刚开出来，链深已登记，随时可以再交接」。
    settleClaim(
      claimsFile,
      newSessionId,
      { state: 'genesis', docPath, chainRoot: chain.root, newSessionId, chainDepth: depthForNew, cwd, trigger, tokens, toolCalls: gateToolCalls, reviewVerdict: review.verdict },
      Date.now(),
    )

    const durationMs = Date.now() - now0
    // 这一条是复盘的主锚：谁交出去的、交给谁、凭什么被推过线、花了多久、结果如何。
    // tokens / toolCalls 都要记**闸门当时用的那两个数**，不能记 facts 里的历史累计，
    // 否则「到底哪个闸把它推过线」永远对不上（票 #20 的第三条验收）。
    appendEvent({
      event: 'claim/settle',
      sessionId,
      cwd,
      state: 'done',
      trigger,
      tokens,
      contextWindow: windowInfo.window,
      windowRatio: windowInfo.window > 0 ? tokens / windowInfo.window : 0,
      toolCalls: gateToolCalls,
      docPath,
      newSessionId,
      depth: nextDepth,
      chainRoot: chain.root,
      durationMs,
      summaryUsed,
      reviewVerdict: review.verdict,
      outcome: 'handoff',
    })

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
              logInfo('父会话取消请求被拒绝（' + (error instanceof Error ? error.message : String(error)) + '）')
            })
          }
        } catch (error) {
          // 旧会话已经 detach（跑完自然结束）时会抛 session/not-found —— 这是正常情况。
          logInfo('父会话无需取消或已结束（' + (error instanceof Error ? error.message : String(error)) + '）')
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

    // 链账本（冷数据）：这一棒走了几跳、每跳多少 token、谁是孤儿，全部记在人能直接看的地方。
    const chainData = readChainJson(chain.root)
    const hops = Array.isArray(chainData.hops) ? chainData.hops.slice() : []
    hops.push({
      sessionId,
      nextSessionId: newSessionId,
      depth: nextDepth,
      at: new Date().toISOString(),
      tokens,
      toolCalls: gateToolCalls,
      reviewVerdict: review.verdict,
    })
    writeChainJson(chain.root, {
      ...chainData,
      root: chain.root,
      cwd,
      limit: maxHops,
      startedAt: chainData.startedAt === '' ? createdAt : chainData.startedAt,
      hops,
    })

    logInfo(
      // 带 [sessionId] 前缀：手上有十几条链同时跑时，没有前缀的「已交接」行根本认不出是谁。
      '[' + sessionId + '] 已交接：' + sessionId + ' → ' + newSessionId + '（' + String(tokens) + ' tokens / ' + String(gateToolCalls) + ' 次工具调用）' +
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

      const tokenInfo = measureTokens(ctx, session)
      const tokens = tokenInfo.tokens
      const window = effectiveTokenThreshold(session, options)
      const toolCalls = toolCallCounts.get(sessionId) ?? 0
      if (tokens < window.threshold && toolCalls < options.toolCallThreshold) {
        // 被拦下也要留一条证据，但**每个会话只留一次**（票 #20）：
        // 旧实现 893 行日志里 852 条是同一句「被占位拦下」，真触发只有 3 次。
        // token 读数不可信时更要留痕——否则 token 闸静默归零，看上去一切正常。
        if (!blockedNoted.has(sessionId + '|gate')) {
          blockedNoted.add(sessionId + '|gate')
          appendEvent({
            event: 'gate/skip',
            sessionId,
            cwd: resolveSessionCwd(ctx, session),
            reason: tokenInfo.reason === '' ? 'below-threshold' : 'token-unavailable: ' + tokenInfo.reason,
            tokens,
            tokenThreshold: window.threshold,
            thresholdSource: window.source,
            contextWindow: window.window,
            toolCalls,
          })
        }
        return
      }
      appendEvent({
        event: 'gate/fire',
        sessionId,
        cwd: resolveSessionCwd(ctx, session),
        trigger: 'threshold',
        tokens,
        tokenThreshold: window.threshold,
        thresholdSource: window.source,
        contextWindow: window.window,
        toolCalls,
        toolCallThreshold: options.toolCallThreshold,
      })

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
        const noteKey = sessionId + '|turn|' + reserved.reason
        if (!blockedNoted.has(noteKey)) {
          blockedNoted.add(noteKey)
          logInfo(`[${sessionId}] 阈值已过但占位拦下（${reserved.reason}），不重复交接`)
        }
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
        return { kind: 'success', text: describeStatus(ctx, session, sessionId) }
      } catch (error) {
        return { kind: 'error', text: `读取状态失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  logInfo(
    `已启用：token 阈值 ${
      options.tokenThreshold > 0
        ? String(options.tokenThreshold) + '（绝对值）'
        : String(Math.round(options.tokenThresholdRatio * 100)) + '% 窗口（窗口读不到时按 ' + String(FALLBACK_CONTEXT_WINDOW) + ' 算）'
    } / 工具调用阈值 ${String(options.toolCallThreshold)}，` +
      `交接目录 ${options.handoffDir}，模型摘要 ${options.modelSummary ? '开' : '关'}，` +
      `链上限 ${String(options.maxAutoHops)} 棒 / 同目录并发 ${String(options.maxConcurrentHops)}，` +
      `REVIEW block 规则 ${options.reviewBlockOn.join(',')}`,
  )
}
