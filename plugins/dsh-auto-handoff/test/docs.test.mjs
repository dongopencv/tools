/**
 * 交接简报渲染层的测试（v1.2，docs.js）。
 *
 * 为什么单独测这一层：简报是唯一跨会话传递的信息，它的**裁剪**最容易静默出错——
 * 旧版把「下一步」排在全文末尾、被 6000 字硬截断从尾部砍掉，8 份文档里 4 份没有下一步，
 * 而所有「能生成文档」的测试仍然全绿。这里的断言全部针对「丢了什么」。
 */
import assert from 'node:assert/strict'
import { clampSectionBody, INDEX_SECTIONS, renderBriefMeta, renderFacts, renderIndex, stripBriefMeta } from '../lib/docs.js'

const NL = String.fromCharCode(10)
const results = []

function check(name, fn) {
  fn()
  results.push('PASS ' + name)
}

const fullSections = {
  '目标': '把构建脚本改成跨平台。',
  '下一步': '1. 改 build.ps1' + NL + '2. 跑一遍测试',
  '约束与禁区': '不要动 CI 配置。',
  '未决问题': '要不要顺手删掉 .ps1？',
  '交接前 REVIEW': 'warn：待办清单还有 3 项未勾选',
  '档案索引': 'plugins/dsh-auto-handoff/lib/index.js',
}

function render(sections, options) {
  return renderIndex({
    meta: {
      sessionId: 'sess-a',
      title: '跨平台构建',
      chainRoot: 'sess-root',
      chainDepth: 2,
      hopLimit: 8,
      tokens: 450000,
      toolCalls: 120,
      trigger: 'turn-stopping',
      reviewVerdict: 'warn',
      createdAt: '2026-11-08T09:00:00.000Z',
    },
    sections,
    options: options === undefined ? { briefTargetChars: 3000, briefMaxChars: 6000 } : options,
  })
}

check('节预算表：六节、前两节必留、顺序即优先级', () => {
  assert.equal(INDEX_SECTIONS.length, 6)
  assert.deepEqual(INDEX_SECTIONS.filter((s) => s.required).map((s) => s.title), ['目标', '下一步'])
  assert.deepEqual(INDEX_SECTIONS.map((s) => s.title), ['目标', '下一步', '约束与禁区', '未决问题', '交接前 REVIEW', '档案索引'])
})

check('clampSectionBody 在行边界截断，不切半句', () => {
  const body = ['第一行完整内容', '第二行完整内容', '第三行完整内容'].join(NL)
  const out = clampSectionBody(body, 20)
  const lines = out.split(NL)
  assert.equal(lines[0], '第一行完整内容')
  const kept = lines.slice(0, -1)
  const note = lines[lines.length - 1]
  assert.match(note, /本节已按预算截断，另有 \d+ 行在完整文档里/u, '必须诚实说明丢了几行')
  // 尾注里报的行数必须等于真实丢掉的行数，否则「诚实」是假的。
  assert.equal(Number(/另有 (\d+) 行/u.exec(note)[1]), 3 - kept.length)
  for (const line of kept) assert.ok(body.includes(line), '保留的每一行都必须原本完整存在')
})

check('clampSectionBody 不超预算就不加尾注', () => {
  const out = clampSectionBody('短正文', 600)
  assert.equal(out, '短正文')
})

check('clampSectionBody 空输入返回空串（空节不渲染）', () => {
  assert.equal(clampSectionBody('', 600), '')
  assert.equal(clampSectionBody(undefined, 600), '')
})

