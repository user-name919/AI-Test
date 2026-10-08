import { z } from 'zod'
import { caseReviewSchema, type CaseExecutionContract, type CaseReview, type ResolvedCaseExecutionContract, type SourceProjectSnapshot } from './contracts'

export type CaseSource =
  | { type: 'requirement'; analysisId: string; caseKey: string }
  | { type: 'change_regression'; regressionId: string; suggestionId: string; reviewRevision?: number; changeSetId?: string; reusedFrom?: CaseReuseProvenance }
  | { type: 'case_design'; designId: string; draftId: string; publicationId: string; publicationVersion: number }

export interface CaseAsset {
  id: string
  title: string
  source: CaseSource
  revision: number
  reviewStatus: CaseReview['status'] | 'legacy_unreviewed'
  verification?: 'browser' | 'api' | 'manual'
  originalSuggestion: CaseExecutionContract
  finalContract: CaseExecutionContract
  resolved: ResolvedCaseExecutionContract
  createdAt: string
  updatedAt: string
}

export interface CaseReuseProvenance {
  caseId: string
  revision: number
  contractFingerprint: string
  title: string
  sourceType: CaseSource['type']
  sourceId: string
  reason: string
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

export const executionPreparationSchema = z.object({
  environmentId: z.string().uuid().optional(),
  deploymentConfirmationId: z.string().uuid().optional(),
  mode: z.enum(['agent', 'plan']),
  targetUrl: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), '测试地址必须使用 HTTP(S)'),
  cases: z.array(z.object({
    caseId: z.string().min(1),
    revision: z.number().int().positive(),
    contractFingerprint: z.string().min(1),
  }).strict()).min(1).max(20),
}).strict()

export const executionJobRequestSchema = executionPreparationSchema.extend({
  authorizedWriteCaseIds: z.array(z.string().min(1)).max(20).optional(),
  automationPlanId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  projectId: z.string().min(1).optional(),
})

export interface ExecutionJob {
  writeAuthorizations?: import('./contracts').ExecutionWriteAuthorization[]
  memoryHints?: import('./memories').MemoryReference[]
  rerunOf?: string
  automationPlanId?: string
  deploymentConfirmation?: import('./regressions').DeploymentConfirmation
  id: string
  status: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  mode: 'agent' | 'plan'
  targetUrl: string
  snapshots: import('./contracts').ExecutionCaseSnapshot[]
  createdAt: string
  updatedAt: string
  error?: string
  executionId?: string
  environmentId?: string
  projectId?: string
  sourceProject?: SourceProjectSnapshot
  completedCases?: import('./contracts').CaseExecutionResult[]
  activeCase?: {caseKey:string;startedFromUrl:string}
  executionPlan?: import('./contracts').AutomationPlan
}

export interface ExecutionArtifact {
  id:string
  name:string
  kind:'screenshot'|'trace'|'download'
  caseKey?:string
  url:string
  available:boolean
}
