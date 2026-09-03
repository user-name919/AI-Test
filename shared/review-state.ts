import { reviewStateSchema, type ReviewState } from './contracts'

export function normalizeReviewState(value: unknown): ReviewState {
  return reviewStateSchema.parse(value)
}

export function isQuestionReviewResolved(review: ReviewState, questionKey: string) {
  const questionReview = review.questionReviews?.[questionKey]
  if (questionReview) {
    return questionReview.finalStatement.trim().length > 0
      && (questionReview.status === 'accepted' || questionReview.status === 'edited')
  }
  return review.confirmedQuestions.includes(questionKey)
}

export function isCaseReviewExecutable(
  review: ReviewState,
  caseKey: string,
  mode: 'agent' | 'plan',
): { executable: boolean; reason?: string } {
  const caseReview = review.caseReviews?.[caseKey]
  if (!caseReview) return { executable: true }

  if (caseReview.status === 'draft') {
    return { executable: false, reason: '用例契约尚未确认' }
  }
  if (caseReview.status === 'needs_data_review') {
    return { executable: false, reason: '用例需要确认测试数据' }
  }

  for (const binding of caseReview.finalContract.dataBindings) {
    if (binding.mode === 'fixture' && (!binding.fixture?.value?.trim() || !binding.fixture.evidence?.trim())) {
      return { executable: false, reason: `固定夹具“${binding.label}”缺少值或证据` }
    }
    if (binding.mode === 'manual' && (!binding.manual?.value?.trim() || !binding.manual.rationale?.trim())) {
      return { executable: false, reason: `人工数据“${binding.label}”缺少值或说明` }
    }
    if (binding.mode === 'runtime_dom' && mode === 'plan') {
      return { executable: false, reason: `运行时数据“${binding.label}”需要预检解析` }
    }
  }

  return { executable: true }
}