check('renderIndex 六节顺序与 frontmatter 十一个键', () => {
  const text = render(fullSections)
  const order = ['## 目标', '## 下一步', '## 约束与禁区', '## 未决问题', '## 交接前 REVIEW', '## 档案索引']
  let last = -1
  for (const title of order) {
    const at = text.indexOf(title)
    assert.ok(at > last, title + ' 必须在上一节之后出现')
    last = at
  }
  for (const key of ['session', 'title', 'chain-root', 'chain-depth', 'hop-limit', 'tokens', 'tool-calls', 'trigger', 'review', 'created-at', 'created-by']) {
    assert.ok(text.includes(key + ': '), 'frontmatter 缺 ' + key)
  }
  assert.match(text, /# 交接简报 · 跨平台构建/)
})

check('renderIndex 必留两节永不整节丢弃（预算再紧也只按行截断）', () => {
  const text = render(fullSections, { briefTargetChars: 10, briefMaxChars: 6000 })
  assert.ok(text.includes('## 目标'), '目标节不能在预算压力下消失')
  assert.ok(text.includes('## 下一步'), '下一步节不能在预算压力下消失')
  assert.ok(!text.includes('## 档案索引'), '预算不足时应先丢最末的非必留节')
})

check('renderIndex 丢节时诚实告知，指向完整文档', () => {
  const text = render(fullSections, { briefTargetChars: 200, briefMaxChars: 6000 })
  assert.ok(text.includes('以下小节请到完整文档查'), '丢了必须说丢在哪')
})

check('renderIndex 硬顶 briefMaxChars', () => {
  const text = render(fullSections, { briefTargetChars: 3000, briefMaxChars: 200 })
  assert.ok(text.length <= 200, '硬顶必须生效，实际 ' + String(text.length))
})

check('renderIndex 空节不渲染（不产出空标题）', () => {
  const text = render({ '目标': '只有目标', '下一步': '' })
  assert.ok(text.includes('## 目标'))
  assert.ok(!text.includes('## 下一步'), '空的下一步不能留一个空标题冒充有内容')
})

check('renderFacts 每行都能独立 parse，字段齐全', () => {
  const text = renderFacts([
    { id: 'f1', type: 'user', at: '2026-11-08T09:00:00.000Z', text: '把构建脚本改成跨平台', ref: 'first' },
    { id: 'f2', type: 'file', at: '2026-11-08T09:00:00.000Z', text: 'F:\\proj\\build.ps1', ref: '' },
  ])
  const lines = text.split(NL)
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(first), ['id', 'type', 'at', 'text', 'ref'])
  assert.equal(first.type, 'user')
  assert.equal(JSON.parse(lines[1]).text, 'F:\\proj\\build.ps1')
})

check('renderFacts 跳过空 text，超长 text 截到 1000', () => {
  const text = renderFacts([
    { id: 'f1', type: 'user', text: '   ' },
    { id: 'f2', type: 'user', text: 'x'.repeat(1500) },
  ])
  const lines = text.split(NL).filter((line) => line !== '')
  assert.equal(lines.length, 1, '空 text 的行必须跳过')
  assert.equal(JSON.parse(lines[0]).text.length, 1000)
})

check('renderBriefMeta 第一行含棒次/上限/根/触发/同伴棒', () => {
  const line = renderBriefMeta({ hop: 3, limit: 8, root: 'sess-root', trigger: 'turn-stopping', tokens: 450000, toolCalls: 120, siblings: 2 })
  assert.match(line, /^链：第 3 棒 \/ 上限 8/)
  assert.ok(line.includes('根 sess-root'))
  assert.ok(line.includes('450000 tokens / 120 calls'))
  assert.ok(line.includes('同伴棒：2 个'))
})

check('stripBriefMeta 往返：剥掉元信息行后能认出这是交接简报', () => {
  const meta = renderBriefMeta({ hop: 2, limit: 8, root: 'r', trigger: 'manual', tokens: 1, toolCalls: 2, siblings: 0 })
  const brief = meta + NL + NL + '[自动交接] 上一会话 sess-x 达到阈值'
  assert.equal(stripBriefMeta(brief), '[自动交接] 上一会话 sess-x 达到阈值')
  assert.equal(stripBriefMeta('普通用户消息' + NL + '第二行'), '普通用户消息' + NL + '第二行', '不带元信息时原样返回')
})

check('简报里「下一步」的位置早于「档案索引」（这是旧版丢节的根因）', () => {
  const text = render(fullSections)
  assert.ok(text.indexOf('## 下一步') < text.indexOf('## 档案索引'))
  assert.ok(text.indexOf('## 下一步') < text.indexOf('## 交接前 REVIEW'))
})

console.log(['', ...results, '', 'ALL DOCS TESTS PASSED'].join(NL))
