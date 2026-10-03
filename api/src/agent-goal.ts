import { agentTestGoalSchema, type AgentTestGoal, type SavedAnalysis } from '@quality-ai/contracts'
import { resolveCaseExecutionContract } from './review-execution-context'

export function buildAgentTestGoal(analysis: SavedAnalysis, caseKey: string, targetUrl: string): AgentTestGoal {
  const resolved = resolveCaseExecutionContract(analysis, caseKey)
  if (!resolved.readiness.agent.executable) throw new Error(`${resolved.readiness.agent.reason}：${caseKey}`)
  const { requirementIndex, caseIndex, contract, resolvedQuestions } = resolved
  return agentTestGoalSchema.parse({
    name: resolved.title,
    targetUrl,
    objective: contract.objective,
    executionContract: { caseKey, contract, contractFingerprint: resolved.contractFingerprint },
    resolvedQuestions,
    requiredAssertions: [
      ...contract.expectedAssertions.map((description, index) => ({
        id: `r${requirementIndex + 1}-tc${caseIndex + 1}-a${index + 1}`, description,
      })),
      ...resolvedQuestions.flatMap(question => question.assertions.map((description, index) => ({
        id: `${question.questionKey}-a${index + 1}`, description,
      }))),
    ],
  })
}
