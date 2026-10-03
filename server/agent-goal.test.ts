import assert from 'node:assert/strict'
import test from 'node:test'
import type { SavedAnalysis } from '../shared/contracts'
import { buildAgentTestGoal } from './agent-goal'
import { resolveCaseExecutionContract } from './review-execution-context'

function analysis(blockedByQuestion = false): SavedAnalysis {
  return {
    id: '7aa1e1de-dcc0-4aa5-8182-c647d615c96a',
    fileName: '需求.md', fileNames: ['需求.md'], provider: 'test', model: 'test', createdAt: new Date().toISOString(),
    review: { confirmedQuestions: [], selectedCases: [], updatedAt: null },
    result: {
      versionName: '学生管理 1.0', productName: '工作台', overview: '学生管理',
      requirements: [{
        title: '新增学生', summary: '新增', risk: '中风险', riskReason: '写入数据',
        businessRules: [{ description: '姓名必填', evidence: 'PRD' }],
        pageStates: [{ trigger: '打开页面', initialState: '空表单', interaction: '保存', expectedResult: '保存成功' }],
        questions: [{ title: '保存结果如何反馈', reason: '需要确认', suggestion: '展示保存成功提示' }],
        testCases: [{
          title: '成功新增学生', type: '主流程', priority: 'P0', preconditions: ['已登录'],
          steps: ['输入学生姓名', '点击保存'], expectedResult: '页面显示保存成功', blockedByQuestion,
        }],
      }],
    },
  }
}

test('builds a single-case goal from the same resolved contract used for review', () => {
  const saved = analysis()
  const resolved = resolveCaseExecutionContract(saved, '0-TC-0')
  const goal = buildAgentTestGoal(saved, '0-TC-0', 'http://localhost:5173/students')
  assert.equal(goal.name, '成功新增学生')
  assert.equal(goal.objective, '成功新增学生')
  assert.equal(goal.executionContract?.caseKey, '0-TC-0')
  assert.equal(goal.executionContract?.contractFingerprint, resolved.contractFingerprint)
  assert.deepEqual(goal.executionContract?.contract, resolved.contract)
  assert.deepEqual(goal.requiredAssertions, [{ id: 'r1-tc1-a1', description: '页面显示保存成功' }])
})

test('rejects cases that still depend on unanswered product questions', () => {
  assert.throws(() => buildAgentTestGoal(analysis(true), '0-TC-0', 'http://localhost:5173/students'), /待确认问题/)
})

test('rejects stale or forged case keys', () => {
  assert.throws(() => buildAgentTestGoal(analysis(), '9-TC-9', 'http://localhost:5173/students'), /测试用例不存在/)
})

test('allows a blocked case after its question has an explicit human resolution', () => {
  const reviewed = analysis(true)
  reviewed.review.confirmedQuestions = ['0-Q-0']
  ;(reviewed.review as SavedAnalysis['review'] & { questionReviews?: Record<string, unknown> }).questionReviews = {
    '0-Q-0': { status: 'edited', finalStatement: '失败时展示提示并允许重试', updatedAt: null },
  }

  const goal = buildAgentTestGoal(reviewed, '0-TC-0', 'http://localhost:5173/students')

  assert.equal(goal.resolvedQuestions?.[0]?.finalStatement, '失败时展示提示并允许重试')
})

test('keeps a case blocked when the saved execution contract still has uncertainties', () => {
  const reviewed = analysis(true)
  reviewed.review.confirmedQuestions = ['0-Q-0']
  ;(reviewed.review as SavedAnalysis['review'] & { questionReviews?: Record<string, unknown> }).questionReviews = {
    '0-Q-0': {
      status: 'edited', finalStatement: '失败时展示提示并允许重试', updatedAt: null,
      executionContract: {
        objective: '验证反馈', triggers: [], preconditions: [], behaviors: ['展示提示'], assertions: ['提示可见'],
        forbiddenBehaviors: [], sourceHints: [], uncertainties: ['重试是否允许重复提交'], confidence: 'low',
      },
    },
  }

  assert.throws(() => buildAgentTestGoal(reviewed, '0-TC-0', 'http://localhost:5173/students'), /仍有不确定项/)
})

test('uses reviewed objective, assertions and runtime bindings without appending other cases', () => {
  const saved = analysis()
  saved.review.caseReviews = { '0-TC-0': {
    status: 'confirmed', updatedAt: null,
    finalContract: {
      objective: '验证真实学生部分搜索', preconditions: ['打开学生列表'], steps: ['从当前选项选择部分关键词'],
      expectedAssertions: ['匹配学生保留', '关键词高亮'], forbiddenBehaviors: ['不得编造学生姓名'], uncertainties: [],
      dataBindings: [{ id: 'student', label: '学生', mode: 'runtime_dom', targetHint: '学生列表', businessIntent: '部分搜索',
        strategy: 'visible_option_substring', constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true } }],
    },
  } }
  const goal = buildAgentTestGoal(saved, '0-TC-0', 'http://localhost:5173/students')
  const resolved = resolveCaseExecutionContract(saved, '0-TC-0')
  assert.equal(goal.objective, '验证真实学生部分搜索')
  assert.deepEqual(goal.requiredAssertions.map(item => item.description), ['匹配学生保留', '关键词高亮'])
  assert.deepEqual(goal.executionContract?.contract, resolved.contract)
  assert.equal(goal.executionContract?.contractFingerprint, resolved.contractFingerprint)

  saved.review.caseReviews['0-TC-0'].status = 'needs_data_review'
  assert.throws(() => buildAgentTestGoal(saved, '0-TC-0', goal.targetUrl), /确认测试数据/)
  saved.review.caseReviews['0-TC-0'].status = 'confirmed'
  saved.review.caseReviews['0-TC-0'].finalContract.dataBindings[0]!.mode = 'fixture'
  assert.throws(() => buildAgentTestGoal(saved, '0-TC-0', goal.targetUrl), /固定夹具.*缺少/)
  saved.review.caseReviews['0-TC-0'].finalContract.dataBindings[0]!.mode = 'manual'
  assert.throws(() => buildAgentTestGoal(saved, '0-TC-0', goal.targetUrl), /人工数据.*缺少/)
})
