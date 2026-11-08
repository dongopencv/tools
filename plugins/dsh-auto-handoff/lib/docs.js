/**
 * 交接简报的渲染层（v1.2，票 #29 定稿）。
 *
 * 为什么要把渲染从 index.js 拆出来：
 *   · 旧实现只有一份文档、一个 6000 字硬截断，而最贵的两节（下一步 / REVIEW）排在全文末尾，
 *     实测 8 份文档里 4 份整节丢掉「下一步」——新会话照着开工却无路可走；
 *   · 新的形态是三份文件（index.md 注入 / facts.jsonl 不注入 / full.md 人看），
 *     裁剪必须落在节边界，预算必须按节分配。这些规则是纯函数，能离线测。
 */

/** index.md 的小节与预算。顺序即裁剪优先级，前两节 required。 */
export const INDEX_SECTIONS = [
  { title: '目标', max: 600, required: true },
  { title: '下一步', max: 1200, required: true },
  { title: '约束与禁区', max: 500, required: false },
  { title: '未决问题', max: 400, required: false },
  { title: '交接前 REVIEW', max: 400, required: false },
  { title: '档案索引', max: 300, required: false },
]

/** 简报里包裹交接文档正文的两个分隔行（与旧版保持一致，交接测试与脚本都依赖它）。 */
export const DOC_BEGIN = '===== 交接文档开始 ====='
export const DOC_END = '===== 交接文档结束 ====='

/**
 * 按**行边界**截断一节正文。
 *
 * 不能切半句：clampText 的「截断半句 + …（已截断）」在有 Markdown 结构时会把
 * 一条命令、一个路径切成两半，新会话照着执行就错。宁可少一行。
 */
export function clampSectionBody(body, max) {
  const text = String(body === undefined || body === null ? '' : body).trim()
  if (text === '' || !Number.isFinite(max) || max <= 0) return text
  if (text.length <= max) return text
  const lines = text.split('\n')
  const kept = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (used + cost > max) break
    kept.push(line)
    used += cost
  }
  if (kept.length === 0) return ''
  const dropped = lines.length - kept.length
  return [...kept, '（本节已按预算截断，另有 ' + String(dropped) + ' 行在完整文档里）'].join('\n')
}

/** 一行 frontmatter。 */
function fm(key, value) {
  return key + ': ' + String(value)
}

/**
 * 渲染 index.md。
 *
 * 裁剪分两步：① 每节按自己的预算按行截断；② 总长超过 briefTargetChars 时，
 * 从**最末一个非必留小节**往前丢，直到落进目标预算或只剩必留两节。
 * 硬顶 briefMaxChars 仍然生效——超了就连「下一步」也按行截断，但永远不丢它整节。
 */
export function renderIndex(input) {
  const meta = (input && input.meta) || {}
  const provided = (input && input.sections) || {}
  const options = (input && input.options) || {}
  const target = Number.isFinite(options.briefTargetChars) ? options.briefTargetChars : 3000
  const hardMax = Number.isFinite(options.briefMaxChars) ? options.briefMaxChars : 6000

  const blocks = INDEX_SECTIONS.map((section) => ({
    title: section.title,
    max: section.max,
    required: section.required,
    body: clampSectionBody(provided[section.title], section.max),
  })).filter((section) => section.body !== '')

  const dropped = []
  const render = (list) => {
    const head = [
      '---',
      fm('session', meta.sessionId === undefined ? '' : meta.sessionId),
      fm('title', meta.title === undefined ? '' : meta.title),
      fm('chain-root', meta.chainRoot === undefined ? '' : meta.chainRoot),
      fm('chain-depth', meta.chainDepth === undefined ? 0 : meta.chainDepth),
      fm('hop-limit', meta.hopLimit === undefined ? 0 : meta.hopLimit),
      fm('tokens', meta.tokens === undefined ? 0 : meta.tokens),
      fm('tool-calls', meta.toolCalls === undefined ? 0 : meta.toolCalls),
      fm('trigger', meta.trigger === undefined ? '' : meta.trigger),
      fm('review', meta.reviewVerdict === undefined ? 'ok' : meta.reviewVerdict),
      fm('created-at', meta.createdAt === undefined ? '' : meta.createdAt),
      'created-by: [auto-handoff]',
      '---',
      '',
      '# 交接简报 · ' + String(meta.title === undefined ? '' : meta.title),
      '',
    ]
    const body = []
    for (const section of list) {
      body.push('## ' + section.title)
      body.push('')
      body.push(section.body)
      body.push('')
    }
    if (dropped.length > 0) body.push('（预算不足，以下小节请到完整文档查：' + dropped.join('、') + '）', '')
    return head.concat(body).join('\n')
  }

  let live = blocks.slice()
  let text = render(live)
  if (text.length > target) {
    const ordered = live.slice().reverse()
    for (const section of ordered) {
      if (section.required === true) continue
      const without = live.filter((item) => item.title !== section.title)
      if (without.length === 0) continue
      live = without
      dropped.unshift(section.title)
      text = render(live)
      if (text.length <= target) break
    }
  }
  if (text.length > hardMax) text = text.slice(0, hardMax)
  return text
}

