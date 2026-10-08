import { createHash } from 'node:crypto'
import type { CaseAsset } from '@quality-ai/contracts/cases'
import type { RegressionReview } from '@quality-ai/contracts/regressions'
import { database } from '../../storage/database'
import { getRegression } from '../regressions/jobs'
import { getRegressionReviews, regressionReviewItems } from '../regressions/review'
import { containsUnprovenDataLiteral } from './contract-resolver'

function assets(review: RegressionReview, deploymentVerified = false): CaseAsset[] {
  if (review.content.status !== 'confirmed') return []
  const analysis = getRegression(review.regressionId)
  if (!analysis) throw new Error('回归原始建议不存在，不能构造来源不明的资产')
  const originals = regressionReviewItems(analysis).cases
  return review.content.cases.flatMap((item, index) => {
    if (item.decision !== 'include') return []
    const original = originals.find(candidate => candidate.key === item.key)
    if (!original) throw new Error('回归审核缺少对应原始用例')
    const id = `regression:${review.regressionId}:${review.revision}:${index}`
    const contract = structuredClone(item.finalContract)
    const reuse=review.reusedSources?.find(source=>source.key===item.key)
    if(item.reuse&&!reuse)throw new Error('回归复用来源快照缺失，不能读取当前资产代替')
    const reason = item.verification !== 'browser' ? `该用例要求${item.verification === 'api' ? '接口' : '人工'}验证，不能由当前浏览器执行器替代`
      : contract.uncertainties.length ? '最终口径仍有未确定事项'
        : containsUnprovenDataLiteral(contract) ? '测试数据来源尚待确认'
          : deploymentVerified ? undefined : '回归执行需要部署版本确认；请从回归任务配置执行'
    const agent = reason ? { executable: false, reason } : { executable: true }
    const plan = agent
    const readiness = { agent, plan }
    const resolved = { caseKey: id, requirementIndex: -1, caseIndex: index, title: item.title, contract,
      questionAssociation: reuse?.questionAssociation??{ mode: 'explicit' as const, questionKeys: [] }, resolvedQuestions: reuse?.resolvedQuestions??[], readiness,
      contractFingerprint: createHash('sha256').update(JSON.stringify({ regressionId: review.regressionId, revision: review.revision, analysisHash: review.analysisHash, key: item.key, contract, verification: item.verification, ...(reuse?{reuse}:{}) })).digest('hex') }
    return [{ id, title: item.title, source: { type: 'change_regression' as const, regressionId: review.regressionId, suggestionId: item.key, reviewRevision: review.revision, changeSetId: analysis.changeSetId, ...(reuse?{reusedFrom:reuse.provenance}:{}) },
      revision: review.revision, reviewStatus: 'confirmed' as const, verification:item.verification, originalSuggestion: structuredClone(original.original.contract), finalContract: contract,
      resolved, createdAt: review.createdAt, updatedAt: review.createdAt }]
  })
}

export function listRegressionCaseAssets(regressionId?: string, revision?: number): CaseAsset[] {
  const rows = (regressionId ? database.prepare("SELECT record_json FROM regression_reviews WHERE regression_id=? ORDER BY revision DESC").all(regressionId)
    : database.prepare('SELECT record_json FROM regression_reviews ORDER BY revision DESC').all()) as Array<{ record_json: string }>
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const review = JSON.parse(row.record_json) as RegressionReview
    if (review.content.status !== 'confirmed' || seen.has(review.regressionId) || (revision !== undefined && review.revision !== revision)) return []
    seen.add(review.regressionId)
    return assets(review)
  })
}

export function getRegressionCaseAsset(id: string, deploymentVerified = false): CaseAsset | null {
  const match = id.match(/^regression:([a-f0-9-]{36}):([1-9]\d*):(\d+)$/i)
  if (!match) return null
  const review = getRegressionReviews(match[1]!).find(item => item.revision === Number(match[2]))
  return review ? assets(review, deploymentVerified).find(item => item.id === id) ?? null : null
}
