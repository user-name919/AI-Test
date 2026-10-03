import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzePrd } from './model'
import { getAnalysisById, getAutomationPlanById, getEnvironmentById, getExecutionById, getLatestAnalysis, getLatestAutomationPlan, getLatestEnvironment, getLatestExecution, listAnalyses, listExecutions, saveAnalysis, saveAutomationPlan, saveEnvironment, saveExecution, saveReview, setEnvironmentStorageState } from './database'
import { runAutomationPlan } from './playwright-runner'
import { generateAutomationPlan } from './model'
import { agentRunRequestSchema, automationPlanSchema, reviewStateSchema, storageStateSchema, type AutomationPlan, type LiveExecutionEvent, type SavedAnalysis } from '../shared/contracts'
import { getProjectProvider, getProjectProviderRegistry } from './project-knowledge/registry'
import type { SourceScope } from './project-knowledge/types'
import { inspectTargetPage } from './page-observer-runner'
import { buildAgentTestGoal } from './agent-goal'
import { runAgentTest } from './agent-test-runner'
import { parseSourceDocuments } from './source-documents'
import { openNdjsonResponse } from './ndjson-response'
import { collectReviewSourceContext, generateReviewExecutionContract } from './review-contract'
import { resolveCaseExecutionContract } from './review-execution-context'

const port = Number(process.env.API_PORT ?? 8787)
const maxBodySize = 30 * 1024 * 1024
const sourceScopes = new Set<SourceScope>(['route', 'page', 'component', 'api'])

