import type { ExecutionCaseSnapshot } from '@quality-ai/contracts'
import { executionPreparationSchema } from '@quality-ai/contracts/cases'
import { buildAgentGoalFromContract } from '../../automation/agent-goal'
import { getCaseAsset } from './repository'
import { getPublishedCaseAsset } from './published-assets'
import { getRegressionCaseAsset } from './regression-assets'
import { validateDeploymentForExecution } from '../regressions/deployments'
import type { DeploymentConfirmation } from '@quality-ai/contracts/regressions'

// 只信任服务端资产。准备接口不启动浏览器；真正创建任务时仍须重新执行本检查。
export function prepareAssetExecution(input: unknown) {
  const request = executionPreparationSchema.parse(input)
  if (new Set(request.cases.map(item => item.caseId)).size !== request.cases.length) throw new Error('执行用例不能重复')
  const capturedAt = new Date().toISOString()
  let deploymentConfirmation: DeploymentConfirmation | undefined
  const regressionCount = request.cases.filter(item => item.caseId.startsWith('regression:')).length
  if (regressionCount && regressionCount !== request.cases.length) throw new Error('回归用例不能与其他来源混合执行')
  if (!regressionCount && request.deploymentConfirmationId) throw new Error('非回归用例不接受部署确认')
  const snapshots: ExecutionCaseSnapshot[] = request.cases.map(expected => {
    let asset = expected.caseId.startsWith('regression:') ? getRegressionCaseAsset(expected.caseId) : expected.caseId.startsWith('published:') ? getPublishedCaseAsset(expected.caseId) : getCaseAsset(expected.caseId)
    if (!asset) throw new Error(`用例资产不存在：${expected.caseId}`)
    if (asset.source.type === 'change_regression') {
      if (!request.deploymentConfirmationId || !request.environmentId || !asset.source.reviewRevision) throw new Error('回归执行需要部署版本确认与测试环境')
      deploymentConfirmation = validateDeploymentForExecution(request.deploymentConfirmationId, { regressionId: asset.source.regressionId, reviewRevision: asset.source.reviewRevision, environmentId: request.environmentId, targetUrl: request.targetUrl })
      asset = getRegressionCaseAsset(asset.id, true)!
    }
    if (asset.revision !== expected.revision || asset.resolved.contractFingerprint !== expected.contractFingerprint) {
      throw new Error(`用例版本或口径已变化，请刷新预览：${asset.title}`)
    }
    if (!asset.resolved.readiness[request.mode].executable) throw new Error(asset.resolved.readiness[request.mode].reason ?? '用例尚未就绪')
    return { caseId: asset.id, revision: asset.revision, source: asset.source,
      ...(asset.source.type === 'requirement' ? { analysisId: asset.source.analysisId } : {}),
      capturedAt, resolved: structuredClone(asset.resolved) }
  })
  return { mode: request.mode, targetUrl: request.targetUrl, snapshots, deploymentConfirmation,
    goals: request.mode === 'agent' ? snapshots.map(snapshot => buildAgentGoalFromContract(snapshot.resolved, request.targetUrl)) : [] }
}
