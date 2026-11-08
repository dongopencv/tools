/**
 * 落盘占位：同一个会话只能被交接一次，而且这个「一次」必须活过进程重启。
 *
 * 为什么不能用内存 Set：原实现 `const handedOff = new Set()` 只在进程内有效。
 * 实测后果——宿主重启或交接抛错后占位丢失，同一会话被反复交接，
 * 18:26–18:28 两分钟内连开 14 个空会话，会话目录从 425 涨到 675。
 *
 * 这里用最简单的文件 + 原子替换（写临时文件再 rename），不引任何依赖：
 * 交接是低频事件（一个会话一次），不需要数据库，也不需要并发锁——
 * 真正的并发保护来自「同步读改写」这一段同步执行的代码。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CLAIMS_FILE = 'claims.json'

/** inflight=正在交接；done=已交接；stopped=终态不再自动重试；failed=失败可重试；genesis=刚开出来的新棒；deferred=并发超限排队 */
const TERMINAL_STATES = new Set(['done', 'stopped'])

/** 占位文件的路径；拿不到主目录就返回 undefined（此时退化成内存模式）。 */
export function claimsPath(home) {
  const base = home === undefined ? (process.env.USERPROFILE ?? process.env.HOME ?? '') : home
  if (base === '') return undefined
  return join(base, '.dsh', 'auto-handoff', CLAIMS_FILE)
}

function str(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

/**
 * 读占位表，任何异常都当成空表（占位丢了最多多交接一次，不能因此崩掉主流程）。
 *
 * 字段说明（v1.2 起）：除了 state/at/attempts，还记 cwd / trigger / tokens /
 * toolCalls / reviewVerdict / chainRoot / chainDepth / stoppedReason / stoppedAt /
 * deferredUntil。原因：判「同 cwd 并发几棒」「这一棒为什么停」都要看这些，
 * 而它们本来就只在交接那一刻短暂存在于内存里，不落盘就永远查不回来（票 #18）。
 */
export function readClaims(path) {
  if (path === undefined) return new Map()
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return new Map()
  }
  try {
    const parsed = JSON.parse(text)
    const map = new Map()
    const claims = parsed !== null && typeof parsed === 'object' ? parsed.claims : undefined
    if (claims !== null && typeof claims === 'object') {
      for (const [sessionId, value] of Object.entries(claims)) {
        if (value === null || typeof value !== 'object') continue
        map.set(sessionId, {
          at: num(value.at, 0),
          attempts: num(value.attempts, 0),
          state: typeof value.state === 'string' ? value.state : 'failed',
          docPath: str(value.docPath),
          newSessionId: str(value.newSessionId),
          note: str(value.note),
          chainRoot: str(value.chainRoot),
          chainDepth: num(value.chainDepth, 0),
          cwd: str(value.cwd),
          trigger: str(value.trigger),
          tokens: num(value.tokens, 0),
          toolCalls: num(value.toolCalls, 0),
          reviewVerdict: str(value.reviewVerdict),
          stoppedReason: str(value.stoppedReason),
          stoppedAt: num(value.stoppedAt, 0),
          deferredUntil: num(value.deferredUntil, 0),
        })
      }
    }
    return map
  } catch {
    return new Map()
  }
}

