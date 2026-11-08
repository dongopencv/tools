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
// 桌面宿主用的交接目录（.dsh/handoff）；e2e profile 用 .dsh/handoff-e2e，二者共用同一份
// 日志与 claims，必须靠这个值区分「哪一代配置属于现网」。
const EXPECT_DIR = '.dsh/handoff'

// 由 checkFreshness 填：现网模块被加载的时刻（ms）。后面几项用它区分
// 「旧模块留下的历史产物」与「新模块还没跑过」——前者不是缺陷。
let loadedAt = 0
let loadedIsCurrent = false

const results = []
function record(level, id, title, detail) {
  results.push({ level, id, title, detail })
}

// 「这条记录是现网这份代码产生的吗？」——重载前的历史产物不该计入当前缺陷。
function afterReload(at) {
  if (loadedAt === 0) return true
  return Number(at) >= loadedAt
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
//
// 判据必须用「插件自己写的加载时刻」，不能用宿主启动时间：DSH 的 dsh-hmr 会在运行中
// 重组 profile，把改过的 linked package 换进来（实测 2026-11-08T05:18:20Z，改一行
// C:/Users/Admin/.dsh/profiles/desktop/cordis.patch.yml 即触发），而这个过程不写
// hub.log 的 system.start。旧判据（lib mtime > 宿主启动）在 HMR 场景永远误报 FAIL。
//
// 现在的判据：插件每次 apply() 都会打一行「已启用：…」。取**桌面配置那一代**的最后
// 一条（交接目录等于 HANDOFF_EXPECT_DIR，排除 e2e 的 .dsh/handoff-e2e），它的时间戳
// 就是「这份源码被加载的时刻」。晚于 lib/index.js 的 mtime = 现在跑的就是磁盘上这份。
async function checkFreshness() {
  const index = await statOr(join(PLUGIN_DIR, 'lib', 'index.js'))
  if (index === null) {
    record('FAIL', '代码版本', '源码不可达', join(PLUGIN_DIR, 'lib', 'index.js') + ' 不存在')
    return
  }
  if ((await statOr(PLUGIN_LOG)) === null) {
    record('WARN', '代码版本', '插件日志不存在，无法判断现网加载的是哪一版', PLUGIN_LOG)
    return
  }
  const lines = (await readFile(PLUGIN_LOG, 'utf8')).split('\n').filter((l) => l.trim() !== '')
  const generations = []
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) INFO 已启用：.*交接目录 (\S+?)，/.exec(line)
    if (m === null) continue
    generations.push({ at: Date.parse(m[1]), dir: m[2] })
  }
  const desktop = generations.filter((g) => g.dir === EXPECT_DIR)
  if (desktop.length === 0) {
    record('WARN', '代码版本', '日志里没有桌面配置的「已启用」行（只有 e2e 的代）',
      '看到 ' + generations.length + ' 条，交接目录：' + [...new Set(generations.map((g) => g.dir))].join(', '))
    return
  }
  loadedAt = desktop[desktop.length - 1].at
  const mtime = new Date(index.mtimeMs).toISOString()
  loadedIsCurrent = index.mtimeMs <= loadedAt
  if (loadedIsCurrent) {
    record('PASS', '代码版本', '现网加载的就是磁盘上这份源码',
      '加载于 ' + new Date(loadedAt).toISOString() + '，lib/index.js mtime ' + mtime + '（桌面配置共 ' + desktop.length + ' 代）')
    return
  }
  record(
    'FAIL',
    '代码版本',
    '现网跑的是旧模块，改过的源码还没进宿主',
    'lib/index.js mtime=' + mtime + ' 晚于最后一次加载 ' + new Date(loadedAt).toISOString() +
      '。不用重启：往 ' + join(PROFILE_DIR, 'cordis.patch.yml') + ' 末尾加一行注释即可触发 dsh-hmr 重组（实测 3 秒内生效，改前先备份）',
  )
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
  // 终态 done 是永久的：旧模块写的那些 done 不会自己变成 genesis。只有重载之后
  // 新产生的那一棒才能证明「新代码把新会话记成了 genesis」。
  const fresh = handed.filter(([, v]) => afterReload(v.at))
  const genesis = fresh.filter(([, v]) => v.state === 'genesis')
  const done = fresh.filter(([, v]) => v.state === 'done')

  if (genesis.length > 0) {
    record('PASS', '链深（genesis 修复）', '现网新棒是 genesis，链条能继续走',
      summary + '；例 ' + genesis.slice(0, 2).map(([k, v]) => k.slice(0, 22) + ' gen@' + v.chainDepth).join(', '))
    return
  }
  if (fresh.length === 0 && handed.length > 0) {
    record('WARN', '链深（genesis 修复）',
      '重载后还没有产生新棒，genesis 修复尚未被现网验证',
      summary + '；' + handed.length + ' 个 depth>=1 的占位全部早于本次加载 ' +
        (loadedAt === 0 ? '' : new Date(loadedAt).toISOString()) + '，是旧模块产物')
    return
  }
  if (fresh.length > 0 && done.length === fresh.length) {
    record('FAIL', '链深（genesis 修复）', '新棒全是 done，链条停在第 2 棒、chainLimit 形同废纸',
      summary + '；重载后 ' + fresh.length + ' 个 depth>=1 的占位全是终态 done')
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
  // 只认重载之后的日志行：重载前那些是旧模块的行为，用它判断新代码等于用历史判现在。
  const fresh = lines.filter((l) => afterReload(Date.parse(l.slice(0, 24))))
  const handed = fresh.filter((l) => l.includes('已交接：'))
  const blockedMid = fresh.filter((l) => l.includes('轮中触发被占位拦下'))
  const reviews = fresh.filter((l) => l.includes('交接前 REVIEW'))
  const prefixed = fresh.filter((l) => /\] (轮中触发|阈值已过|已交接)/.test(l))
  const lastHandoff = handed.length > 0 ? handed[handed.length - 1] : ''

  record(handed.length > 0 ? 'PASS' : 'WARN', '交接是否真发生过',
    handed.length > 0
      ? '本次加载后交接 ' + handed.length + ' 次，最后一次在 ' + lastHandoff.slice(0, 24)
      : '本次加载后还没有交接（重载于 ' + (loadedAt === 0 ? '?' : new Date(loadedAt).toISOString()) + '）',
    lastHandoff.slice(0, 220) || PLUGIN_LOG)

  record(reviews.length > 0 ? 'PASS' : 'WARN', '交接前 REVIEW',
    reviews.length > 0 ? '本次加载后 REVIEW 跑了 ' + reviews.length + ' 次' : '本次加载后还没有 REVIEW 记录',
    (reviews[reviews.length - 1] ?? '').slice(0, 220))

  // 新格式 = 行首带 [sessionId] 前缀（v1.1.1 起）。这是「新模块真的在跑」的行为证据，
  // 比 mtime 更硬：mtime 只说明文件换过，前缀说明代码路径真的走到了。
  record(prefixed.length > 0 ? 'PASS' : 'WARN', '日志是新格式',
    prefixed.length > 0
      ? '有 ' + prefixed.length + ' 行带 [sessionId] 前缀（v1.1.1+ 格式）'
      : '本次加载后还没有带 [sessionId] 前缀的行，无法证明新代码路径跑到过',
    (prefixed[prefixed.length - 1] ?? '').slice(0, 200))

  // v1.1.1 的两个新信号：父会话被取消 / 父会话没停（终态仍在产生工具调用）
  const cancelled = fresh.filter((l) => l.includes('父会话当前轮已取消'))
  const stuck = fresh.filter((l) => l.includes('但该会话仍在产生工具调用'))
  record(cancelled.length > 0 ? 'PASS' : 'WARN', '父会话是否被停',
    cancelled.length > 0
      ? '交接后有 ' + cancelled.length + ' 次取消了父会话当前轮'
      : '本次加载后没有「父会话当前轮已取消」——要么还没交接，要么 cancel 没生效，父会话会和子会话同时烧 token',
    (cancelled[cancelled.length - 1] ?? '').slice(0, 220))
  if (stuck.length > 0) {
    record('WARN', '父会话仍在跑', stuck.length + ' 条「已交接但仍在产生工具调用」的证据行',
      '取消只停当前轮；这些是交接后又被唤醒、或取消失败后继续跑的会话')
  }

  const ratio = fresh.length === 0 ? 0 : blockedMid.length / fresh.length
  const total = new Date().toISOString()
  record(ratio > 0.5 ? 'FAIL' : 'PASS', '日志刷屏',
    '本次加载后「轮中触发被占位拦下」' + blockedMid.length + ' / ' + fresh.length + ' 行（' + Math.round(ratio * 100) + '%）',
    '阈值 50%：刷屏会把真正的一次交接埋掉，且日志 1 MiB 就滚掉。全量历史 ' + lines.length + ' 行在此不参与判定；采样到 ' + total)
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
  // 只判本次加载之后写的文档：旧模块写的那 4 份没有「下一步」是既定历史，
  // 拿它当 FAIL 会让这条验收永远红着，失去信号价值。
  const freshDocs = withStat.filter((x) => afterReload(x.s.mtimeMs))
  if (freshDocs.length === 0) {
    record('WARN', '交接文档结构', '本次加载后还没有写出新的交接文档',
      '目录里共 ' + withStat.length + ' 份，最新一份 ' + withStat[0].n + ' · ' + new Date(withStat[0].s.mtimeMs).toISOString() + '（早于加载时刻）')
    record('WARN', '交接文档有「下一步」', '本次加载后还没有写出新的交接文档，无法验证',
      '旧模块写的历史文档不算：它在 requestModelSummary 里就砍到 1600 字，「下一步」第三节必被砍')
    return
  }
  const newest = freshDocs[0]
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
    if (s === null) continue
    // 只看本次加载之后还写过盘的会话：重载前送达的那次简报属于旧模块。
    if (!afterReload(s.mtimeMs)) continue
    candidates.push({ name: d.name, path: p, s })
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
      // 会话文件还在被写不代表简报是新的：必须是重载之后投递的那一条。
      const at = parsed.time ?? c.s.mtimeMs
      if (!afterReload(at)) continue
      hit = { name: c.name, at, len: flat.length }
      break
    }
    if (hit !== null) break
  }
  if (hit === null) {
    record('WARN', '简报送达', '本次加载后没有会话收到交接简报',
      candidates.length === 0
        ? '重载后没有任何会话被写过盘，扫 ' + SESSIONS_DIR
        : '扫了 ' + Math.min(limit, candidates.length) + ' 个重载后写过的会话，都没命中「[自动交接] 上一会话」')
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
console.log(loadedAt === 0
  ? '判定窗口：全量历史（没找到桌面配置的加载行，退化为不分区）'
  : '判定窗口：' + new Date(loadedAt).toISOString() + ' 之后（现网模块最后一次加载）。更早的行是旧模块产物，不计入缺陷。')
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
