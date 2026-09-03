import { createHash } from 'node:crypto'
import type { CaseExecutionContract, ResolvedCaseExecutionContract, SavedAnalysis, ReviewExecutionContract } from '../shared/contracts'
import { isCaseReviewExecutable, isQuestionReviewResolved } from '../shared/review-state'

export interface ResolvedReviewContext {
  questionKey: string
  questionTitle: string
  finalStatement: string
  objective?: string
  triggers: string[]
  behaviors: string[]
  assertions: string[]
  forbiddenBehaviors: string[]
  sourceHints: string[]
  uncertainties: string[]
  confidence?: ReviewExecutionContract['confidence']
}

export interface ServerResolvedCaseExecutionContract extends Omit<ResolvedCaseExecutionContract, 'resolvedQuestions'> {
  resolvedQuestions: ResolvedReviewContext[]
}

function collectRequirementReviewContext(analysis: SavedAnalysis, requirementIndex: number): ResolvedReviewContext[] {
  const requirement = analysis.result.requirements[requirementIndex]
  if (!requirement) return []
  return requirement.questions.flatMap((question, questionIndex) => {
    const questionKey = `${requirementIndex}-Q-${questionIndex}`
    const review = analysis.review.questionReviews?.[questionKey]
    if (!review || !isQuestionReviewResolved(analysis.review, questionKey)) return []
    return [{
      questionKey,
      questionTitle: question.title,
      finalStatement: review.finalStatement,
      objective: review.executionContract?.objective,
      triggers: review.executionContract?.triggers ?? [],
      behaviors: review.executionContract?.behaviors ?? [],
      assertions: review.executionContract?.assertions ?? [],
      forbiddenBehaviors: review.executionContract?.forbiddenBehaviors ?? [],
      sourceHints: review.executionContract?.sourceHints ?? [],
      uncertainties: review.executionContract?.uncertainties ?? [],
      confidence: review.executionContract?.confidence,
    }]
  })
}

export function collectResolvedReviewContext(analysis: SavedAnalysis, caseKeys: string[]): ResolvedReviewContext[] {
  const requirementIndexes = new Set(caseKeys.flatMap(key => {
    const match = key.match(/^(\d+)-TC-\d+$/)
    return match ? [Number(match[1])] : []
  }))
  return [...requirementIndexes].flatMap(requirementIndex => collectRequirementReviewContext(analysis, requirementIndex))
}

function legacyContract(testCase: SavedAnalysis['result']['requirements'][number]['testCases'][number]): CaseExecutionContract {
  return {
    objective: testCase.title,
    preconditions: [...testCase.preconditions],
    steps: [...testCase.steps],
    expectedAssertions: [testCase.expectedResult],
    dataBindings: [],
    forbiddenBehaviors: [],
    uncertainties: [],
  }
}

function containsUnprovenDataLiteral(contract: CaseExecutionContract) {
  const dataOperation = /(?:输入|搜索|筛选|填写|选择|设置为|设为|使用)[^“”"'‘’]{0,20}[“"'‘]([^“”"'‘’]+)[”"'’]/g
  const quotedLiteral = /[“"'‘]([^“”"'‘’]+)[”"'’]/g
  const operationLiterals = new Set(
    [...contract.preconditions, ...contract.steps]
      .flatMap(text => [...text.matchAll(dataOperation)].map(match => match[1]?.trim()).filter((value): value is string => Boolean(value))),
  )
  const relatedAssertionLiterals = contract.expectedAssertions.flatMap(text =>
    [...text.matchAll(quotedLiteral)]
      .map(match => match[1]?.trim())
      .filter((value): value is string => Boolean(value) && operationLiterals.has(value)),
  )

  return [...new Set([...operationLiterals, ...relatedAssertionLiterals])].some(literal =>
    !contract.dataBindings.some(binding => {
      if (binding.mode === 'runtime_dom') return true
      if (binding.mode === 'fixture') {
        return binding.fixture?.value.trim() === literal && Boolean(binding.fixture.evidence.trim())
      }
      return binding.manual?.value.trim() === literal && Boolean(binding.manual.rationale.trim())
    }),
  )
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function resolveCaseExecutionContract(
  analysis: SavedAnalysis,
  caseKey: string,
): ServerResolvedCaseExecutionContract {
  const match = caseKey.match(/^(\d+)-TC-(\d+)$/)
  if (!match) throw new Error(`测试用例编号格式错误：${caseKey}`)
  const requirementIndex = Number(match[1])
  const caseIndex = Number(match[2])
  const requirement = analysis.result.requirements[requirementIndex]
  const testCase = requirement?.testCases[caseIndex]
  if (!requirement || !testCase) throw new Error(`测试用例不存在：${caseKey}`)

  const caseReview = analysis.review.caseReviews?.[caseKey]
  const contract = structuredClone(caseReview?.finalContract ?? legacyContract(testCase))
  const resolvedQuestions = collectRequirementReviewContext(analysis, requirementIndex)

  const caseReadiness = (mode: 'agent' | 'plan') => {
    const readiness = isCaseReviewExecutable(analysis.review, caseKey, mode)
    if (!readiness.executable) return readiness
    if (containsUnprovenDataLiteral(contract)) {
      return { executable: false, reason: '用例需要确认测试数据' }
    }
    if (!testCase.blockedByQuestion) return readiness

    const allQuestionsResolved = requirement.questions.length > 0
      && requirement.questions.every((_, questionIndex) => isQuestionReviewResolved(analysis.review, `${requirementIndex}-Q-${questionIndex}`))
    if (!allQuestionsResolved) return { executable: false, reason: '用例仍有待确认问题' }
    if (resolvedQuestions.some(question => question.uncertainties.length > 0)) {
      return { executable: false, reason: '用例对应的执行契约仍有不确定项' }
    }
    return readiness
  }

  const readiness = {
    agent: caseReadiness('agent'),
    plan: caseReadiness('plan'),
  }
  const fingerprintSource = {
    caseKey,
    title: testCase.title,
    contract,
    resolvedQuestions,
    caseReviewStatus: caseReview?.status ?? null,
    readiness,
  }
  return {
    caseKey,
    requirementIndex,
    caseIndex,
    title: testCase.title,
    contract,
    resolvedQuestions,
    readiness,
    contractFingerprint: createHash('sha256').update(stableJson(fingerprintSource)).digest('hex'),
  }
}