/** 原子写占位表：先写 .tmp 再 rename，避免读到半截 JSON。 */
export function writeClaims(path, map) {
  if (path === undefined) return false
  try {
    mkdirSync(dirname(path), { recursive: true })
    const entries = [...map.entries()].slice(-500)
    const payload = { claims: Object.fromEntries(entries), updatedAt: new Date().toISOString() }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * 能不能自动交接。只读判断，不写盘。
 * @returns {{ ok: boolean, reason: string }}
 */
/**
 * @param force true 表示人手动要求（/handoff）：跳过冷却与次数限制，
 *              但仍然不能中断正在进行中的那一次，也不越过 deferred 的排队窗口。
 */
export function canAutoHandoff(entry, options, now, force) {
  if (entry === undefined) return { ok: true, reason: 'first' }
  if (TERMINAL_STATES.has(entry.state)) {
    return force === true ? { ok: true, reason: 'manual-after-' + entry.state } : { ok: false, reason: entry.state }
  }
  if (entry.state === 'deferred') {
    // 并发超限的排队：不是失败，时间到了自动重试。人工可以提前放行。
    const until = Number.isFinite(entry.deferredUntil) ? entry.deferredUntil : 0
    if (force === true) return { ok: true, reason: 'manual-after-deferred' }
    if (now < until) return { ok: false, reason: 'deferred' }
    return { ok: true, reason: 'deferred-expired' }
  }
  if (force === true && entry.state !== 'inflight') return { ok: true, reason: 'manual' }
  if (force === true && entry.state === 'inflight') {
    const age = now - entry.at
    return age < options.claimTtlMs ? { ok: false, reason: 'inflight' } : { ok: true, reason: 'manual-inflight-expired' }
  }
  const age = now - entry.at
  if (entry.state === 'inflight') {
    // 上一次交接还在进行中，或者进程死在半路留下了没关的占位。
    if (age < options.claimTtlMs) return { ok: false, reason: 'inflight' }
    return { ok: true, reason: 'inflight-expired' }
  }
  if (entry.state === 'failed') {
    if (entry.attempts >= options.maxAttempts) return { ok: false, reason: 'attempts-exhausted' }
    if (age < options.retryCooldownMs) return { ok: false, reason: 'cooldown' }
    return { ok: true, reason: 'retry' }
  }
  return { ok: true, reason: 'unknown-state' }
}

/**
 * 占位 + 写盘，同步完成，返回是否抢到。
 * 读改写全在同一段同步代码里，所以同一进程内不存在两个执行流同时抢到。
 */
export function reserveClaim(path, sessionId, options, now, force) {
  const map = readClaims(path)
  const verdict = canAutoHandoff(map.get(sessionId), options, now, force)
  if (!verdict.ok) return { reserved: false, reason: verdict.reason, map }
  const previous = map.get(sessionId)
  map.set(sessionId, {
    at: now,
    attempts: (previous === undefined ? 0 : previous.attempts) + 1,
    state: 'inflight',
    docPath: previous === undefined ? undefined : previous.docPath,
    newSessionId: previous === undefined ? undefined : previous.newSessionId,
    chainRoot: previous === undefined ? undefined : previous.chainRoot,
    chainDepth: previous === undefined ? 0 : previous.chainDepth,
    cwd: previous === undefined ? undefined : previous.cwd,
    trigger: previous === undefined ? undefined : previous.trigger,
    tokens: previous === undefined ? 0 : previous.tokens,
    toolCalls: previous === undefined ? 0 : previous.toolCalls,
    reviewVerdict: previous === undefined ? undefined : previous.reviewVerdict,
  })
  writeClaims(path, map)
  return { reserved: true, reason: verdict.reason, map }
}

/**
 * 更新一次占位的状态；succeeded=false 时保持可重试（attempts 已计过）。
 * patch 里的字段是「替换」语义：传了就覆盖，没传就沿用上一次的值。
 */
export function settleClaim(path, sessionId, patch, now) {
  const map = readClaims(path)
  const previous = map.get(sessionId)
  const keep = (key, fallback) => patch[key] ?? (previous === undefined ? fallback : previous[key])
  map.set(sessionId, {
    at: now,
    attempts: previous === undefined ? 1 : previous.attempts,
    state: patch.state,
    docPath: keep('docPath', undefined),
    newSessionId: keep('newSessionId', undefined),
    note: patch.note ?? (previous === undefined ? undefined : previous.note),
    chainRoot: keep('chainRoot', undefined),
    chainDepth: keep('chainDepth', 0),
    cwd: keep('cwd', undefined),
    trigger: keep('trigger', undefined),
    tokens: keep('tokens', 0),
    toolCalls: keep('toolCalls', 0),
    reviewVerdict: keep('reviewVerdict', undefined),
    stoppedReason: patch.stoppedReason ?? (previous === undefined ? undefined : previous.stoppedReason),
    stoppedAt: patch.stoppedAt ?? (previous === undefined ? 0 : previous.stoppedAt),
    deferredUntil: patch.deferredUntil ?? (previous === undefined ? 0 : previous.deferredUntil),
  })
  writeClaims(path, map)
}

/**
 * 同一个工作目录里「还活着的棒」：genesis（刚开出来、随时能再交接）与
 * inflight（正在交接着）。用来算并发上限 maxConcurrentHops。
 * @returns {string[]} 其他会话 id
 */
export function activeHops(map, cwd, excludeId) {
  const list = []
  if (typeof cwd !== 'string' || cwd === '') return list
  for (const [sessionId, entry] of map.entries()) {
    if (sessionId === excludeId) continue
    if (entry.cwd !== cwd) continue
    if (entry.state === 'genesis' || entry.state === 'inflight') list.push(sessionId)
  }
  return list
}
