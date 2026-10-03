import { z } from 'zod'
import { caseExecutionContractSchema } from './contracts'

export const evidenceRefSchema = z.object({ documentId: z.string().min(1), blockId: z.string().min(1), quote: z.string().min(1) })
export const documentBlockSchema = z.object({
  id: z.string().min(1), documentId: z.string().min(1),
  kind: z.enum(['heading', 'paragraph', 'table', 'image_placeholder']),
  page: z.number().int().positive().optional(), section: z.string().optional(),
  text: z.string(), warnings: z.array(z.string()),
})
export const designDocumentSchema = z.object({
  id: z.string().uuid(), fileName: z.string().min(1), role: z.enum(['prd', 'interface']),
  contentHash: z.string(), version: z.number().int().positive(),
  blocks: z.array(documentBlockSchema), warnings: z.array(z.string()),
})
export const requirementFactSchema = z.object({
  id: z.string().min(1), statement: z.string().min(1), kind: z.enum(['explicit', 'inferred', 'unresolved']),
  evidence: z.array(evidenceRefSchema), relatedQuestionIds: z.array(z.string()),
})
export interface CaseDesign {
  id: string
  name: string
  revision: number
  documents: DesignDocument[]
  inputHash: string
  createdAt: string
  updatedAt: string
}
export type DesignDocument = z.infer<typeof designDocumentSchema>
export type DocumentBlock = z.infer<typeof documentBlockSchema>
export type EvidenceRef = z.infer<typeof evidenceRefSchema>
export type RequirementFact = z.infer<typeof requirementFactSchema>

export const factExtractionSchema = z.object({
  facts: z.array(requirementFactSchema),
  questions: z.array(z.object({ id: z.string().min(1), question: z.string().min(1), evidence: z.array(evidenceRefSchema) })),
})
export type FactExtraction = z.infer<typeof factExtractionSchema>
export const factModelSchema = z.object({
  consolidatedFacts: z.array(requirementFactSchema.extend({ sourceFactIds: z.array(z.string()).min(1) })),
  conflicts: z.array(z.object({ id:z.string().min(1), factIds:z.array(z.string()).min(2), question:z.string().min(1), evidence:z.array(evidenceRefSchema).min(2) })),
})
export const scenarioSchema = z.object({
  id:z.string().min(1), factIds:z.array(z.string()).min(1), questionIds:z.array(z.string()), title:z.string().min(1),
  testIntent:z.string().min(1), coverage:z.enum(['positive','negative','boundary','state_transition']),
})
export const scenarioPlanSchema = z.object({scenarios:z.array(scenarioSchema)})
export type FactModel = z.infer<typeof factModelSchema>
export type ScenarioDraft = z.infer<typeof scenarioSchema> & { requiresReview: boolean }
export const generatedCaseSchema = z.object({
  title: z.string().trim().min(1),
  contract: caseExecutionContractSchema,
  verification: z.enum(['browser', 'api', 'manual']),
  verificationReason: z.string().trim().min(1),
})
export const caseGenerationSchema = z.object({ cases: z.array(generatedCaseSchema).min(1) })
export const designIssueProposalSchema = z.object({
  targetType: z.enum(['design', 'fact', 'scenario', 'case']),
  targetId: z.string().min(1),
  kind: z.enum(['missing_evidence', 'contradiction', 'missing_coverage', 'invented_data', 'unverifiable', 'duplicate']),
  severity: z.enum(['blocking', 'warning']),
  reason: z.string().trim().min(1),
  evidence: z.array(evidenceRefSchema),
})
export const qualityReviewSchema = z.object({ issues: z.array(designIssueProposalSchema) })
export type DesignIssue = z.infer<typeof designIssueProposalSchema> & { id: string; checkedBy: 'rule' | 'model' | 'human' }
export const designReviewContentSchema = z.object({
  cases: z.record(z.string(), z.object({
    title: z.string().trim().min(1), contract: caseExecutionContractSchema,
    verification: z.enum(['browser', 'api', 'manual']), verificationReason: z.string().trim().min(1),
    status: z.enum(['draft', 'confirmed', 'excluded']), exclusionReason: z.string().trim().optional(),
  }).superRefine((item, context) => {
    if (item.status === 'excluded' && !item.exclusionReason) context.addIssue({ code: 'custom', path: ['exclusionReason'], message: '排除用例必须说明原因' })
  })),
  questionDecisions: z.record(z.string(), z.string().trim().min(1)),
  issueDecisions: z.record(z.string(), z.object({ status: z.enum(['addressed', 'dismissed']), reason: z.string().trim().min(1) })),
  excludedFacts: z.record(z.string(), z.string().trim().min(1)),
})
export const designReviewRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), runId: z.string().min(1), review: designReviewContentSchema })
export type DesignReviewContent = z.infer<typeof designReviewContentSchema>
export interface DesignReview {
  id: string
  designId: string
  runId: string
  revision: number
  inputRevision: number
  inputHash: string
  createdAt: string
  content: DesignReviewContent
}
export type CaseDesignDraft = z.infer<typeof generatedCaseSchema> & {
  id: string
  scenarioId: string
  factIds: string[]
  questionIds: string[]
  requiresReview: true
}
export interface DesignRun {
  id: string
  designId: string
  attempt: number
  stage: 'extracting' | 'modeling' | 'planning' | 'generating' | 'checking'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  inputRevision: number
  inputHash: string
  upstreamRunId?: string
  model: string
  modelConfigHash: string
  protocol: string
  promptVersion: string
  skills: Array<{ id: string; version: string; hash: string }>
  createdAt: string
  updatedAt: string
  error?: string
  output: FactExtraction & { processedBlockIds: string[]; unprocessedBlockIds: string[]; factModel?: FactModel; scenarios?: ScenarioDraft[]; uncoveredFactIds?: string[]; cases?: CaseDesignDraft[]; processedScenarioIds?: string[]; unprocessedScenarioIds?: string[]; issues?: DesignIssue[]; modelReviewCompleted?: boolean }
  statistics: { calls: number; inputCharacters: number; outputCharacters: number }
}
