import { randomUUID } from 'node:crypto'
import { designReviewContentSchema, type DesignReview, type DesignReviewContent } from '@quality-ai/contracts/case-design'
import { database } from '../../storage/database'
import { getCaseDesign, listDesignRuns } from './repository'

export function listDesignReviews(designId: string): DesignReview[] {
  const rows = database.prepare('SELECT review_json FROM case_design_reviews WHERE design_id=? ORDER BY revision DESC').all(designId) as Array<{ review_json: string }>
  return rows.map(row => JSON.parse(row.review_json))
}

export function saveDesignReview(designId: string, runId: string, expectedRevision: number, content: DesignReviewContent):
  | { kind: 'saved'; review: DesignReview }
  | { kind: 'conflict'; review: DesignReview | null }
  | { kind: 'invalid'; error: string } {
  const parsed = designReviewContentSchema.safeParse(content)
  if (!parsed.success) return { kind: 'invalid', error: '人工审核内容不完整，排除或问题处理必须提供理由' }
  const design = getCaseDesign(designId)
  const run = listDesignRuns(designId).find(item => item.id === runId)
  if (!design || !run || run.stage !== 'checking' || run.status !== 'completed' || !run.output.modelReviewCompleted || run.inputHash !== design.inputHash || run.inputRevision !== design.revision) return { kind: 'invalid', error: '请基于当前材料已完成的质量审查保存审核；旧材料或未完成产物不可确认' }
  const caseIds = new Set(run.output.cases?.map(item => item.id))
  const questionIds = new Set([...run.output.questions, ...run.output.factModel?.conflicts ?? []].map(item => item.id))
  const issueIds = new Set(run.output.issues?.map(item => item.id))
  const factIds = new Set(run.output.factModel?.consolidatedFacts.map(item => item.id))
  for (const [values, allowed] of [[parsed.data.cases, caseIds], [parsed.data.questionDecisions, questionIds], [parsed.data.issueDecisions, issueIds], [parsed.data.excludedFacts, factIds]] as const) {
    if (Object.keys(values).some(id => !allowed.has(id))) return { kind: 'invalid', error: '审核引用了不属于本次产物的用例、问题、审查项或事实' }
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    const current = listDesignReviews(designId)[0] ?? null
    if ((current?.revision ?? 0) !== expectedRevision) {
      database.exec('ROLLBACK')
      return { kind: 'conflict', review: current }
    }
    const review: DesignReview = { id: randomUUID(), designId, runId, revision: expectedRevision + 1, inputRevision: design.revision, inputHash: design.inputHash, createdAt: new Date().toISOString(), content: parsed.data }
    database.prepare('INSERT INTO case_design_reviews (id,design_id,revision,review_json) VALUES (?,?,?,?)').run(review.id, designId, review.revision, JSON.stringify(review))
    database.exec('COMMIT')
    return { kind: 'saved', review }
  } catch (error) { database.exec('ROLLBACK'); throw error }
}
