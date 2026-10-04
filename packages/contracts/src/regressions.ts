import { z } from 'zod'
import { caseExecutionContractSchema, type CaseExecutionContract, type ResolvedCaseExecutionContract } from './contracts'
import type { CaseAsset, CaseReuseProvenance } from './case-assets'

const localRef = z.string().min(1).max(300).refine(value => !value.startsWith('-') && !/[\s\0]/.test(value), '请输入本地分支或提交 SHA')
export const changeComparisonSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('endpoints'), baseRef: localRef, targetRef: localRef }).strict(),
  z.object({ mode: z.literal('merge_base'), baseRef: localRef, targetRef: localRef }).strict(),
  z.object({ mode: z.literal('selected_commits'), targetRef: localRef, commits: z.array(localRef).min(1).max(50) }).strict(),
])
export type ChangeComparison = z.infer<typeof changeComparisonSchema>
export interface LocalGitRefs { branches: Array<{ name: string; sha: string }>; truncated: boolean }
export const changeSetPreviewSchema = z.object({ projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), comparison: changeComparisonSchema }).strict()
export const freezeChangeSetSchema = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export interface ChangeSet {
  id: string
  projectId: string
  status: 'preview' | 'frozen'
  factsHash: string
  facts: LocalChangeFacts
  createdAt: string
  frozenAt?: string
}
export interface GitCommitFact { sha: string; parents: string[]; subject: string }
export interface GitFileChange { status: string; path: string; oldPath?: string }
export interface GitDiffFact { baseSha: string; targetSha: string; files: GitFileChange[]; patch: string }
export interface LocalChangeFacts {
  comparison: ChangeComparison
  targetSha: string
  requestedBaseSha?: string
  effectiveBaseSha?: string
  commits: GitCommitFact[]
  diffs: GitDiffFact[]
  omittedCommitShas: string[]
  omittedRangeBases: string[]
  dirty: boolean
  capturedAt: string
  warnings: string[]
}

export interface SourceImpact {
  method: 'static-import-candidates-v1'
  trees: Array<{
    sha: string
    changedFiles: string[]
    scannedFiles: string[]
    skippedFiles: Array<{ path: string; reason: string }>
    edges: Array<{ from: string; to: string; line: number; specifier: string }>
    affectedFiles: string[]
    unresolved: Array<{ path: string; line: number; expression: string; reason: string }>
  }>
  skippedShas: string[]
  warnings: string[]
}

