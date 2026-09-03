import assert from 'node:assert/strict'
import test from 'node:test'
import { isCaseReviewExecutable, isQuestionReviewResolved, normalizeReviewState } from '../shared/review-state'

const contract = (dataBindings: unknown[] = []) => ({
  objective: '验证考试筛选',
  preconditions: ['已进入考试页面'],
  steps: ['打开考试选择器'],
  expectedAssertions: ['显示筛选结果'],
  dataBindings,
  forbiddenBehaviors: [],
  uncertainties: [],
})

const binding = (mode: 'runtime_dom' | 'fixture' | 'manual', data: Record<string, unknown> = {}) => ({
  id: 'exam-query',
  label: '考试搜索词',
  mode,
  targetHint: '选择考试输入框',
  businessIntent: '验证部分关键词筛选',
  constraints: {
    mustComeFromCurrentDom: mode === 'runtime_dom',
    mustBePartialOfSource: mode === 'runtime_dom',
    mustRemainAfterFiltering: mode === 'runtime_dom',
  },
  ...data,
})

test('normalizes legacy review records without losing confirmation state', () => {
  const review = normalizeReviewState({
    confirmedQuestions: ['0-Q-0'],
    selectedCases: ['0-TC-1'],
    updatedAt: null,
  })

  assert.deepEqual(review.questionReviews, {})
  assert.equal(isQuestionReviewResolved(review, '0-Q-0'), true)
  assert.equal(isQuestionReviewResolved(review, '0-Q-1'), false)
})

test('treats accepted and edited resolutions as executable, but not deferred ones', () => {
  const accepted = normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    questionReviews: {
      '0-Q-0': { status: 'accepted', finalStatement: '采纳建议', updatedAt: null },
      '0-Q-1': { status: 'edited', finalStatement: '人工补充口径', updatedAt: null },
      '0-Q-2': { status: 'deferred', finalStatement: '稍后确认', updatedAt: null },
    },
  })

  assert.equal(isQuestionReviewResolved(accepted, '0-Q-0'), true)
  assert.equal(isQuestionReviewResolved(accepted, '0-Q-1'), true)
  assert.equal(isQuestionReviewResolved(accepted, '0-Q-2'), false)
})

test('lets an explicit deferred review override a legacy confirmation flag', () => {
  const review = normalizeReviewState({
    confirmedQuestions: ['0-Q-0'], selectedCases: [], updatedAt: null,
    questionReviews: { '0-Q-0': { status: 'deferred', finalStatement: '还需要确认', updatedAt: null } },
  })

  assert.equal(isQuestionReviewResolved(review, '0-Q-0'), false)
})

test('keeps legacy cases executable when case reviews are absent', () => {
  const review = normalizeReviewState({
    confirmedQuestions: [], selectedCases: ['0-TC-0'], updatedAt: null,
  })

  assert.deepEqual(review.caseReviews, {})
  assert.deepEqual(isCaseReviewExecutable(review, '0-TC-0', 'agent'), { executable: true })
  assert.deepEqual(isCaseReviewExecutable(review, '0-TC-0', 'plan'), { executable: true })
})

test('requires a confirmed case review before an explicit contract can execute', () => {
  const draft = normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': { status: 'draft', finalContract: contract(), updatedAt: null },
    },
  })

  assert.equal(isCaseReviewExecutable(draft, '0-TC-0', 'agent').executable, false)

  draft.caseReviews!['0-TC-0']!.status = 'needs_data_review'
  assert.equal(isCaseReviewExecutable(draft, '0-TC-0', 'agent').executable, false)
  assert.equal(isCaseReviewExecutable(draft, '0-TC-0', 'plan').executable, false)

  draft.caseReviews!['0-TC-0']!.status = 'confirmed'
  assert.deepEqual(isCaseReviewExecutable(draft, '0-TC-0', 'agent'), { executable: true })
})

test('rejects confirmed contracts without executable steps or assertions', () => {
  assert.throws(() => normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': {
        status: 'confirmed',
        finalContract: { ...contract(), steps: [], expectedAssertions: [] },
        updatedAt: null,
      },
    },
  }))
})

test('does not execute a confirmed contract made incomplete after normalization', () => {
  const review = normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': { status: 'confirmed', finalContract: contract(), updatedAt: null },
    },
  })

  review.caseReviews!['0-TC-0']!.finalContract.steps = []
  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'agent').executable, false)

  review.caseReviews!['0-TC-0']!.finalContract.steps = ['打开考试选择器']
  review.caseReviews!['0-TC-0']!.finalContract.expectedAssertions = []
  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'agent').executable, false)
})

test('requires fixture values and evidence for confirmed contracts', () => {
  const review = normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': {
        status: 'confirmed',
        finalContract: contract([binding('fixture', { fixture: { value: '模考数学一' } })]),
        updatedAt: null,
      },
    },
  })

  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'agent').executable, false)
  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'plan').executable, false)
})

test('requires manual values and rationale for confirmed contracts', () => {
  const review = normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': {
        status: 'confirmed',
        finalContract: contract([binding('manual', { manual: { value: '', rationale: '本次人工指定' } })]),
        updatedAt: null,
      },
    },
  })

  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'agent').executable, false)
  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'plan').executable, false)
})

test('allows unresolved runtime DOM bindings only for dynamic agent execution', () => {
  const review = normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': {
        status: 'confirmed',
        finalContract: contract([binding('runtime_dom', { strategy: 'visible_option_substring' })]),
        updatedAt: null,
      },
    },
  })

  assert.deepEqual(isCaseReviewExecutable(review, '0-TC-0', 'agent'), { executable: true })
  assert.equal(isCaseReviewExecutable(review, '0-TC-0', 'plan').executable, false)
})

test('rejects data bindings that use the wrong payload for their mode', () => {
  assert.throws(() => normalizeReviewState({
    confirmedQuestions: [], selectedCases: [], updatedAt: null,
    caseReviews: {
      '0-TC-0': {
        status: 'confirmed',
        finalContract: contract([binding('runtime_dom', {
          strategy: 'visible_option_substring',
          fixture: { value: '数学', evidence: '页面快照' },
        })]),
        updatedAt: null,
      },
    },
  }))
})
