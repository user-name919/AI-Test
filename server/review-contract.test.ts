import assert from 'node:assert/strict'
import test from 'node:test'
import type { RequirementAnalysis, ReviewExecutionContract } from '../shared/contracts'
import { collectReviewSourceContext, generateReviewExecutionContract } from './review-contract'

const requirement: RequirementAnalysis = {
  title: '批量生成报告',
  summary: '按考试和老师生成报告。',
  risk: '高风险',
  riskReason: '失败反馈会影响老师判断。',
  businessRules: [{ description: '失败时不能重复创建任务', evidence: '技术方案' }],
  pageStates: [{ trigger: '接口失败', initialState: '表单已填写', interaction: '点击执行', expectedResult: '展示失败提示' }],
  questions: [{ title: '失败如何反馈', reason: '文档没有明确提示和重试规则', suggestion: '提供明确提示并允许重试' }],
  testCases: [{
    title: '报告生成失败可重试', type: '异常', priority: 'P0', preconditions: ['已登录'],
    steps: ['点击执行', '模拟接口失败'], expectedResult: '展示失败提示并可重试', blockedByQuestion: true,
  }],
}

const contract: ReviewExecutionContract = {
  objective: '验证报告生成失败时的反馈和重试行为',
  triggers: ['报告生成接口返回失败'],
  preconditions: ['已登录并填写有效表单'],
  behaviors: ['展示明确失败提示', '保留当前表单内容', '重试按钮可用'],
  assertions: ['页面出现失败提示', '重试按钮可操作'],
  forbiddenBehaviors: ['不能重复创建任务', '不能清空用户输入'],
  sourceHints: ['BatchGenerateReport.vue 的错误处理逻辑'],
  uncertainties: [],
  confidence: 'high',
}

test('turns a human review statement into a structured execution contract', async () => {
  let prompt = ''
  const result = await generateReviewExecutionContract({
    question: requirement.questions[0],
    finalStatement: '失败时要告诉老师原因，保留填写内容，并允许点击重试。',
    requirement,
    testCase: requirement.testCases[0],
    sourceContext: { files: [{ path: 'src/views/BatchGenerateReport.vue', content: '显示错误提示并保留表单', truncated: false }] },
  }, {
    client: { generateText: async input => { prompt = input.messages.map(message => message.content).join('\n'); return JSON.stringify(contract) } },
  })

  assert.deepEqual(result, contract)
  assert.match(prompt, /失败时要告诉老师原因/)
  assert.match(prompt, /BatchGenerateReport\.vue/)
  assert.match(prompt, /json/i)
})

test('rejects a contract without an actionable assertion', async () => {
  await assert.rejects(generateReviewExecutionContract({
    question: requirement.questions[0], finalStatement: '失败要处理一下', requirement, testCase: requirement.testCases[0],
  }, {
    client: { generateText: async () => JSON.stringify({ ...contract, assertions: [] }) },
}), /至少需要一条可验证断言/)
})

test('collects only route and local component context through the project Provider', async () => {
  const calls: string[] = []
  const context = await collectReviewSourceContext({
    async resolveRoute() {
      calls.push('resolve_route')
      return {
        url: 'https://test.example.com/mock-exam', pathname: '/mock-exam', routePath: '/mock-exam',
        routeFile: 'src/router/index.js', componentFile: 'src/views/mockExam/BatchGenerateReport.vue', confidence: 'exact',
      }
    },
    async searchSource() { calls.push('search_source'); return [] },
    async inspectFiles({ paths }) {
      calls.push(`inspect_files:${paths.join(',')}`)
      return { projectId: 'lvworkbench', reason: 'review', totalCharacters: 12, files: paths.map(path => ({ path, content: '局部源码', truncated: false })) }
    },
    async getProjectInfo() { throw new Error('not used') },
  }, 'https://test.example.com/mock-exam', requirement, requirement.questions[0])

  assert.deepEqual(calls, ['resolve_route', 'inspect_files:src/router/index.js,src/views/mockExam/BatchGenerateReport.vue'])
  assert.equal(context.files.length, 2)
  assert.equal(context.warnings.length, 0)
})
