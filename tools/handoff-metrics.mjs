#!/usr/bin/env node
// handoff-metrics.mjs — 用真实运行数据反推 dsh-auto-handoff 的阈值，并核对可观测验收。
//
// 为什么需要它：tokenThreshold=300000 / toolCallThreshold=80 是拍的，没有实测依据（ISSUES.md O-4）。
// 本脚本只读证据，算出「交接实际发生在窗口的百分之几」「多少工具调用时交接」，
// 给出可以拿去改默认值的数字，以及样本量够不够动默认值的判据。
//
// 用法：
//   node tools/handoff-metrics.mjs            # 看分布与建议
//   node tools/handoff-metrics.mjs --json     # 机器可读
//   node tools/handoff-metrics.mjs --verify   # 额外核对可观测验收，有 FAIL 时退出码 1
//
// 数据来源（全部只读）：
//   1. ~/.dsh/auto-handoff/auto-handoff.log(+.1)  文本日志
//   2. ~/.dsh/auto-handoff/events.jsonl           结构化事件（还没实现时自动降级）
//   3. ~/.dsh/auto-handoff/claims.json            占位表：链深、状态
//   4. ~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd   request/context 里的 contextWindow
//
// 环境变量：HANDOFF_RUNTIME_DIR / HANDOFF_SESSIONS_DIR 可覆盖默认位置。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const ARGV = new Set(process.argv.slice(2))
const AS_JSON = ARGV.has('--json')
const VERIFY = ARGV.has('--verify')

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
const RUNTIME = process.env.HANDOFF_RUNTIME_DIR ?? join(HOME, '.dsh', 'auto-handoff')
const SESSIONS = process.env.HANDOFF_SESSIONS_DIR ?? join(HOME, '.dsh', 'sessions')
const LOG = join(RUNTIME, 'auto-handoff.log')
const LOG1 = join(RUNTIME, 'auto-handoff.1.log')
const EVENTS = join(RUNTIME, 'events.jsonl')
const CLAIMS = join(RUNTIME, 'claims.json')

const out = { generatedAt: new Date().toISOString(), runtime: RUNTIME, sources: {}, thresholds: null, thresholdsHistory: [], handoffs: [], skips: {}, skipTotal: 0, midTurnFires: 0, thresholdPassBlocked: 0, handoffFailed: 0, review: {}, claims: {}, window: {}, advice: {}, verify: [] }

function readText(p) { try { return readFileSync(p, 'utf8') } catch { return '' } }

// ---------- 1. 文本日志 ----------
const logLines = []
for (const p of [LOG1, LOG]) {
  const t = readText(p)
  if (!t) continue
  for (const line of t.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (INFO|WARN|ERROR) (.*)$/.exec(line)
    if (m) logLines.push({ at: m[1], level: m[2], msg: m[3], file: p === LOG ? 'current' : 'rotated' })
  }
}
out.sources.log = { path: LOG, lines: logLines.length, exists: logLines.length > 0 }

const enabled = []
const handoffs = []
const skipCounter = new Map()
const reviewVerdicts = []
let midTurnFires = 0
let thresholdPassBlocked = 0
let handoffFailed = 0
let withSessionId = 0

