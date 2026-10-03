import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { randomUUID } from 'node:crypto'
import { reviewStateSchema } from '@quality-ai/contracts'
import { getAnalysisById, getLatestAnalysis, listAnalyses, saveAnalysis, saveReview } from '../../database'
import { analyzePrd } from '../../model'
import { parseSourceDocuments } from '../../source-documents'
import { collectReviewSourceContext, generateReviewExecutionContract } from '../../review-contract'
import { getProjectProvider } from '../../project-knowledge/registry'


export async function handleRequirementRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.method === 'GET' && request.url === '/api/analyses/latest') {
    return json(response, 200, { analysis: getLatestAnalysis() })
  }

  if (request.method === 'GET' && request.url === '/api/analyses') {
    return json(response, 200, { analyses: listAnalyses() })
  }

  const analysisMatch = request.url?.match(/^\/api\/analyses\/([a-f0-9-]+)$/i)
  if (request.method === 'GET' && analysisMatch) {
    const analysis = getAnalysisById(analysisMatch[1])
    return analysis ? json(response, 200, { analysis }) : json(response, 404, { error: '版本不存在' })
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

  return false
}
