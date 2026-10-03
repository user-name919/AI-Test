import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { randomUUID } from 'node:crypto'
import { getAnalysisById } from '../requirements/repository'
import { saveAutomationPlan } from '../cases/plan-repository'
import { resolveCaseExecutionContract } from '../../review-execution-context'
import { generateCasePlans } from './plan-generation'
import { caseAssetReviewRequestSchema } from '@quality-ai/contracts/cases'
import { getCaseAsset, listCaseAssetRevisions, listCaseAssets, saveCaseAssetReview } from './repository'


export async function handleCaseRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method === 'GET' && url.pathname === '/api/cases') {
    const sourceType = url.searchParams.get('sourceType')
    if (sourceType && sourceType !== 'requirement') return json(response, 400, { error: '当前资产入口仅支持 requirement，其他来源将在对应模块接入' })
    return json(response, 200, { cases: listCaseAssets(url.searchParams.get('sourceId') ?? undefined) })
  }
  const assetMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/(contract|review|history)$/)
  if (assetMatch) {
    const id = decodeURIComponent(assetMatch[1])
    if (request.method === 'GET' && assetMatch[2] === 'contract') {
      const asset = getCaseAsset(id)
      return asset ? json(response, 200, { asset, caseContract: asset.resolved }) : json(response, 404, { error: '用例资产不存在' })
    }
    if (request.method === 'GET' && assetMatch[2] === 'history') {
      const revisions = listCaseAssetRevisions(id)
      return revisions ? json(response, 200, { revisions }) : json(response, 404, { error: '用例资产不存在' })
    }
    if (request.method === 'PATCH' && assetMatch[2] === 'review') {
      const parsed = caseAssetReviewRequestSchema.safeParse(await readJson(request))
      if (!parsed.success) return json(response, 400, { error: '审核内容或预期版本不合法', issues: parsed.error.issues })
      const result = saveCaseAssetReview(id, parsed.data.expectedRevision, parsed.data.review)
      if (result.kind === 'missing') return json(response, 404, { error: '用例资产不存在' })
      if (result.kind === 'conflict') return json(response, 409, { error: '用例已被修改，请保留草稿并对比最新版本', asset: result.asset })
      return json(response, 200, { asset: result.asset })
    }
  }
  const caseContractsMatch = request.url?.match(/^\/api\/analyses\/([^/]+)\/case-contracts$/)
  if (request.method === 'GET' && caseContractsMatch) {
    const analysis = getAnalysisById(decodeURIComponent(caseContractsMatch[1]))
    if (!analysis) return json(response, 404, { error: '分析记录不存在' })
    return json(response, 200, {
      caseContracts: analysis.result.requirements.flatMap((requirement, requirementIndex) =>
        requirement.testCases.map((_, caseIndex) => resolveCaseExecutionContract(analysis, `${requirementIndex}-TC-${caseIndex}`))),
    })
  }
  const caseContractMatch = request.url?.match(/^\/api\/analyses\/([^/]+)\/cases\/([^/]+)\/contract$/)
  if (request.method === 'GET' && caseContractMatch) {
    const analysis = getAnalysisById(decodeURIComponent(caseContractMatch[1]))
    if (!analysis) return json(response, 404, { error: '解析记录不存在' })
    try {
      return json(response, 200, {
        caseContract: resolveCaseExecutionContract(analysis, decodeURIComponent(caseContractMatch[2])),
      })
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : '测试用例不存在' })
    }
  }

  if (request.method === 'POST' && request.url === '/api/automation/generate') {
    const body = await readJson(request)
    const analysisId = typeof body.analysisId === 'string' ? body.analysisId : ''
    const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl : ''
    const caseKeys = Array.isArray(body.caseKeys) && body.caseKeys.every(key => typeof key === 'string') ? body.caseKeys : []
    const analysis = getAnalysisById(analysisId)
    if (!analysis) return json(response, 404, { error: '解析记录不存在' })
    if (!targetUrl || !caseKeys.length) return json(response, 400, { error: '请选择用例并配置测试地址' })
    try {
      const plan = await generateCasePlans(analysis, caseKeys, targetUrl)
      const savedPlan = { id: randomUUID(), analysisId, caseKeys, plan, createdAt: new Date().toISOString() }
      saveAutomationPlan(savedPlan)
      return json(response, 201, { automationPlan: savedPlan })
    } catch (error) {
      return json(response, 409, { error: error instanceof Error ? error.message : '测试用例仍未满足执行前置条件' })
    }
  }

  return false
}
