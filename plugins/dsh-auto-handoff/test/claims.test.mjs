/**
 * 占位表的语义测试。
 *
 * 这些用例存在的理由：占位语义错了不会报错，只会让流水线静默停摆——
 * 比如把新会话写成 done，链条就永远停在第二棒，chainLimit 形同废纸，
 * 而所有「能触发一次」的测试仍然是绿的。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canAutoHandoff, claimsPath, readClaims, reserveClaim, settleClaim } from '../lib/claims.js'

const options = { claimTtlMs: 86400000, retryCooldownMs: 600000, maxAttempts: 3 }
const results = []

function check(name, fn) {
  fn()
  results.push('PASS ' + name)
}

check('没记录时可以交接', () => {
  assert.equal(canAutoHandoff(undefined, options, 0, false).ok, true)
})

check('done 是终态：自动路径拦住，人工 /handoff 放行', () => {
  const entry = { at: 0, attempts: 1, state: 'done' }
  assert.equal(canAutoHandoff(entry, options, 0, false).ok, false)
  assert.equal(canAutoHandoff(entry, options, 0, false).reason, 'done')
  assert.equal(canAutoHandoff(entry, options, 0, true).ok, true)
})

check('genesis 可再次交接（链条能走下去）', () => {
  assert.equal(canAutoHandoff({ at: 0, attempts: 1, state: 'genesis' }, options, 0, false).ok, true)
})

check('inflight 在 TTL 内拦住，过期放行', () => {
  const entry = { at: 0, attempts: 1, state: 'inflight' }
  assert.equal(canAutoHandoff(entry, options, options.claimTtlMs - 1, false).ok, false)
  assert.equal(canAutoHandoff(entry, options, options.claimTtlMs + 1, false).ok, true)
})

check('inflight 期间人工也打不断', () => {
  const entry = { at: 0, attempts: 1, state: 'inflight' }
  assert.equal(canAutoHandoff(entry, options, 1000, true).ok, false)
})

check('failed 有冷却，冷却期过后可重试', () => {
  const entry = { at: 0, attempts: 1, state: 'failed' }
  assert.equal(canAutoHandoff(entry, options, options.retryCooldownMs - 1, false).ok, false)
  assert.equal(canAutoHandoff(entry, options, options.retryCooldownMs + 1, false).ok, true)
})

check('failed 次数用尽后自动路径放弃，人工仍可强制', () => {
  const entry = { at: 0, attempts: 3, state: 'failed' }
  const late = options.retryCooldownMs * 10
  assert.equal(canAutoHandoff(entry, options, late, false).ok, false)
  assert.equal(canAutoHandoff(entry, options, late, false).reason, 'attempts-exhausted')
  assert.equal(canAutoHandoff(entry, options, late, true).ok, true)
})

const dir = await mkdtemp(join(tmpdir(), 'claims-test-'))
const file = join(dir, 'claims.json')
{
  const first = reserveClaim(file, 'sess-x', options, 1000, false)
  assert.equal(first.reserved, true)
  assert.equal(reserveClaim(file, 'sess-x', options, 2000, false).reserved, false, 'inflight 内不得重复抢')
  settleClaim(file, 'sess-x', { state: 'done', docPath: 'D:/a.md', chainRoot: 'sess-x', chainDepth: 0 }, 3000)
  const entry = readClaims(file).get('sess-x')
  assert.equal(entry.state, 'done')
  assert.equal(entry.docPath, 'D:/a.md')
  assert.equal(entry.attempts, 1)
  assert.equal(reserveClaim(file, 'sess-x', options, 4000, false).reserved, false, 'done 后自动路径不得重来')
  const manual = reserveClaim(file, 'sess-x', options, 5000, true)
  assert.equal(manual.reserved, true, '人工强制应放行')
  assert.equal(readClaims(file).get('sess-x').attempts, 2, 'attempts 应递增')
  results.push('PASS 落盘：reserve/settle 可读回，done 拦住自动路径但放行人工，attempts 递增')
}

{
  const broken = join(dir, 'broken.json')
  await writeFile(broken, '{oops', 'utf8')
  assert.equal(readClaims(broken).size, 0, '坏文件应当成空表而不是抛错')
  results.push('PASS 坏占位文件不崩主流程（当成空表）')
}

{
  const deep = await mkdtemp(join(tmpdir(), 'claims-deep-'))
  const p = claimsPath(deep)
  assert.ok(p.endsWith(join('.dsh', 'auto-handoff', 'claims.json')), '路径应在 ~/.dsh/auto-handoff/ 下')
  await rm(deep, { recursive: true, force: true })
  results.push('PASS claimsPath 落在 ~/.dsh/auto-handoff/claims.json')
}

await rm(dir, { recursive: true, force: true })

for (const line of results) console.log(line)
console.log('')
console.log('ALL CLAIMS TESTS PASSED')