export const regressionSuggestionSchema = z.object({
  risks: z.array(z.object({
    id: z.string().min(1).max(80), title: z.string().min(1).max(300),
    reason: z.string().min(1).max(4000), severity: z.enum(['high', 'medium', 'low']),
    confidence: z.enum(['high', 'medium', 'low']), evidenceIds: z.array(z.string()).min(1).max(30),
  }).strict()).max(30),
  cases: z.array(z.object({
    title: z.string().min(1).max(300), riskIds: z.array(z.string()).min(1).max(30),
    verification: z.enum(['browser', 'api', 'manual']), verificationReason: z.string().min(1).max(2000),
    contract: caseExecutionContractSchema,
  }).strict()).max(50),
  limitations: z.array(z.string().min(1).max(2000)).max(30),
}).strict()
export type RegressionSuggestions = z.infer<typeof regressionSuggestionSchema>
export interface RegressionReviewItems {
  risks: Array<{key:string;batchId:string;original:RegressionSuggestions['risks'][number]}>
  cases: Array<{key:string;batchId:string;riskKeys:string[];original:RegressionSuggestions['cases'][number]}>
}
export interface RegressionEvidence {
  id: string
  kind: 'patch_excerpt' | 'import_candidate'
  baseSha?: string
  targetSha: string
  paths: string[]
  text: string
  patchOffset?: number
  line?: number
}
export interface RegressionSuggestionBatch {
  id: string
  inputHash: string
  evidence: RegressionEvidence[]
  suggestions: RegressionSuggestions
}
export interface RegressionGeneration {
  promptVersion: string
  model: string
  reviewStatus: 'pending'
  batches: RegressionSuggestionBatch[]
  pendingEvidenceIds: string[]
  omittedEvidenceIds: string[]
  limitations: string[]
}
export const createRegressionSchema = z.object({ changeSetId: z.string().uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().uuid() }).strict()
export interface RegressionAnalysis {
  id: string
  changeSetId: string
  factsHash: string
  targetSha: string
  projectId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  stage: 'source' | 'generating' | 'finished'
  createdAt: string
  updatedAt: string
  sourceImpact?: SourceImpact
  generation?: RegressionGeneration
  error?: string
}
const riskDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ key: z.string().min(1), decision: z.literal('include'), reason: z.string().max(2000).default('') }).strict(),
  z.object({ key: z.string().min(1), decision: z.literal('exclude'), reason: z.string().trim().min(1).max(2000) }).strict(),
])
export const regressionReuseSchema = z.object({
  caseId:z.string().min(1).max(300), revision:z.number().int().positive(),
  contractFingerprint:z.string().regex(/^[a-f0-9]{64}$/), reason:z.string().trim().min(1).max(2000),
}).strict()
export type RegressionReuse = z.infer<typeof regressionReuseSchema>
export interface RegressionReuseCandidate {
  asset: CaseAsset
  projectMatch: 'same' | 'unknown' | 'other'
  reasons: string[]
  matchedTerms: string[]
}
export interface RegressionReuseSnapshot {
  key: string
  provenance: CaseReuseProvenance
  contract: CaseExecutionContract
  resolvedQuestions: ResolvedCaseExecutionContract['resolvedQuestions']
  questionAssociation: ResolvedCaseExecutionContract['questionAssociation']
}
const caseDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ key: z.string().min(1), decision: z.literal('include'), title: z.string().trim().min(1).max(300), finalContract: caseExecutionContractSchema,
    verification: z.enum(['browser', 'api', 'manual']), verificationReason: z.string().trim().min(1).max(2000), reuse:regressionReuseSchema.optional() }).strict(),
  z.object({ key: z.string().min(1), decision: z.literal('exclude'), reason: z.string().trim().min(1).max(2000) }).strict(),
])
export const regressionReviewContentSchema = z.object({
  status: z.enum(['draft', 'confirmed']), risks: z.array(riskDecisionSchema).max(1000), cases: z.array(caseDecisionSchema).max(1600),
  scopeNote: z.string().max(5000),
}).strict()
export const saveRegressionReviewSchema = z.object({ expectedRevision: z.number().int().nonnegative(), content: regressionReviewContentSchema }).strict()
export interface RegressionReview {
  regressionId: string
  revision: number
  createdAt: string
  analysisHash: string
  content: z.infer<typeof regressionReviewContentSchema>
  reusedSources?: RegressionReuseSnapshot[]
}
export const deploymentConfirmationSchema = z.object({
  reviewRevision: z.number().int().positive(), environmentId: z.string().uuid(),
  targetUrl: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  deployedSha: z.string().regex(/^[a-f0-9]{40,64}$/i).transform(value => value.toLowerCase()).optional(),
  confirmedBy: z.string().trim().min(1).max(100), note: z.string().trim().min(1).max(4000),
}).strict()
export interface DeploymentConfirmation extends z.infer<typeof deploymentConfirmationSchema> {
  id: string
  regressionId: string
  changeSetId: string
  projectId: string
  targetSha: string
  status: 'matched' | 'mismatched' | 'unverified'
  environmentBaseUrl: string
  environmentTargetUrl: string
  createdAt: string
}
export interface ManagedWorktreeStatus {
  changeSetId:string
  state:'not_created'|'preparing'|'ready'|'error'|'removed'
  sha?:string
  references:Array<{owner:string;createdAt:string}>
  canRemove:boolean
  canRecover?:boolean
  reason:string
}
