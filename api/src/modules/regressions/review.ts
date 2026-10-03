import { createHash } from 'node:crypto'
import { saveRegressionReviewSchema, type RegressionAnalysis, type RegressionReview } from '@quality-ai/contracts/regressions'
import { database } from '../../storage/database'
import { getRegression } from './jobs'

export function initializeRegressionReviews() {
  database.exec('CREATE TABLE IF NOT EXISTS regression_reviews (regression_id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(regression_id,revision))')
}
export function regressionReviewItems(analysis: RegressionAnalysis) {
  const batches = analysis.generation?.batches ?? []
  return {
    risks: batches.flatMap(batch => batch.suggestions.risks.map(risk => ({ key: `${batch.id}:${risk.id}`, batchId: batch.id, original: risk }))),
    cases: batches.flatMap(batch => batch.suggestions.cases.map((item, index) => ({ key: `${batch.id}:case-${index}`, batchId: batch.id, riskKeys: item.riskIds.map(id => `${batch.id}:${id}`), original: item }))),
  }
}
export function getRegressionReviews(regressionId: string): RegressionReview[] {
  return (database.prepare('SELECT record_json FROM regression_reviews WHERE regression_id=? ORDER BY revision DESC').all(regressionId) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json))
}
export function saveRegressionReview(regressionId: string, input: unknown): RegressionReview {
  const request = saveRegressionReviewSchema.parse(input)
  const analysis = getRegression(regressionId)
  if (!analysis || ['queued', 'running'].includes(analysis.status)) throw new Error('分析尚未结束或不存在，不能冻结人工范围')
  if (!analysis.generation) throw new Error('没有可审核的建议产物')
  const latest = getRegressionReviews(regressionId)[0]
  if ((latest?.revision ?? 0) !== request.expectedRevision) throw new Error('审核版本冲突，请保留当前草稿并加载最新版本比较')
  const items = regressionReviewItems(analysis)
  const risks = new Map(items.risks.map(item => [item.key, item]))
  const cases = new Map(items.cases.map(item => [item.key, item]))
  const selectedRisks = new Map(request.content.risks.map(item => [item.key, item]))
  const selectedCases = new Map(request.content.cases.map(item => [item.key, item]))
  if (selectedRisks.size !== request.content.risks.length || selectedCases.size !== request.content.cases.length) throw new Error('审核项重复')
  if ([...selectedRisks.keys()].some(key => !risks.has(key)) || [...selectedCases.keys()].some(key => !cases.has(key))) throw new Error('审核包含不属于本次分析的风险或用例')
  if (request.content.status === 'confirmed') {
    if (selectedRisks.size !== risks.size || selectedCases.size !== cases.size) throw new Error('确认前必须逐项决定所有风险和用例，未选择不等于排除')
    if (!request.content.scopeNote.trim()) throw new Error('请说明本次人工回归范围与已知分析限制')
    for (const [key, decision] of selectedCases) {
      if (decision.decision === 'include' && !cases.get(key)!.riskKeys.some(riskKey => selectedRisks.get(riskKey)?.decision === 'include')) throw new Error('纳入的用例至少关联一个纳入的风险，不能与范围决定冲突')
    }
    for (const [key, decision] of selectedRisks) {
      if (decision.decision === 'include' && !items.cases.some(item => item.riskKeys.includes(key) && selectedCases.get(item.key)?.decision === 'include') && !decision.reason.trim()) throw new Error('纳入风险没有对应回归用例，请在理由中说明验证安排或未覆盖原因')
    }
  }
  const record: RegressionReview = { regressionId, revision: request.expectedRevision + 1, createdAt: new Date().toISOString(),
    analysisHash: createHash('sha256').update(JSON.stringify({ factsHash: analysis.factsHash, generation: analysis.generation })).digest('hex'), content: request.content }
  database.prepare('INSERT INTO regression_reviews (regression_id,revision,record_json) VALUES (?,?,?)').run(regressionId, record.revision, JSON.stringify(record))
  return record
}
