#!/usr/bin/env node
/**
 * dsh-auto-handoff 现网核验：#46 的四条验收 + 交付健康度。
 *
 *   node tools/handoff-check.mjs          # 常规核验
 *   node tools/handoff-check.mjs --deep   # 另跑插件离线测试（会起 4 个 node 进程）
 *
 * 退出码：0 = 没有 FAIL；1 = 至少一条 FAIL。
 *
 * 为什么要有它：四条验收全是去宿主磁盘上读现场，手工查一次要开五个文件，还容易被
 * 误导（旧日志行、顶层 ok 字段）。按 AGENTS.md「凡是能用脚本卡的一律改成脚本」压成一条命令。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'

const run = promisify(execFile)

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
const PLUGIN_DIR = process.env.HANDOFF_PLUGIN_DIR ?? 'D:/tools/dsh-auto-handoff'
const PROFILE_DIR = join(HOME, '.dsh', 'profiles', 'desktop')
const HUB_LOG = join(PROFILE_DIR, 'hub.log')
const STATE_DIR = join(HOME, '.dsh', 'auto-handoff')
const CLAIMS_FILE = join(STATE_DIR, 'claims.json')
const PLUGIN_LOG = join(STATE_DIR, 'auto-handoff.log')
const SESSIONS_DIR = join(HOME, '.dsh', 'sessions', '--D-proj-PC1--')
const HANDOFF_DIR = process.env.HANDOFF_OUT_DIR ?? 'D:/proj/PC1/.dsh/handoff'

const results = []
function record(level, id, title, detail) {
  results.push({ level, id, title, detail })
}

async function statOr(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

// session.v4.jsonl.zstd 是多帧拼接：整包 zstdDecompressSync 只出第一帧，必须按 magic 切。
function decompressAllFrames(bytes) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const isMagic = (buf, at) =>
    buf[at] === MAGIC[0] && buf[at + 1] === MAGIC[1] && buf[at + 2] === MAGIC[2] && buf[at + 3] === MAGIC[3]
  const chunks = []
  let i = 0
  while (i + 4 <= bytes.length) {
    if (!isMagic(bytes, i)) {
      i += 1
      continue
    }
    let end = bytes.length
    for (let j = i + 4; j + 4 <= bytes.length; j += 1) {
      if (isMagic(bytes, j)) {
        end = j
        break
      }
    }
    try {
      chunks.push(zlib.zstdDecompressSync(bytes.subarray(i, end)).toString('utf8'))
    } catch {
      // 坏帧跳过
    }
    i = end
  }
  return chunks.join('')
}

// 1) 现网跑的是哪一版代码
async function checkFreshness() {
  const hub = existsSync(HUB_LOG) ? await readFile(HUB_LOG, 'utf8') : ''
  let lastStart = 0
  for (const line of hub.split('\n')) {
    if (!line.includes('"event":"system.start"')) continue
    const m = line.match(/"at":(\d+)/)
    if (m !== null) lastStart = Math.max(lastStart, Number(m[1]))
  }
  const index = await statOr(join(PLUGIN_DIR, 'lib', 'index.js'))
  if (index === null) {
    record('FAIL', '代码版本', '源码不可达', join(PLUGIN_DIR, 'lib', 'index.js') + ' 不存在')
    return
  }
  if (lastStart === 0) {
    record('WARN', '代码版本', 'hub.log 里没有 system.start', '无法判断宿主启动时间')
    return
  }
  const startedAt = new Date(lastStart).toISOString()
  if (index.mtimeMs > lastStart) {
    record(
      'FAIL',
      '代码版本',
      '现网跑的是旧模块，需要重启桌面版 DSH',
      'lib/index.js mtime=' + new Date(index.mtimeMs).toISOString() + ' 晚于宿主启动 ' + startedAt +
        '（DSH 无 reload 子命令；桌面宿主由应用壳托管，插件侧不能自杀式重启，只能由人从菜单/托盘退出再打开）',
    )
    return
  }
  record('PASS', '代码版本', '现网已加载这份源码',
    '宿主启动 ' + startedAt + ' >= lib/index.js mtime ' + new Date(index.mtimeMs).toISOString())
}

// 2) 占位账本状态：新棒是 genesis 才能继续走
async function checkClaims() {
  const data = await readJson(CLAIMS_FILE)
  if (data === null) {
    record('WARN', '占位账本', 'claims.json 读不到或不是合法 JSON', CLAIMS_FILE)
    return
  }
  const claims = data.claims ?? data
  const entries = Object.entries(claims).filter(([, v]) => v !== null && typeof v === 'object')
  if (entries.length === 0) {
    record('WARN', '占位账本', 'claims.json 里没有占位', CLAIMS_FILE)
    return
  }
  const byState = new Map()
  for (const [, v] of entries) {
    const k = typeof v.state === 'string' ? v.state : '?'
    byState.set(k, (byState.get(k) ?? 0) + 1)
  }
  const summary = [...byState].map(([k, n]) => k + '×' + n).join(' / ')
  const handed = entries.filter(([, v]) => Number(v.chainDepth) >= 1)
  const genesis = handed.filter(([, v]) => v.state === 'genesis')
  const done = handed.filter(([, v]) => v.state === 'done')

  if (genesis.length > 0) {
    record('PASS', '链深（genesis 修复）', '现网新棒是 genesis，链条能继续走',
      summary + '；例 ' + genesis.slice(0, 2).map(([k, v]) => k.slice(0, 22) + ' gen@' + v.chainDepth).join(', '))
    return
  }
  if (handed.length > 0 && done.length === handed.length) {
    record('FAIL', '链深（genesis 修复）', '新会话全是 done，链条停在第 2 棒、chainLimit 形同废纸',
      summary + '；' + handed.length + ' 个 depth>=1 的占位全是终态 done')
    return
  }
  record('WARN', '链深（genesis 修复）', '没有现网交接记录', summary)
}

// 3) 日志：有没有真交接、REVIEW 有没有跑、有没有刷屏
async function checkLog() {
  if ((await statOr(PLUGIN_LOG)) === null) {
    record('WARN', '运行日志', 'auto-handoff.log 不存在（插件可能从未加载）', PLUGIN_LOG)
    return
  }
  const text = await readFile(PLUGIN_LOG, 'utf8')
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const handed = lines.filter((l) => l.includes('已交接：'))
  const blockedMid = lines.filter((l) => l.includes('轮中触发被占位拦下'))
  const reviews = lines.filter((l) => l.includes('交接前 REVIEW'))
  const lastHandoff = handed.length > 0 ? handed[handed.length - 1] : ''

  record(handed.length > 0 ? 'PASS' : 'WARN', '交接是否真发生过',
    handed.length > 0 ? '共 ' + handed.length + ' 次，最后一次在 ' + lastHandoff.slice(0, 24) : '日志里没有「已交接」',
    lastHandoff.slice(0, 220) || PLUGIN_LOG)

  record(reviews.length > 0 ? 'PASS' : 'WARN', '交接前 REVIEW',
    reviews.length > 0 ? 'REVIEW 跑了 ' + reviews.length + ' 次' : '日志里没有 REVIEW 记录',
    (reviews[reviews.length - 1] ?? '').slice(0, 220))

  // v1.1.1 的两个新信号：父会话被取消 / 父会话没停（终态仍在产生工具调用）
  const cancelled = lines.filter((l) => l.includes('父会话当前轮已取消'))
  const stuck = lines.filter((l) => l.includes('但该会话仍在产生工具调用'))
  record(cancelled.length > 0 ? 'PASS' : 'WARN', '父会话是否被停',
    cancelled.length > 0
      ? '交接后有 ' + cancelled.length + ' 次取消了父会话当前轮'
      : '日志里没有「父会话当前轮已取消」——旧模块不会停父会话，它和子会话同时烧 token',
    (cancelled[cancelled.length - 1] ?? '').slice(0, 220))
  if (stuck.length > 0) {
    record('WARN', '父会话仍在跑', stuck.length + ' 条「已交接但仍在产生工具调用」的证据行',
      '取消只停当前轮；这些是交接后又被唤醒、或取消失败后继续跑的会话')
  }

  const ratio = lines.length === 0 ? 0 : blockedMid.length / lines.length
  if (ratio > 0.5) {
    record('WARN', '日志刷屏', '「轮中触发被占位拦下」' + blockedMid.length + ' / ' + lines.length + ' 行（' + Math.round(ratio * 100) + '%）',
      '工具调用计数是累计值，旧模块每个 tool/call 都打一行；midTurnFired 修复后同一会话只打一次，重启后复验')
  } else {
    record('PASS', '日志刷屏', '「轮中触发被占位拦下」' + blockedMid.length + ' / ' + lines.length + ' 行', '')
  }
}

// 4) 最新交接文档里有没有 REVIEW 小节
async function checkDoc() {
  let names
  try {
    names = (await readdir(HANDOFF_DIR)).filter((n) => n.endsWith('.md'))
  } catch {
    record('WARN', '交接文档', '交接目录不存在', HANDOFF_DIR)
    return
  }
  if (names.length === 0) {
    record('WARN', '交接文档', '交接目录里没有 md', HANDOFF_DIR)
    return
  }
  const withStat = []
  for (const n of names) {
    const s = await statOr(join(HANDOFF_DIR, n))
    if (s !== null) withStat.push({ n, s })
  }
  withStat.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
  const newest = withStat[0]
  const body = await readFile(join(HANDOFF_DIR, newest.n), 'utf8')
  const hasReview = body.includes('## 交接前 REVIEW')
  record(hasReview ? 'PASS' : 'WARN', '交接文档结构',
    '最新一份' + (hasReview ? '含' : '缺') + '「## 交接前 REVIEW」',
    newest.n + ' · ' + newest.s.size + 'B · ' + new Date(newest.s.mtimeMs).toISOString())

  // 「下一步」是这份文档存在的理由：新会话靠它知道该干什么。
  // 旧模块在 requestModelSummary 里先砍到 1600 字，「下一步」作为第三节必被砍掉（实测 8 份里 4 份）。
  const hasNext = body.includes('## 下一步')
  record(hasNext ? 'PASS' : 'FAIL', '交接文档有「下一步」',
    hasNext ? '最新一份含「## 下一步」' : '最新一份没有「## 下一步」——新会话拿到的是没有方向的进度报告',
    '摘要按节裁剪（orderSummary）是 v1.1.1 才有的；旧模块必砍第三节')
}

// 5) 新会话到底收到简报没有（只认 user/message 里的正文，助手贴源码会假阳性）
async function checkDelivery(limit) {
  let entries
  try {
    entries = await readdir(SESSIONS_DIR, { withFileTypes: true })
  } catch {
    record('WARN', '简报送达', '会话目录不可读', SESSIONS_DIR)
    return
  }
  const candidates = []
  for (const d of entries) {
    if (!d.isDirectory()) continue
    const p = join(SESSIONS_DIR, d.name, 'session.v4.jsonl.zstd')
    const s = await statOr(p)
    if (s !== null) candidates.push({ name: d.name, path: p, s })
  }
  candidates.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
  let hit = null
  for (const c of candidates.slice(0, limit)) {
    const text = decompressAllFrames(await readFile(c.path))
    for (const line of text.split('\n')) {
      if (!line.includes('[自动交接] 上一会话')) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed.type !== 'user/message' && parsed.type !== 'user_message') continue
      const flat = JSON.stringify(parsed.data ?? {})
      if (!flat.includes('[自动交接] 上一会话')) continue
      hit = { name: c.name, at: parsed.time ?? c.s.mtimeMs, len: flat.length }
      break
    }
    if (hit !== null) break
  }
  if (hit === null) {
    record('WARN', '简报送达', '最近 ' + Math.min(limit, candidates.length) + ' 个会话都没收到交接简报',
      '扫 ' + SESSIONS_DIR)
    return
  }
  record('PASS', '简报送达', '新会话收到了交接简报（正文 ' + hit.len + ' 字符）',
    hit.name + ' · ' + new Date(hit.at).toISOString())
}

// 6) 可选：离线测试（chainLimit 这类只能离线验）
async function checkTests() {
  for (const suite of ['chain', 'claims', 'integration', 'midturn']) {
    const file = join(PLUGIN_DIR, 'test', suite + '.test.mjs')
    if (!existsSync(file)) {
      record('WARN', '离线测试 · ' + suite, '测试文件不存在', file)
      continue
    }
    try {
      const { stdout } = await run(process.execPath, [file], { cwd: PLUGIN_DIR, timeout: 120000 })
      const passed = (stdout.match(/^\s*PASS /gm) ?? []).length
      record('PASS', '离线测试 · ' + suite, passed + ' 条断言通过', '')
    } catch (error) {
      const tail = String(error.stdout ?? error.message).trim().split('\n').slice(-6).join(' | ')
      record('FAIL', '离线测试 · ' + suite, '测试失败', tail.slice(-400))
    }
  }
}

const deep = process.argv.includes('--deep')
await checkFreshness()
await checkClaims()
await checkLog()
await checkDoc()
await checkDelivery(deep ? 40 : 15)
if (deep) await checkTests()

const icon = { PASS: '✅', WARN: '◐', FAIL: '❌' }
console.log('')
console.log('dsh-auto-handoff 现网核验 · ' + new Date().toISOString() + (deep ? ' · 含离线测试' : ''))
console.log('')
for (const r of results) {
  console.log(icon[r.level] + ' [' + r.id + '] ' + r.title)
  if (r.detail !== '') console.log('    ' + r.detail)
}
const fails = results.filter((r) => r.level === 'FAIL').length
const warns = results.filter((r) => r.level === 'WARN').length
console.log('')
console.log(fails === 0
  ? '结论：没有 FAIL' + (warns > 0 ? '（' + warns + ' 条 WARN 要看一眼）' : '，全部通过')
  : '结论：' + fails + ' 条 FAIL，先修这些')
process.exit(fails === 0 ? 0 : 1)
