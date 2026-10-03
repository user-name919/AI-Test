import { z } from 'zod'

const localRef = z.string().min(1).max(300).refine(value => !value.startsWith('-') && !/[\s\0]/.test(value), '请输入本地分支或提交 SHA')
export const changeComparisonSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('endpoints'), baseRef: localRef, targetRef: localRef }).strict(),
  z.object({ mode: z.literal('merge_base'), baseRef: localRef, targetRef: localRef }).strict(),
  z.object({ mode: z.literal('selected_commits'), targetRef: localRef, commits: z.array(localRef).min(1).max(50) }).strict(),
])
export type ChangeComparison = z.infer<typeof changeComparisonSchema>
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