let currentGen = null
for (const l of logLines) {
  let m
  if (/\[session-/.test(l.msg) || /^- /.test(l.msg)) withSessionId++
  if ((m = /^已启用：token 阈值 (\d+) \/ 工具调用阈值 (\d+)，交接目录 (\S+)，模型摘要 (开|关)，链上限 (\d+)/.exec(l.msg))) {
    currentGen = { handoffDir: m[3], tokenThreshold: Number(m[1]), toolCallThreshold: Number(m[2]) }
    enabled.push({ at: l.at, tokenThreshold: Number(m[1]), toolCallThreshold: Number(m[2]), handoffDir: m[3], modelSummary: m[4] === '开', chainLimit: Number(m[5]) })
  } else if ((m = /^已交接：(\S+) → (\S+)（(\d+) tokens \/ (\d+) 次工具调用）/.exec(l.msg))) {
    handoffs.push({ at: l.at, from: m[1], to: m[2], tokens: Number(m[3]), toolCalls: Number(m[4]), gen: currentGen ? currentGen.handoffDir + '|' + currentGen.tokenThreshold + '/' + currentGen.toolCallThreshold : 'unknown' })
  } else if ((m = /^轮中触发：工具调用已达 (\d+) 次/.exec(l.msg))) {
    midTurnFires++
  } else if ((m = /^轮中触发被占位拦下（(\w+)）/.exec(l.msg))) {
    skipCounter.set('mid-turn:' + m[1], (skipCounter.get('mid-turn:' + m[1]) ?? 0) + 1)
  } else if ((m = /^阈值已过但占位拦下（(\w+)）/.exec(l.msg))) {
    thresholdPassBlocked++
    skipCounter.set('turn-stopping:' + m[1], (skipCounter.get('turn-stopping:' + m[1]) ?? 0) + 1)
  } else if ((m = /^交接前 REVIEW (\w+)/.exec(l.msg))) {
    reviewVerdicts.push({ at: l.at, verdict: m[1], msg: l.msg })
  } else if (/交接失败|简报投递失败|自动交接失败/.test(l.msg)) {
    handoffFailed++
  }
}
out.thresholds = enabled[enabled.length - 1] ?? null
out.thresholdsHistory = enabled
// 同一个 runtime 目录（~/.dsh/auto-handoff）被所有 profile 共用：headless e2e、离线测试、桌面宿主
// 的「已启用」行都会写进同一份日志。统计前必须知道这份日志混了几代配置。
out.configGenerations = [...new Set(enabled.map(e => e.handoffDir + '|' + e.tokenThreshold + '/' + e.toolCallThreshold))]
out.handoffs = handoffs
out.skips = Object.fromEntries([...skipCounter.entries()].sort((a, b) => b[1] - a[1]))
out.skipTotal = [...skipCounter.values()].reduce((a, b) => a + b, 0)
out.midTurnFires = midTurnFires
out.thresholdPassBlocked = thresholdPassBlocked
out.handoffFailed = handoffFailed
out.review = { count: reviewVerdicts.length, verdicts: reviewVerdicts.reduce((a, r) => { a[r.verdict] = (a[r.verdict] ?? 0) + 1; return a }, {}) }
out.logLinesWithSessionId = withSessionId

// ---------- 2. 结构化事件（可选） ----------
const events = []
const evText = readText(EVENTS)
if (evText) {
  for (const line of evText.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
}
out.sources.events = { path: EVENTS, exists: events.length > 0, lines: events.length }
if (events.length > 0) {
  const done = events.filter(e => e.event === 'handoff/done')
  out.structured = {
    byEvent: events.reduce((a, e) => { a[e.event] = (a[e.event] ?? 0) + 1; return a }, {}),
    handoffs: done.length,
    durationMs: done.map(e => e.durationMs).filter(n => typeof n === 'number'),
    triggers: done.reduce((a, e) => { a[e.trigger] = (a[e.trigger] ?? 0) + 1; return a }, {}),
  }
}

// ---------- 3. 占位表 ----------
let claims = {}
try { claims = JSON.parse(readText(CLAIMS))?.claims ?? {} } catch {}
const claimRows = Object.entries(claims).filter(([id]) => !id.startsWith('sess-'))
out.claims = {
  path: CLAIMS,
  total: claimRows.length,
  byState: claimRows.reduce((a, [, v]) => { a[v.state] = (a[v.state] ?? 0) + 1; return a }, {}),
  byDepth: claimRows.reduce((a, [, v]) => { a[v.chainDepth] = (a[v.chainDepth] ?? 0) + 1; return a }, {}),
  maxDepth: claimRows.reduce((mx, [, v]) => Math.max(mx, v.chainDepth ?? 0), 0),
}

// ---------- 4. 会话日志里的 contextWindow ----------
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeSession(file) {
  let buf
  try { buf = readFileSync(file) } catch { return '' }
  const parts = []
  let i = 0
  while (i < buf.length) {
    const start = buf.indexOf(MAGIC, i)
    if (start < 0) break
    let j = start + 4, end = -1
    while (j < buf.length) {
      if (buf[j] === 0x28 && buf[j + 1] === 0xb5 && buf[j + 2] === 0x2f && buf[j + 3] === 0xfd) { end = j; break }
      j++
    }
    if (end < 0) end = buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))) } catch {}
    i = end
  }
  return Buffer.concat(parts).toString('utf8')
}

