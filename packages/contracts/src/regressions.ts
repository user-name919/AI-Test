import { z } from 'zod'
import { caseExecutionContractSchema } from './contracts'

const localRef = z.string().min(1).max(300).refine(value => !value.startsWith('-') && !/[\s\0]/.test(value), '请输入本地分支或提交 SHA')
export const changeComparisonSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('endpoints'), baseRef: localRef, targetRef: localRef }).strict(),
  z.object({ mode: z.literal('merge_base'), baseRef: localRef, targetRef: localRef }).strict(),
  z.object({ mode: z.literal('selected_commits'), targetRef: localRef, commits: z.array(localRef).min(1).max(50) }).strict(),
])
export type ChangeComparison = z.infer<typeof changeComparisonSchema>
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