async function generateCasePlans(analysis: SavedAnalysis, caseKeys: string[], targetUrl: string): Promise<AutomationPlan> {
  const cases = caseKeys.map(caseKey => resolveCaseExecutionContract(analysis, caseKey))
  for (const item of cases) {
    if (!item.readiness.plan.executable) throw new Error(item.readiness.plan.reason ?? `用例不能生成固定计划：${item.caseKey}`)
  }
  const casePlans = await Promise.all(cases.map(async item => {
    const generated = await generateAutomationPlan(targetUrl, item)
    return {
      caseKey: item.caseKey,
      title: item.title,
      contractFingerprint: item.contractFingerprint,
      contract: item.contract,
      steps: generated.steps,
    }
  }))
  return automationPlanSchema.parse({
    name: `${analysis.result.versionName} · ${casePlans.length} 条用例`,
    targetUrl,
    steps: casePlans[0]!.steps,
    casePlans,
  })
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBodySize) throw new Error('单次请求不能超过 30MB')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export function createApiServer() {
  return createServer(async (request, response) => {
    try {
    if (request.method === 'GET' && request.url === '/api/health') {
      return json(response, 200, {
        ok: true,
        provider: 'company-responses',
        model: process.env.MODEL_NAME ?? 'gpt-5.6-terra',
        configured: Boolean(process.env.MODEL_API_KEY ?? process.env.DEEPSEEK_API_KEY),
      })
    }

    if (request.method === 'GET' && request.url === '/api/projects') {
      const providers = [...(await getProjectProviderRegistry()).values()]
      return json(response, 200, { projects: await Promise.all(providers.map(provider => provider.getProjectInfo())) })
    }

    const validateProjectMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/validate$/)
    if (request.method === 'POST' && validateProjectMatch) {
      const project = await (await getProjectProvider(validateProjectMatch[1])).getProjectInfo()
      return json(response, project.connected ? 200 : 422, { project })
    }

    const resolveRouteMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/resolve-route$/)
    if (request.method === 'POST' && resolveRouteMatch) {
      const body = await readJson(request)
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!url) return json(response, 400, { error: '页面 URL 不能为空' })
      const route = await (await getProjectProvider(resolveRouteMatch[1])).resolveRoute({ url })
      return json(response, 200, { route })
    }

    const searchSourceMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/search-source$/)
    if (request.method === 'POST' && searchSourceMatch) {
      const body = await readJson(request)
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      const invalidScope = Array.isArray(body.scopes)
        && body.scopes.some(scope => typeof scope !== 'string' || !sourceScopes.has(scope as SourceScope))
      if (invalidScope) return json(response, 400, { error: '源码搜索范围不合法' })
      const scopes = Array.isArray(body.scopes)
        ? body.scopes.filter((scope): scope is SourceScope => typeof scope === 'string' && sourceScopes.has(scope as SourceScope))
        : undefined
      const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : undefined
      if (!query) return json(response, 400, { error: '源码搜索词不能为空' })
      const matches = await (await getProjectProvider(searchSourceMatch[1])).searchSource({ query, scopes, limit })
      return json(response, 200, { matches })
    }

    const inspectSourceMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/inspect-source$/)
    if (request.method === 'POST' && inspectSourceMatch) {
      const body = await readJson(request)
      const paths = Array.isArray(body.paths) && body.paths.every(path => typeof path === 'string') ? body.paths : []
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (!paths.length || !reason) return json(response, 400, { error: '源码文件和读取原因不能为空' })
      const context = await (await getProjectProvider(inspectSourceMatch[1])).inspectFiles({ paths, reason })
      return json(response, 200, { context })
    }

    if (request.method === 'GET' && request.url === '/api/analyses/latest') {
      return json(response, 200, { analysis: getLatestAnalysis() })
    }

    if (request.method === 'GET' && request.url === '/api/analyses') {
      return json(response, 200, { analyses: listAnalyses() })
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

    const analysisMatch = request.url?.match(/^\/api\/analyses\/([a-f0-9-]+)$/i)
    if (request.method === 'GET' && analysisMatch) {
      const analysis = getAnalysisById(analysisMatch[1])
      return analysis ? json(response, 200, { analysis }) : json(response, 404, { error: '版本不存在' })
    }

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

    if (request.method === 'GET' && request.url === '/api/environments/latest') return json(response, 200, { environment: getLatestEnvironment() })

    if (request.method === 'POST' && request.url === '/api/environments') {
      const body = await readJson(request)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const targetUrl = typeof body.targetUrl === 'string'
        ? body.targetUrl.trim()
        : typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
      const id = typeof body.id === 'string' ? body.id : undefined
      if (!name || !targetUrl) return json(response, 400, { error: '环境名称和测试页面地址不能为空' })
      const url = new URL(targetUrl)
      if (!['http:', 'https:'].includes(url.protocol)) return json(response, 400, { error: '环境地址只允许 HTTP 或 HTTPS' })
      return json(response, 200, { environment: saveEnvironment({ id, name, baseUrl: url.origin, targetUrl: url.href }) })
    }

    const stateMatch = request.url?.match(/^\/api\/environments\/([a-f0-9-]+)\/storage-state$/i)
    if (request.method === 'POST' && stateMatch) {
      const environment = getEnvironmentById(stateMatch[1])
      if (!environment) return json(response, 404, { error: '测试环境不存在' })
      const storageState = storageStateSchema.parse(await readJson(request))
      const directory = resolve('data/auth')
      await mkdir(directory, { recursive: true })
      const statePath = resolve(directory, `${environment.id}.json`)
      await writeFile(statePath, JSON.stringify(storageState), { mode: 0o600 })
      return json(response, 200, { environment: setEnvironmentStorageState(environment.id, statePath) })
    }

    const artifactMatch = request.url?.match(/^\/api\/artifacts\/([a-f0-9-]+)\/([^/?]+)$/i)
    if (request.method === 'GET' && artifactMatch) {
      const executionId = artifactMatch[1]
      const fileName = basename(decodeURIComponent(artifactMatch[2]))
      if (!/^(trace\.zip|failure\.png|[\w\u4e00-\u9fa5-]+\.png)$/.test(fileName)) return json(response, 400, { error: '证据文件名不合法' })
      const filePath = resolve('data/artifacts', executionId, fileName)
      if (!existsSync(filePath)) return json(response, 404, { error: '证据文件不存在' })
      response.writeHead(200, {
        'content-type': fileName.endsWith('.zip') ? 'application/zip' : 'image/png',
        'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      })
      createReadStream(filePath).pipe(response)
      return
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
          return
        }
        return json(response, result.status === 'passed' ? 201 : 422, { execution })
      } catch (error) {
        if (!stream) throw error
        stream.send({ type: 'execution_error', error: error instanceof Error ? error.message : String(error) } satisfies LiveExecutionEvent)
        stream.close()
        return
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
          return
        }
        return json(response, result.status === 'passed' ? 201 : 422, { execution })
      } catch (error) {
        if (!stream) throw error
        stream.send({ type: 'execution_error', error: error instanceof Error ? error.message : String(error) } satisfies LiveExecutionEvent)
        stream.close()
        return
      }
    }

    if (request.method === 'POST' && request.url === '/api/analyze') {
      const body = await readJson(request)
      const rawFiles = Array.isArray(body.files)
        ? body.files
        : [{ fileName: body.fileName, content: body.content, role: 'prd' }]
      let documents
      try {
        documents = await parseSourceDocuments(rawFiles)
      } catch (error) {
        return json(response, 400, { error: error instanceof Error ? error.message : '需求材料解析失败' })
      }

      const { result, model } = await analyzePrd(documents)
      const fileNames = documents.map(document => document.fileName)
      const saved = {
        id: randomUUID(),
        fileName: fileNames.join('、'),
        fileNames,
        sourceText: documents.map(document => document.content).join('\n\n---\n\n'),
        provider: 'company-responses',
        model,
        result,
        createdAt: new Date().toISOString(),
        review: { confirmedQuestions: [], selectedCases: [], updatedAt: null },
      }
      saveAnalysis(saved)
      return json(response, 201, { analysis: { ...saved, sourceText: undefined } })
    }

    const reviewMatch = request.url?.match(/^\/api\/analyses\/([^/]+)\/review$/)
    if (request.method === 'PATCH' && reviewMatch) {
      const body = await readJson(request)
      const confirmedQuestions = Array.isArray(body.confirmedQuestions) && body.confirmedQuestions.every(item => typeof item === 'string') ? body.confirmedQuestions : null
      const selectedCases = Array.isArray(body.selectedCases) && body.selectedCases.every(item => typeof item === 'string') ? body.selectedCases : null
      if (!confirmedQuestions || !selectedCases) return json(response, 400, { error: '评审状态格式错误' })
      const analysis = getAnalysisById(decodeURIComponent(reviewMatch[1]))
      if (!analysis) return json(response, 404, { error: '解析记录不存在' })
      let parsedQuestionReviews = analysis.review.questionReviews ?? {}
      if (body.questionReviews !== undefined) {
        const questionReviewsResult = reviewStateSchema.shape.questionReviews.safeParse(body.questionReviews)
        if (!questionReviewsResult.success) return json(response, 400, { error: '人工 Review 格式错误' })
        parsedQuestionReviews = questionReviewsResult.data
      }
      let parsedCaseReviews = analysis.review.caseReviews ?? {}
      if (body.caseReviews !== undefined) {
        const caseReviewsResult = reviewStateSchema.shape.caseReviews.safeParse(body.caseReviews)
        if (!caseReviewsResult.success) return json(response, 400, { error: '用例 Review 格式错误' })
        parsedCaseReviews = caseReviewsResult.data
      }
      return json(response, 200, {
        review: saveReview(decodeURIComponent(reviewMatch[1]), {
          confirmedQuestions, selectedCases,
          questionReviews: parsedQuestionReviews,
          caseReviews: parsedCaseReviews,
        }),
      })
    }

    const reviewContractMatch = request.url?.match(/^\/api\/analyses\/([^/]+)\/review\/contract$/)
    if (request.method === 'POST' && reviewContractMatch) {
      const body = await readJson(request)
      const analysis = getAnalysisById(decodeURIComponent(reviewContractMatch[1]))
      if (!analysis) return json(response, 404, { error: '解析记录不存在' })
      const questionKey = typeof body.questionKey === 'string' ? body.questionKey : ''
      const keyMatch = questionKey.match(/^(\d+)-Q-(\d+)$/)
      if (!keyMatch) return json(response, 400, { error: '问题编号格式错误' })
      const requirementIndex = Number(keyMatch[1])
      const questionIndex = Number(keyMatch[2])
      const requirement = analysis.result.requirements[requirementIndex]
      const question = requirement?.questions[questionIndex]
      if (!requirement || !question) return json(response, 400, { error: `待确认问题不存在：${questionKey}` })
      const finalStatement = typeof body.finalStatement === 'string' ? body.finalStatement.trim() : ''
      if (!finalStatement) return json(response, 400, { error: '人工最终口径不能为空' })
      const requestedCaseKey = typeof body.caseKey === 'string' ? body.caseKey : ''
      const caseMatch = requestedCaseKey.match(/^(\d+)-TC-(\d+)$/)
      const testCase = caseMatch && Number(caseMatch[1]) === requirementIndex
        ? requirement.testCases[Number(caseMatch[2])]
        : requirement.testCases.find(item => item.blockedByQuestion) ?? requirement.testCases[0]
      if (!testCase) return json(response, 400, { error: '该需求没有可用于解析的测试用例' })

      let sourceContext: Awaited<ReturnType<typeof collectReviewSourceContext>> = { route: null, files: [], warnings: ['未选择源码项目，将仅根据需求和人工口径解析'] }
      if (typeof body.projectId === 'string' && body.projectId && typeof body.targetUrl === 'string' && body.targetUrl) {
        try {
          sourceContext = await collectReviewSourceContext(await getProjectProvider(body.projectId), body.targetUrl, requirement, question)
        } catch (error) {
          sourceContext = { route: null, files: [], warnings: [`源码上下文不可用：${error instanceof Error ? error.message : String(error)}`] }
        }
      }
      const contract = await generateReviewExecutionContract({ question, finalStatement, requirement, testCase, sourceContext })
      return json(response, 200, { contract, sourceContext: { route: sourceContext.route, files: sourceContext.files.map(file => ({ path: file.path, truncated: file.truncated })), warnings: sourceContext.warnings } })
    }

    return json(response, 404, { error: '接口不存在' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务处理失败'
      console.error('[api]', message)
      return json(response, 500, { error: message })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createApiServer().listen(port, '127.0.0.1', () => {
    console.log(`[api] http://127.0.0.1:${port}`)
  })
}
