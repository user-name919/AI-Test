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
