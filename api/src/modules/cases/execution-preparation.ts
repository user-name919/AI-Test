import type { ExecutionCaseSnapshot } from '@quality-ai/contracts'
import { executionPreparationSchema } from '@quality-ai/contracts/cases'
import { buildAgentGoalFromContract } from '../../agent-goal'
import { getCaseAsset } from './repository'
import { getPublishedCaseAsset } from './published-assets'

// 只信任服务端资产。准备接口不启动浏览器；真正创建任务时仍须重新执行本检查。
export function prepareAssetExecution(input: unknown) {
  const request = executionPreparationSchema.parse(input)
  if (new Set(request.cases.map(item => item.caseId)).size !== request.cases.length) throw new Error('执行用例不能重复')
  const capturedAt = new Date().toISOString()
  const snapshots: ExecutionCaseSnapshot[] = request.cases.map(expected => {
    const asset = expected.caseId.startsWith('published:') ? getPublishedCaseAsset(expected.caseId) : getCaseAsset(expected.caseId)
    if (!asset) throw new Error(`用例资产不存在：${expected.caseId}`)
    if (asset.revision !== expected.revision || asset.resolved.contractFingerprint !== expected.contractFingerprint) {
      throw new Error(`用例版本或口径已变化，请刷新预览：${asset.title}`)
    }
    if (!asset.resolved.readiness[request.mode].executable) throw new Error(asset.resolved.readiness[request.mode].reason ?? '用例尚未就绪')
    return { caseId: asset.id, revision: asset.revision, source: asset.source,
      ...(asset.source.type === 'requirement' ? { analysisId: asset.source.analysisId } : {}),
      capturedAt, resolved: structuredClone(asset.resolved) }
  })
  return { mode: request.mode, targetUrl: request.targetUrl, snapshots,
    goals: request.mode === 'agent' ? snapshots.map(snapshot => buildAgentGoalFromContract(snapshot.resolved, request.targetUrl)) : [] }
}
