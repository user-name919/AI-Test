import { automationPlanSchema, type AutomationPlan, type SavedAnalysis } from '@quality-ai/contracts'
import { resolveCaseExecutionContract } from './contract-resolver'
import { generateFixedPlan } from './fixed-plan-model'

export async function generateCasePlans(analysis: SavedAnalysis, caseKeys: string[], targetUrl: string): Promise<AutomationPlan> {
  const cases = caseKeys.map(caseKey => resolveCaseExecutionContract(analysis, caseKey))
  for (const item of cases) {
    if (!item.readiness.plan.executable) throw new Error(item.readiness.plan.reason ?? `用例不能生成固定计划：${item.caseKey}`)
  }
  const casePlans = await Promise.all(cases.map(async item => {
    const generated = await generateFixedPlan(targetUrl, item)
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
