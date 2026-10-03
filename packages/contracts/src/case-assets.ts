import { z } from 'zod'
import { caseReviewSchema, type CaseExecutionContract, type CaseReview, type ResolvedCaseExecutionContract } from './contracts'

export type CaseSource =
  | { type: 'requirement'; analysisId: string; caseKey: string }
  | { type: 'change_regression'; regressionId: string; suggestionId: string }
  | { type: 'case_design'; designId: string; draftId: string; publicationId: string; publicationVersion: number }

export interface CaseAsset {
  id: string
  title: string
  source: CaseSource
  revision: number
  reviewStatus: CaseReview['status'] | 'legacy_unreviewed'
  originalSuggestion: CaseExecutionContract
  finalContract: CaseExecutionContract
  resolved: ResolvedCaseExecutionContract
  createdAt: string
  updatedAt: string
}

export interface CaseAssetRevision {
  revision: number
  resolved: ResolvedCaseExecutionContract
  review: CaseReview | null
  createdAt: string
}

export const caseAssetReviewRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  review: caseReviewSchema.omit({ updatedAt: true }),
})
