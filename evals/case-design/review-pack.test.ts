import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewPack } from './review-pack'

test('人工包保留完整契约、原文和每次结果，不把机器通过当人工批准', () => {
  const draft = { id: 'C1', title: '<script>标题</script>', verification: 'browser', verificationReason: '实际页面', contract: { objective: '部分搜索', preconditions: ['先打开下拉框'], steps: ['记录真实选项', '输入严格子串'], expectedAssertions: ['匹配且高亮'], dataBindings: [{ id: 'keyword', source: 'runtime-dom', strategy: { kind: 'substring' } }], forbiddenBehaviors: ['不得编造选项'], uncertainties: ['高亮颜色未定义'] } }
  const row = { provider: { id: 'quality-ai-skills' }, success: true, vars: { payload: JSON.stringify({ sampleId: 'partial-search', documents: [{ content: '原文 ``` </details>' }] }) }, response: { output: JSON.stringify({ output: { cases: [draft], issues: [{ reason: '待人工确认' }] }, stages: [{ promptVersion: 'actual-version' }] }) } }
  const raw = JSON.stringify({ results: { results: [row, row] } })
  const files = buildReviewPack(raw)
  assert.equal(files.length, 3)
  assert.match(files[0].content, /第2次/)
  assert.match(files[1].content, /人工状态：待审核/)
  assert.match(files[1].content, /输入严格子串/)
  assert.match(files[1].content, /&lt;script&gt;/)
  assert.match(files[1].content, /actual-version/)
  assert.match(files[1].content, /不得编造选项/)
  assert.match(files[1].content, /````json/)
  assert.match(files[1].content, /"kind": "substring"/)
  assert.equal(JSON.stringify(JSON.parse(raw).results.results[0]), JSON.stringify(row))
})

test('失败保留当前及上游阶段材料；旧流程不伪装成新契约；零项明确拒绝', () => {
  const base = { provider: { id: 'quality-ai-pipeline' }, success: false, vars: { payload: JSON.stringify({ sampleId: 'state' }) } }
  const rows = [{ ...base, response: { error: '生成失败', metadata: { stages: [{ output: { facts: [{ statement: '完整事实' }] } }], failedRun: { promptVersion: 'v4', output: { facts: [{ statement: '完整事实' }], generationAttempts: [{ error: '格式错误' }] } } } } }, { ...base, response: { output: JSON.stringify({ analysis: { requirements: [{ testCases: [{ title: '旧用例', steps: ['旧完整步骤'] }] }] } }) } }]
  const files = buildReviewPack(JSON.stringify({ results: { results: rows } }))
  assert.match(files[1].content, /完整事实/)
  assert.match(files[1].content, /格式错误/)
  assert.match(files[1].content, /生成失败/)
  assert.match(files[2].content, /旧完整步骤/)
  assert.throws(() => buildReviewPack('{"results":{"results":[]}}'), /零项/)
})