/** 把事实数组渲染成 JSONL（每行一个可独立 parse 的对象）。 */
export function renderFacts(entries) {
  const lines = []
  let index = 0
  for (const entry of entries || []) {
    if (entry === null || typeof entry !== 'object') continue
    index += 1
    const text = String(entry.text === undefined ? '' : entry.text).trim()
    if (text === '') continue
    lines.push(
      JSON.stringify({
        id: String(entry.id === undefined ? 'f' + String(index) : entry.id),
        type: String(entry.type === undefined ? 'note' : entry.type),
        at: String(entry.at === undefined ? '' : entry.at),
        text: text.length > 1000 ? text.slice(0, 1000) : text,
        ref: String(entry.ref === undefined ? '' : entry.ref),
      }),
    )
  }
  return lines.join('\n')
}

/**
 * 简报最前面那行元信息（票 #18）。
 *
 * 为什么必须在第一行：人在侧栏只能看到会话标题（实测重启后 7 个 root 会话 7/7 标题为 null），
 * 而模型看的第一行就是这行。链第几棒、上限多少、触发点是什么、同目录还有几个同伴棒——
 * 这四项决定新会话「该不该接着干、还能干几棒」，比任何叙述都先到。
 */
export function renderBriefMeta(input) {
  const hop = input && input.hop !== undefined ? input.hop : 1
  const limit = input && input.limit !== undefined ? input.limit : 0
  const root = input && input.root !== undefined ? input.root : ''
  const trigger = input && input.trigger !== undefined ? input.trigger : ''
  const tokens = input && input.tokens !== undefined ? input.tokens : 0
  const toolCalls = input && input.toolCalls !== undefined ? input.toolCalls : 0
  const siblings = input && input.siblings !== undefined ? input.siblings : 0
  return (
    '链：第 ' + String(hop) + ' 棒 / 上限 ' + String(limit) +
    ' ｜ 根 ' + String(root) +
    ' ｜ 触发 ' + String(trigger) + '（' + String(tokens) + ' tokens / ' + String(toolCalls) + ' calls）' +
    ' ｜ 同伴棒：' + String(siblings) + ' 个'
  )
}

/**
 * 剥掉简报开头的元信息行。
 *
 * 下一棒的「原始目标」还原依赖识别「这是一份交接简报」（首行 [自动交接]）。
 * v1.2 把元信息行插到了它前面，若不先剥掉，第二棒就会把整份嵌套简报当成用户目标，
 * 一路内嵌下去（I-14 刚修完的同类事故）。
 */
export function stripBriefMeta(text) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n')
  let index = 0
  while (index < lines.length && /^链：第 \d+ 棒 \/ 上限 \d+/.test(lines[index].trim())) index += 1
  while (index < lines.length && lines[index].trim() === '') index += 1
  return lines.slice(index).join('\n')
}
