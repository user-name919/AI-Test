import type { AutomationPlan, ExecutionRecord, ExecutionResult, PrdAnalysis } from '@quality-ai/contracts'
import { database } from '../../storage/database'

interface ExecutionContext {
  analysisId?: string
  automationPlanId?: string
  environmentId?: string
  projectId?: string
  caseKeys?: string[]
  plan?: AutomationPlan
  rerunOf?: string
}

export function saveExecution(result: ExecutionResult, context: ExecutionContext = {}) {
  database.prepare(`INSERT INTO executions
    (id,name,status,result_json,created_at,analysis_id,automation_plan_id,environment_id,project_id,case_keys_json,plan_json,rerun_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(result.id, result.name, result.status, JSON.stringify(result), result.startedAt, context.analysisId ?? null,
      context.automationPlanId ?? null, context.environmentId ?? null, context.projectId ?? null, JSON.stringify(context.caseKeys ?? []),
      context.plan ? JSON.stringify(context.plan) : null, context.rerunOf ?? null)
}

const executionSelect = `
  SELECT e.*, a.result_json AS analysis_result_json, env.name AS environment_name
  FROM executions e
  LEFT JOIN analyses a ON a.id=e.analysis_id
  LEFT JOIN test_environments env ON env.id=e.environment_id
`

function mapExecution(row: Record<string, string> | undefined): ExecutionRecord | null {
  if (!row) return null
  const result = JSON.parse(row.result_json) as ExecutionResult
  const analysis = row.analysis_result_json ? JSON.parse(row.analysis_result_json) as PrdAnalysis : null
  return {
    ...result,
    analysisId: row.analysis_id || undefined,
    automationPlanId: row.automation_plan_id || undefined,
    environmentId: row.environment_id || undefined,
    projectId: row.project_id || undefined,
    caseKeys: JSON.parse(row.case_keys_json || '[]') as string[],
    plan: row.plan_json ? JSON.parse(row.plan_json) as AutomationPlan : undefined,
    versionName: analysis?.versionName,
    productName: analysis?.productName,
    environmentName: row.environment_name || undefined,
    rerunOf: row.rerun_of || undefined,
  }
}

export function getLatestExecution(): ExecutionRecord | null {
  return mapExecution(database.prepare(`${executionSelect} ORDER BY e.created_at DESC LIMIT 1`).get() as Record<string, string> | undefined)
}

export function getExecutionById(id: string): ExecutionRecord | null {
  return mapExecution(database.prepare(`${executionSelect} WHERE e.id=?`).get(id) as Record<string, string> | undefined)
}

export function listExecutions(limit = 100): ExecutionRecord[] {
  return (database.prepare(`${executionSelect} ORDER BY e.created_at DESC LIMIT ?`).all(limit) as Array<Record<string, string>>)
    .flatMap(row => mapExecution(row) ?? [])
}
