import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { samples } from './samples'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const escape = (value: unknown) => String(value ?? '未记录').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!).replace(/([\\`*_{}[\]()#+.!|])/g, '\\$1').replace(/\r?\n/g, '\n\n')
function json(value: unknown) {
  const content = JSON.stringify(value ?? null, null, 2)
  const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(match => match[0].length + 1)))
  return `${fence}json\n${content}\n${fence}`
}
function bullets(value: unknown) {
  if (!Array.isArray(value)) return '未记录（不代表无要求）。'
  return value.map(item => `- ${typeof item === 'string' ? escape(item) : json(item)}`).join('\n') || '记录为空列表（是否确实无要求需人工核对）。'
}

// Generate review material only. Never infer approval from machine/model scores.
export function buildReviewPack(raw: string) {
  const file = JSON.parse(raw)
  if (!Array.isArray(file.results?.results) || !file.results.results.length) throw new Error('结果必须包含至少一条实际评估记录，不能为零项结果生成审核包')
  const sourceHash = createHash('sha256').update(raw).digest('hex')
  const index = ['# 用例生成逐项人工审核包', '', `原始结果 SHA256：${sourceHash}`, '', '全部结论待人工填写。机器检查通过、模型审查通过和用例数量都不代表语义质量通过；本包不更新平台审核或发布状态。各次结果独立保留，不合并成最佳答案。', '', '## 审核入口', '']
  const files: Array<{ name: string; content: string }> = []
  const attempts = new Map<string, number>()
  for (const [position, rawRow] of file.results.results.entries()) {
    const row = object(rawRow), response = object(row.response), metadata = object(response.metadata)
    let payload: ObjectValue = {}, output: ObjectValue = {}
    try { payload = object(JSON.parse(String(object(row.vars).payload))) } catch { /* Raw record remains in appendix. */ }
    try { output = object(JSON.parse(String(response.output))) } catch { /* Failure is not converted to an empty success. */ }
    const sampleId = String(payload.sampleId ?? '未知样本'), provider = String(object(row.provider).id ?? '未知配置')
    const key = `${sampleId}/${provider}`, attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    const name = `review-${String(position + 1).padStart(3, '0')}.md`
    const title = `${sampleId} / ${provider} / 第${attempt}次`
    index.push(`- [${escape(title)}](${name}) — ${row.success ? '机器检查通过，待人工审核' : '未通过，需检查失败及局部产物'}`)
    const failedRun = object(metadata.failedRun)
    const completed = list(metadata.stages)
    const final = object(output.output ?? failedRun.output ?? object(completed.at(-1)).output)
    const sample = samples.find(item => item.id === sampleId)
    const lines = [`# ${escape(title)}`, '', '[返回审核目录](index.md)', '', `来源文件 SHA256：${sourceHash}；原始结果数组位置：${position}（从0开始）。`, '', `机器状态：${row.success ? '通过，非人工验收' : '未通过'}。人工状态：待审核。`, '', '## 输入材料（原始记录）', '', json(payload), '', '## 审核参考（尚非人工金标准）', '', json(sample?.expectations ?? { note: '样本不在当前参考集中，请审核原始材料，不补造期望' }), '', '## 失败信息', '', escape(response.error ?? row.error ?? object(row.gradingResult).reason ?? '未记录错误，不代表语义正确'), '', '## 完整用例', '']
    const cases = list(final.cases)
    for (const [i, item] of cases.entries()) {
      const draft = object(item), contract = object(draft.contract)
      lines.push(`### ${i + 1}. ${escape(draft.title)}`, '', `用例 ID：${escape(draft.id)}；验证方式：${escape(draft.verification)}。`, '', escape(draft.verificationReason), '', '#### 测试目标', '', escape(contract.objective))
      for (const [field, label] of [['preconditions', '前置条件'], ['steps', '操作步骤'], ['expectedAssertions', '预期断言'], ['forbiddenBehaviors', '禁止行为'], ['uncertainties', '待确认信息']]) lines.push('', `#### ${label}`, '', bullets(contract[field]))
      lines.push('', '#### 数据来源与运行时策略（完整字段）', '', json(contract.dataBindings), '', '#### 原始用例（含关联字段，不省略）', '', json(draft), '')
    }
    if (!cases.length) lines.push('没有保存新流程用例；不把缺失产物视为零风险。旧流程完整需求与用例见下一节。', '')
    lines.push('## 旧流程完整产物', '', json(output.analysis), '', '## 事实、场景与审查产物', '', json(final), '', '## 人工逐项结论', '', '| 审核项 | 结论（符合 / 不符合 / 待确认） | 原文依据、涉及用例与修改建议 |', '|---|---|---|', ...['事实是否忠于原文，冲突是否保留', '业务场景、边界与异常是否覆盖', '前置条件和账号数据是否真实可取得', '操作、预期和数据策略是否一致', '是否编造规则或混淆示例与实际数据', '验证方式是否可执行，能力边界是否明确', '与其他配置相比改善或退化（允许无结论）'].map(label => `| ${label} | 待填写 | 待填写 |`), '', '- 评审人：待填写', '- 评审日期：待填写', '- 最终结论及理由：待填写', '', '<details>', '<summary>完整原始结果记录（含阶段版本、Skills、局部失败和原始响应）</summary>', '', json(row), '', '</details>', '')
    files.push({ name, content: lines.join('\n') })
  }
  return [{ name: 'index.md', content: index.join('\n') + '\n' }, ...files]
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [source, destination] = process.argv.slice(2)
  if (!source || !destination) throw new Error('用法：review-pack.ts results.json 新审核目录（不得已存在）')
  const files = buildReviewPack(readFileSync(source, 'utf8'))
  mkdirSync(destination) // Refuse an existing review directory: never overwrite human notes.
  for (const file of files) writeFileSync(join(destination, file.name), file.content, { flag: 'wx' })
  console.log(`已生成 ${files.length - 1} 份待人工审核材料；未修改原始结果或平台审核状态。`)
}
