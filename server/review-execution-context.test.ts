import assert from 'node:assert/strict'
import test from 'node:test'
import type { SavedAnalysis } from '../shared/contracts'
import { collectResolvedReviewContext } from './review-execution-context'

const analysis = {
  result: {
    requirements: [{
      title: '批量生成报告', summary: '报告', risk: '高风险', riskReason: '错误反馈',
      businessRules: [{ description: '失败不重复创建', evidence: '方案' }],
      pageStates: [{ trigger: '失败', initialState: '填写完成', interaction: '点击执行', expectedResult: '提示失败' }],
      questions: [{ title: '失败反馈', reason: '不明确', suggestion: '展示提示' }],
      testCases: [{ title: '失败可重试', type: '异常', priority: 'P0', preconditions: [], steps: ['点击执行'], expectedResult: '可重试', blockedByQuestion: true }],
    }],
  },
  review: {
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    questionReviews: {
      '0-Q-0': { status: 'edited', finalStatement: '失败时保留表单并允许重试', updatedAt: null, executionContract: {
        objective: '验证失败反馈', triggers: ['接口失败'], preconditions: [], behaviors: ['展示失败提示'], assertions: ['失败提示可见'], forbiddenBehaviors: [], sourceHints: [], uncertainties: [], confidence: 'medium',
      } },
    },
  },
} as unknown as SavedAnalysis

test('collects resolved human口径 and execution assertions for selected cases', () => {
  const contexts = collectResolvedReviewContext(analysis, ['0-TC-0'])

  assert.equal(contexts.length, 1)
  assert.equal(contexts[0]?.finalStatement, '失败时保留表单并允许重试')
  assert.deepEqual(contexts[0]?.assertions, ['失败提示可见'])
})

test('does not pass deferred review口径 into execution planning', () => {
  const deferred = structuredClone(analysis) as SavedAnalysis
  deferred.review.questionReviews!['0-Q-0']!.status = 'deferred'

  assert.deepEqual(collectResolvedReviewContext(deferred, ['0-TC-0']), [])
})
