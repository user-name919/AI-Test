import type { AnalysisSummary, PrdAnalysis, ReviewState, SavedAnalysis } from '@quality-ai/contracts'
import { isQuestionReviewResolved, normalizeReviewState } from '@quality-ai/contracts/review-state'
import { database } from '../../storage/database'

export function saveAnalysis(input: {
  id: string
  fileName: string
  fileNames: string[]
  sourceText: string
  provider: string
  model: string
  result: PrdAnalysis
  createdAt: string
}) {
  database.prepare(`
    INSERT INTO analyses (id, file_name, file_names_json, source_text, provider, model, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.fileName, JSON.stringify(input.fileNames), input.sourceText, input.provider, input.model, JSON.stringify(input.result), input.createdAt)
}

function mapAnalysisRow(row: Record<string, string> | undefined): SavedAnalysis | null {
  if (!row) return null
  return {
    id: row.id,
    fileName: row.file_name,
    fileNames: JSON.parse(row.file_names_json || '[]') as string[],
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    result: JSON.parse(row.result_json) as PrdAnalysis,
    review: normalizeReviewState({
      confirmedQuestions: JSON.parse(row.confirmed_questions_json || '[]') as string[],
      selectedCases: JSON.parse(row.selected_cases_json || '[]') as string[],
      questionReviews: JSON.parse(row.question_reviews_json || '{}') as ReviewState['questionReviews'],
      caseReviews: JSON.parse(row.case_reviews_json || '{}') as ReviewState['caseReviews'],
      updatedAt: row.updated_at ?? null,
    }),
  }
}

const analysisSelect = `
  SELECT a.id, a.file_name, a.file_names_json, a.provider, a.model, a.result_json, a.created_at,
         r.confirmed_questions_json, r.selected_cases_json, r.question_reviews_json, r.case_reviews_json, r.updated_at
  FROM analyses a LEFT JOIN analysis_reviews r ON r.analysis_id = a.id
`

export function getLatestAnalysis(): SavedAnalysis | null {
  const row = database.prepare(`${analysisSelect}
    ORDER BY a.created_at DESC LIMIT 1
  `).get() as Record<string, string> | undefined
  return mapAnalysisRow(row)
}

export function getAnalysisById(id: string): SavedAnalysis | null {
  return mapAnalysisRow(database.prepare(`${analysisSelect} WHERE a.id = ?`).get(id) as Record<string, string> | undefined)
}

export function listAnalyses(limit = 30): AnalysisSummary[] {
  const rows = database.prepare(`${analysisSelect} ORDER BY a.created_at DESC LIMIT ?`).all(limit) as Array<Record<string, string>>
  return rows.flatMap(row => {
    const analysis = mapAnalysisRow(row)
    if (!analysis) return []
    const requirements = analysis.result.requirements
    return [{
      id: analysis.id,
      versionName: analysis.result.versionName,
      productName: analysis.result.productName,
      requirementCount: requirements.length,
      questionCount: requirements.reduce((sum, item) => sum + item.questions.length, 0),
      confirmedQuestionCount: requirements.reduce((sum, requirement, requirementIndex) => sum + requirement.questions.filter((_, questionIndex) => isQuestionReviewResolved(analysis.review, `${requirementIndex}-Q-${questionIndex}`)).length, 0),
      testCaseCount: requirements.reduce((sum, item) => sum + item.testCases.length, 0),
      selectedCaseCount: analysis.review.selectedCases.length,
      provider: analysis.provider,
      model: analysis.model,
      createdAt: analysis.createdAt,
    }]
  })
}

export function saveReview(analysisId: string, review: Omit<ReviewState, 'updatedAt'>): ReviewState {
  const exists = database.prepare('SELECT id FROM analyses WHERE id = ?').get(analysisId)
  if (!exists) throw new Error('解析记录不存在')
  const updatedAt = new Date().toISOString()
  database.prepare(`
    INSERT INTO analysis_reviews (analysis_id, confirmed_questions_json, selected_cases_json, question_reviews_json, case_reviews_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(analysis_id) DO UPDATE SET
      confirmed_questions_json = excluded.confirmed_questions_json,
      selected_cases_json = excluded.selected_cases_json,
      question_reviews_json = excluded.question_reviews_json,
      case_reviews_json = excluded.case_reviews_json,
      updated_at = excluded.updated_at
  `).run(
    analysisId,
    JSON.stringify(review.confirmedQuestions),
    JSON.stringify(review.selectedCases),
    JSON.stringify(review.questionReviews ?? {}),
    JSON.stringify(review.caseReviews ?? {}),
    updatedAt,
  )
  return normalizeReviewState({
    ...review,
    questionReviews: review.questionReviews ?? {},
    caseReviews: review.caseReviews ?? {},
    updatedAt,
  })
}
