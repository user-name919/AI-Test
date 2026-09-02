import assert from 'node:assert/strict'
import test from 'node:test'
import { isQuestionReviewResolved, normalizeReviewState } from '../shared/review-state'

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
