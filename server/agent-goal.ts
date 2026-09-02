import { agentTestGoalSchema, type AgentTestGoal, type SavedAnalysis } from '../shared/contracts'
import { isQuestionReviewResolved } from '../shared/review-state'
import { collectResolvedReviewContext } from './review-execution-context'

export function buildAgentTestGoal(analysis: SavedAnalysis, caseKeys: string[], targetUrl: string): AgentTestGoal {
  const selectedCases = caseKeys.map(key => {
    const match = key.match(/^(\d+)-TC-(\d+)$/)
    const requirementIndex = match ? Number(match[1]) : -1
    const caseIndex = match ? Number(match[2]) : -1
    const requirement = analysis.result.requirements[requirementIndex]
    const testCase = requirement?.testCases[caseIndex]
    if (!requirement || !testCase) throw new Error(`测试用例不存在：${key}`)
    if (testCase.blockedByQuestion) {
      const requirementResolved = requirement.questions.length > 0 && requirement.questions.every((_, questionIndex) => {
        const questionKey = `${requirementIndex}-Q-${questionIndex}`
        return isQuestionReviewResolved(analysis.review, questionKey)
      })
      const hasUnresolvedContract = requirement.questions.some((_, questionIndex) => {
        const review = analysis.review.questionReviews?.[`${requirementIndex}-Q-${questionIndex}`]
        return Boolean(review?.executionContract?.uncertainties.length)
      })
      if (hasUnresolvedContract) throw new Error(`测试用例对应的执行契约仍有不确定项，不能执行：${key}`)
      if (!requirementResolved) throw new Error(`测试用例仍有待确认问题，不能执行：${key}`)
    }
    return { key, requirement, testCase, requirementIndex, caseIndex }
  })

  const reviewContexts = collectResolvedReviewContext(analysis, caseKeys)
  const objective = selectedCases.map(({ key, requirement, testCase, requirementIndex }) => [
    `[${key}] ${requirement.title} / ${testCase.title}`,
    `前置条件：${testCase.preconditions.length ? testCase.preconditions.join('；') : '无'}`,
    `操作步骤：${testCase.steps.join('；')}`,
    `预期结果：${testCase.expectedResult}`,
    ...reviewContexts.filter(context => context.questionKey.startsWith(`${requirementIndex}-`)).flatMap(context => {
      return [
        `人工最终口径：${context.finalStatement}`,
        ...(context.objective ? [`执行契约目标：${context.objective}`] : []),
        ...(context.triggers.length ? [`执行契约触发条件：${context.triggers.join('；')}`] : []),
        ...(context.behaviors?.length ? [`执行契约页面行为：${context.behaviors.join('；')}`] : []),
        ...(context.assertions.length ? [`执行契约断言：${context.assertions.join('；')}`] : []),
        `执行契约禁止行为：${context.forbiddenBehaviors.join('；') || '无'}`,
        ...(context.sourceHints.length ? [`执行契约源码线索：${context.sourceHints.join('；')}`] : []),
      ]
    }),
  ].join('\n')).join('\n\n')

  const contractAssertions = reviewContexts.flatMap(context => context.assertions.map((description, assertionIndex) => {
    const [, requirementIndex, questionIndex] = context.questionKey.match(/^(\d+)-Q-(\d+)$/) ?? []
    return {
      id: `r${Number(requirementIndex) + 1}-q${Number(questionIndex) + 1}-a${assertionIndex + 1}`,
      description,
    }
  }))

  return agentTestGoalSchema.parse({
    name: selectedCases.length === 1 ? selectedCases[0].testCase.title : `${analysis.result.versionName} · ${selectedCases.length} 条用例`,
    targetUrl,
    objective,
    requiredAssertions: [...selectedCases.map(({ requirementIndex, caseIndex, testCase }) => ({
      id: `r${requirementIndex + 1}-tc${caseIndex + 1}`,
      description: testCase.expectedResult,
    })), ...contractAssertions],
  })
}
