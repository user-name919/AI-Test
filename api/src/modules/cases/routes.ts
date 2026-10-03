import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { randomUUID } from 'node:crypto'
import { getAnalysisById } from '../requirements/repository'
import { saveAutomationPlan } from '../cases/plan-repository'
import { resolveCaseExecutionContract } from '../../review-execution-context'
import { generateCasePlans } from './plan-generation'


export async function handleCaseRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
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
