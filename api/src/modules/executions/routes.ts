import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { basename, resolve } from 'node:path'
import { createReadStream, existsSync } from 'node:fs'
import { agentRunRequestSchema, automationPlanSchema, type LiveExecutionEvent } from '@quality-ai/contracts'
import { getAnalysisById, getAutomationPlanById, getEnvironmentById, getExecutionById, getLatestAutomationPlan, getLatestExecution, listExecutions, saveExecution } from '../../database'
import { runAutomationPlan } from '../../playwright-runner'
import { runAgentTest } from '../../agent-test-runner'
import { buildAgentTestGoal } from '../../agent-goal'
import { getProjectProviderRegistry } from '../../project-knowledge/registry'
import { inspectTargetPage } from '../../page-observer-runner'
import { openNdjsonResponse } from '../../ndjson-response'
import { resolveCaseExecutionContract } from '../../review-execution-context'
import { getRuntimePaths } from '../../config/paths'


export async function handleExecutionRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.method === 'GET' && request.url === '/api/executions/latest') {
    return json(response, 200, { execution: getLatestExecution() })
  }

  if (request.method === 'GET' && request.url === '/api/executions') {
    return json(response, 200, { executions: listExecutions() })
  }

  const executionMatch = request.url?.match(/^\/api\/executions\/([a-f0-9-]+)$/i)
  if (request.method === 'GET' && executionMatch) {
    const execution = getExecutionById(executionMatch[1])
    return execution ? json(response, 200, { execution }) : json(response, 404, { error: '执行记录不存在' })
  }

  const rerunMatch = request.url?.match(/^\/api\/executions\/([a-f0-9-]+)\/rerun$/i)
  if (request.method === 'POST' && rerunMatch) {
    const original = getExecutionById(rerunMatch[1])
    if (!original) return json(response, 404, { error: '执行记录不存在' })
    if (!original.plan) return json(response, 409, { error: '历史记录未保存自动化计划，无法直接重跑' })
    const environment = original.environmentId ? getEnvironmentById(original.environmentId) : null
    if (original.environmentId && !environment) return json(response, 409, { error: '原测试环境已不存在，无法安全重跑' })
    const result = await runAutomationPlan(original.plan, environment?.storageStatePath)
    saveExecution(result, {
      analysisId: original.analysisId, automationPlanId: original.automationPlanId,
      environmentId: original.environmentId, caseKeys: original.caseKeys, plan: original.plan, rerunOf: original.id,
    })
    const execution = getExecutionById(result.id)
    return json(response, result.status === 'passed' ? 201 : 422, { execution })
  }

  const artifactMatch = request.url?.match(/^\/api\/artifacts\/([a-f0-9-]+)\/([^/?]+)$/i)
  if (request.method === 'GET' && artifactMatch) {
    const executionId = artifactMatch[1]
    const fileName = basename(decodeURIComponent(artifactMatch[2]))
    if (!/^(trace\.zip|failure\.png|[\w\u4e00-\u9fa5-]+\.png)$/.test(fileName)) return json(response, 400, { error: '证据文件名不合法' })
    const filePath = resolve(getRuntimePaths().artifactRoot, executionId, fileName)
    if (!existsSync(filePath)) return json(response, 404, { error: '证据文件不存在' })
    response.writeHead(200, {
      'content-type': fileName.endsWith('.zip') ? 'application/zip' : 'image/png',
      'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
    })
    createReadStream(filePath).pipe(response)
    return true
  }

  if (request.method === 'GET' && request.url === '/api/automation/plans/latest') {
    return json(response, 200, { automationPlan: getLatestAutomationPlan() })
  }

  if (request.method === 'POST' && request.url === '/api/automation/observe') {
    const body = await readJson(request)
    const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl.trim() : ''
    const environmentId = typeof body.environmentId === 'string' ? body.environmentId : undefined
    if (!targetUrl) return json(response, 400, { error: '观察页面地址不能为空' })
    const environment = environmentId ? getEnvironmentById(environmentId) : null
    if (environmentId && !environment) return json(response, 404, { error: '测试环境不存在' })
    const target = new URL(targetUrl)
    if (environment && target.origin !== new URL(environment.baseUrl).origin) {
      return json(response, 400, { error: '观察页面与测试环境 Origin 不一致' })
    }
    const snapshot = await inspectTargetPage(target.href, environment?.storageStatePath)
    return json(response, 200, { snapshot })
  }

  const streamPlanExecution = request.url === '/api/automation/run/stream'
  if (request.method === 'POST' && (request.url === '/api/automation/run' || streamPlanExecution)) {
    const body = await readJson(request)
    const environmentId = typeof body.environmentId === 'string' ? body.environmentId : undefined
    const automationPlanId = typeof body.automationPlanId === 'string' ? body.automationPlanId : undefined
    const environment = environmentId ? getEnvironmentById(environmentId) : null
    if (environmentId && !environment) return json(response, 404, { error: '测试环境不存在' })
    const savedPlan = automationPlanId ? getAutomationPlanById(automationPlanId) : null
    if (automationPlanId && !savedPlan) return json(response, 404, { error: '自动化计划不存在' })
    const wrappedPlan = automationPlanSchema.parse(savedPlan?.plan ?? body.plan ?? body)
    const planAnalysis = savedPlan ? getAnalysisById(savedPlan.analysisId) : null
    if (savedPlan && planAnalysis) {
      try {
        for (const caseKey of savedPlan.caseKeys) {
          const resolved = resolveCaseExecutionContract(planAnalysis, caseKey)
          if (!resolved.readiness.plan.executable) throw new Error(resolved.readiness.plan.reason ?? `用例不能执行固定计划：${caseKey}`)
        }
      } catch (error) {
        return json(response, 409, { error: error instanceof Error ? error.message : '自动化计划仍未满足执行前置条件' })
      }
    }
    const stream = streamPlanExecution ? openNdjsonResponse(response) : null
    try {
      const result = await runAutomationPlan(wrappedPlan, environment?.storageStatePath, {
        onEvent: stream ? (event: LiveExecutionEvent) => stream.send(event) : undefined,
      })
      saveExecution(result, {
        analysisId: savedPlan?.analysisId,
        automationPlanId: savedPlan?.id,
        environmentId,
        caseKeys: savedPlan?.caseKeys,
        plan: wrappedPlan,
      })
      const execution = getExecutionById(result.id)
      if (stream) {
        if (execution) stream.send({ type: 'execution_completed', execution } satisfies LiveExecutionEvent)
        else stream.send({ type: 'execution_error', executionId: result.id, error: '执行结果保存失败' } satisfies LiveExecutionEvent)
        stream.close()
        return true
      }
      return json(response, result.status === 'passed' ? 201 : 422, { execution })
    } catch (error) {
      if (!stream) throw error
      stream.send({ type: 'execution_error', error: error instanceof Error ? error.message : String(error) } satisfies LiveExecutionEvent)
      stream.close()
      return true
    }
  }

  const streamAgentExecution = request.url === '/api/automation/agent/run/stream'
  if (request.method === 'POST' && (request.url === '/api/automation/agent/run' || streamAgentExecution)) {
    const parsed = agentRunRequestSchema.safeParse(await readJson(request))
    if (!parsed.success) return json(response, 400, { error: 'Agent 执行参数不合法', issues: parsed.error.issues })
    const input = parsed.data
    const analysis = getAnalysisById(input.analysisId)
    if (!analysis) return json(response, 404, { error: '解析记录不存在' })
    const environment = input.environmentId ? getEnvironmentById(input.environmentId) : null
    if (input.environmentId && !environment) return json(response, 404, { error: '测试环境不存在' })
    const target = new URL(input.targetUrl)
    if (!['http:', 'https:'].includes(target.protocol)) return json(response, 400, { error: '测试地址只允许 HTTP 或 HTTPS' })
    if (environment && target.origin !== new URL(environment.baseUrl).origin) {
      return json(response, 400, { error: '测试页面与测试环境 Origin 不一致' })
    }
    const projectProvider = (await getProjectProviderRegistry()).get(input.projectId)
    if (!projectProvider) return json(response, 404, { error: `项目配置不存在：${input.projectId}` })
    const project = await projectProvider.getProjectInfo()
    if (!project.connected) return json(response, 422, { error: `项目源码未连接：${project.error ?? input.projectId}` })
    if (project.targetOrigins.length && !project.targetOrigins.includes(target.origin)) {
      return json(response, 400, { error: `测试页面 Origin 未配置到项目：${target.origin}` })
    }
    let goals
    try {
      goals = input.caseKeys.map(caseKey => buildAgentTestGoal(analysis, caseKey, target.href))
    } catch (error) {
      return json(response, 409, { error: error instanceof Error ? error.message : '测试目标构造失败' })
    }
    const stream = streamAgentExecution ? openNdjsonResponse(response) : null
    try {
      const result = await runAgentTest(goals, environment?.storageStatePath, {
        projectProvider,
        onEvent: stream ? (event: LiveExecutionEvent) => stream.send(event) : undefined,
      })
      result.sourceProject = { id: project.id, branch: project.branch, commit: project.commit }
      saveExecution(result, {
        analysisId: input.analysisId,
        environmentId: input.environmentId,
        projectId: input.projectId,
        caseKeys: input.caseKeys,
      })
      const execution = getExecutionById(result.id)
      if (stream) {
        if (execution) stream.send({ type: 'execution_completed', execution } satisfies LiveExecutionEvent)
        else stream.send({ type: 'execution_error', executionId: result.id, error: '执行结果保存失败' } satisfies LiveExecutionEvent)
        stream.close()
        return true
      }
      return json(response, result.status === 'passed' ? 201 : 422, { execution })
    } catch (error) {
      if (!stream) throw error
      stream.send({ type: 'execution_error', error: error instanceof Error ? error.message : String(error) } satisfies LiveExecutionEvent)
      stream.close()
      return true
    }
  }

  return false
}