const windowBySession = new Map()
const wanted = new Set(handoffs.flatMap(h => [h.from, h.to]))
let scanned = 0
try {
  for (const ws of readdirSync(SESSIONS)) {
    const wsDir = join(SESSIONS, ws)
    let names
    try { names = readdirSync(wsDir) } catch { continue }
    for (const name of names) {
      if (!wanted.has(name)) continue
      const f = join(wsDir, name, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      scanned++
      const text = decodeSession(f)
      for (const line of text.split('\n')) {
        if (line.indexOf('request/context') < 0) continue
        try {
          const o = JSON.parse(line)
          const cw = o?.data?.contextWindow
          if (typeof cw === 'number' && cw > 0) windowBySession.set(name, cw)
        } catch {}
      }
    }
  }
} catch {}
out.sources.sessions = { dir: SESSIONS, matched: scanned, windowsFound: windowBySession.size }
out.window = { bySession: Object.fromEntries(windowBySession), distinct: [...new Set(windowBySession.values())] }

// ---------- 5. 反推 ----------
function stats(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  // 线性插值分位：样本只有 6–7 个时，最近秩会把 p50 推到 p75 上去（6 个样本 p50 落在第 4 个）
  const q = p => {
    if (s.length === 1) return s[0]
    const pos = p * (s.length - 1)
    const lo = Math.floor(pos), hi = Math.ceil(pos)
    // 不在这里取整：比值（0–1）会被抹成 0 或 1，取整交给输出层
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
  }
  const rawMean = s.reduce((a, b) => a + b, 0) / s.length
  // 比值（0–1 之间）保留 3 位小数，绝对量取整；否则 0.70 会被四舍五入成 1
  const mean = s[s.length - 1] <= 1.5 ? Math.round(rawMean * 1000) / 1000 : Math.round(rawMean)
  return { n: s.length, min: s[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1], mean }
}
// 只拿桌面宿主的真实交接做反推：e2e / 离线测试用的阈值是压到 1000/5 的，混进来会把分位数拉垮。
// 真实交接的判据：父会话是真会话 id（sess-a / sess-new-1 是离线测试假件），且那一代配置不是 e2e 的压测阈值。
const realHandoffs = handoffs.filter(h => /^session-[0-9a-f]{8}-/.test(h.from) && !/e2e/i.test(h.gen))
// 绝对量取整（分位数是线性插值，会带出 449596.25 这种数）；比值保留原精度
const roundAbs = st => st === null ? null : Object.fromEntries(Object.entries(st).map(([k, v]) => [k, k === 'n' ? v : Math.round(v)]))
const tok = roundAbs(stats(realHandoffs.map(h => h.tokens)))
const calls = roundAbs(stats(realHandoffs.map(h => h.toolCalls)))
const ratio = stats(realHandoffs.map(h => {
  const cw = windowBySession.get(h.from)
  return cw ? h.tokens / cw : null
}).filter(v => v !== null))

out.advice = {
  samples: { handoffs: handoffs.length, realHandoffs: realHandoffs.length, windowKnown: ratio?.n ?? 0 },
  tokenAtHandoff: tok,
  toolCallsAtHandoff: calls,
  windowRatioAtHandoff: ratio,
  sampleRule: '样本 >=20 次交接才改默认值；<20 只按窗口比例给建议，不动绝对值',
  recommendation: null,
  toolCallThresholdSuggestion: null,
}
const rec = {}
if (ratio && ratio.n >= 3) {
  const target = Math.max(0.15, Math.min(0.45, Math.round(ratio.p25 * 100) / 100))
  rec.rule = 'tokenThreshold 改成 tokenThresholdRatio × session.requestContext().contextWindow；取实测交接窗口占比 p25，夹在 [0.15, 0.45]'
  rec.tokenThresholdRatio = target
  rec.exampleFor1MWindow = Math.round(target * 1000000)
  rec.note = '取 p25 而不是 p50：交接点要落在典型交接点之前，而不是追着典型点跑'
}
if (calls && calls.n >= 3) {
  rec.toolCallThresholdNote = '实测工具调用交接点 p25=' + calls.p25 + ' / p50=' + calls.p50 + ' / max=' + calls.max + '；80 偏晚'
  out.advice.toolCallThresholdSuggestion = Math.max(20, calls.p25)
}
out.advice.recommendation = Object.keys(rec).length ? rec : null

// ---------- 6. 可观测验收 ----------
const v = []
function check(name, ok, detail) { v.push({ name, status: ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL', detail }) }
const hasSid = logLines.some(l => /\[session-/.test(l.msg));
check('日志行带 sessionId', hasSid, hasSid ? '有 [session-…] 前缀' : '整份日志没有一行带 sessionId（旧日志的最大排查障碍）');
check('有结构化事件通道', out.sources.events.exists ? true : 'warn', out.sources.events.exists ? 'events.jsonl 有 ' + events.length + ' 条结构化事件' : 'events.jsonl 还没有；在此之前只能正则解析中文日志，字段靠猜');
check('触发与拦下能分开统计', (out.midTurnFires + out.skipTotal) > 0, '真触发 ' + out.midTurnFires + ' 次 / 被占位拦下 ' + out.skipTotal + ' 次');
const noise = (out.skipTotal + handoffs.length + out.midTurnFires) > 0 ? out.skipTotal / (out.skipTotal + handoffs.length + out.midTurnFires) : 0;
check('日志噪声比 < 20%', noise < 0.2, '噪声 ' + (noise * 100).toFixed(1) + '%（' + out.skipTotal + ' / ' + (out.skipTotal + handoffs.length) + '）');
check('交接点能对上模型窗口', (ratio?.n ?? 0) > 0, ratio ? ratio.n + ' 次交接拿到 contextWindow，占比 p25=' + (ratio.p25 * 100).toFixed(0) + '% p50=' + (ratio.p50 * 100).toFixed(0) + '% max=' + (ratio.max * 100).toFixed(0) + '%' : '一次都没拿到 contextWindow');
check('chainLimit 被真实跑到过', out.claims.maxDepth >= (out.thresholds?.chainLimit ?? 8), 'claims 最大链深 ' + out.claims.maxDepth + '，上限 ' + (out.thresholds?.chainLimit ?? '?'));
check('样本量够改默认阈值', realHandoffs.length >= 20 ? true : 'warn', realHandoffs.length + ' 次真实交接（门槛 20；e2e/离线测试不计）');
check('日志只含一个 profile 的配置', (out.configGenerations ?? []).length <= 1 ? true : 'warn', (out.configGenerations ?? []).length <= 1 ? '单一配置' : (out.configGenerations.length + ' 代配置混在同一份日志：' + out.configGenerations.join(' / ') + '（e2e/离线测试会污染桌面宿主数据）'));
out.verify = v
out.verifySummary = { pass: v.filter(x => x.status === 'PASS').length, warn: v.filter(x => x.status === 'WARN').length, fail: v.filter(x => x.status === 'FAIL').length };

// ---------- 输出 ----------
if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2))
} else {
  const pc = x => (x * 100).toFixed(0) + '%'
  console.log('dsh-auto-handoff 实测指标 · ' + out.generatedAt)
  console.log('数据源：日志 ' + out.sources.log.lines + ' 行' + (out.sources.events.exists ? '、结构化事件 ' + events.length + ' 条' : '、无结构化事件') + '、占位 ' + out.claims.total + ' 条、会话窗口 ' + Object.keys(out.window.bySession).length + ' 个')
  if (out.thresholds) console.log('当前阈值：token ' + out.thresholds.tokenThreshold + ' / 工具调用 ' + out.thresholds.toolCallThreshold + ' / 链上限 ' + out.thresholds.chainLimit + ' / 模型摘要 ' + (out.thresholds.modelSummary ? '开' : '关') + '（' + out.thresholds.at + ' 启用）')
  console.log('')
  console.log('交接 ' + handoffs.length + ' 次（真实 ' + realHandoffs.length + ' 次，其余为 e2e/离线测试），失败 ' + handoffFailed + ' 次，REVIEW ' + out.review.count + ' 次 ' + JSON.stringify(out.review.verdicts))
  if (tok) console.log('  交接时 tokens：p25 ' + tok.p25 + ' / p50 ' + tok.p50 + ' / p90 ' + tok.p90 + ' / max ' + tok.max)
  if (calls) console.log('  交接时工具调用：p25 ' + calls.p25 + ' / p50 ' + calls.p50 + ' / max ' + calls.max)
  if (ratio) console.log('  窗口占比：p25 ' + pc(ratio.p25) + ' / p50 ' + pc(ratio.p50) + ' / max ' + pc(ratio.max) + '  （窗口 ' + out.window.distinct.join(' / ') + '）')
  console.log('  噪声：真触发 ' + out.midTurnFires + ' 次，被占位拦下 ' + out.skipTotal + ' 次 ' + JSON.stringify(out.skips))
  if ((out.configGenerations ?? []).length > 1) console.log('  ⚠ 这份日志混了 ' + out.configGenerations.length + ' 代配置：' + out.configGenerations.join(' / '))
  if (out.advice.recommendation) {
    console.log('')
    console.log('建议：' + out.advice.recommendation.rule)
    if (out.advice.recommendation.tokenThresholdRatio) console.log('  tokenThresholdRatio = ' + out.advice.recommendation.tokenThresholdRatio + '（1M 窗口 ≈ ' + out.advice.recommendation.exampleFor1MWindow + '）')
    if (out.advice.recommendation.toolCallThresholdNote) console.log('  ' + out.advice.recommendation.toolCallThresholdNote)
    console.log('  ' + out.advice.sampleRule)
  }
  console.log('')
  console.log('可观测验收：' + out.verifySummary.pass + ' PASS / ' + out.verifySummary.warn + ' WARN / ' + out.verifySummary.fail + ' FAIL')
  for (const item of v) console.log('  ' + (item.status === 'PASS' ? '✅' : item.status === 'WARN' ? '◐' : '❌') + ' ' + item.name + ' —— ' + item.detail)
}
if (VERIFY && out.verifySummary.fail > 0) process.exit(1)
