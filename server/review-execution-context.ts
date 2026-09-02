import type { SavedAnalysis, ReviewExecutionContract } from '../shared/contracts'
import { isQuestionReviewResolved } from '../shared/review-state'

export interface ResolvedReviewContext {
  questionKey: string
  questionTitle: string
  finalStatement: string
  objective?: string
  triggers: string[]
  behaviors: string[]
  assertions: string[]
  forbiddenBehaviors: string[]
  sourceHints: string[]
  uncertainties: string[]
  confidence?: ReviewExecutionContract['confidence']
}

export function collectResolvedReviewContext(analysis: SavedAnalysis, caseKeys: string[]): ResolvedReviewContext[] {
  const requirementIndexes = new Set(caseKeys.flatMap(key => {
    const match = key.match(/^(\d+)-TC-\d+$/)
    return match ? [Number(match[1])] : []
  }))
  return [...requirementIndexes].flatMap(requirementIndex => {
    const requirement = analysis.result.requirements[requirementIndex]
    if (!requirement) return []
    return requirement.questions.flatMap((question, questionIndex) => {
      const questionKey = `${requirementIndex}-Q-${questionIndex}`
      const review = analysis.review.questionReviews?.[questionKey]
      if (!review || !isQuestionReviewResolved(analysis.review, questionKey)) return []
      return [{
        questionKey,
        questionTitle: question.title,
        finalStatement: review.finalStatement,
        objective: review.executionContract?.objective,
        triggers: review.executionContract?.triggers ?? [],
        behaviors: review.executionContract?.behaviors ?? [],
        assertions: review.executionContract?.assertions ?? [],
        forbiddenBehaviors: review.executionContract?.forbiddenBehaviors ?? [],
        sourceHints: review.executionContract?.sourceHints ?? [],
        uncertainties: review.executionContract?.uncertainties ?? [],
        confidence: review.executionContract?.confidence,
      }]
    })
  })
}
