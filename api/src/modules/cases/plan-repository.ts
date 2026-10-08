import type { AutomationPlan, SavedAutomationPlan } from '@quality-ai/contracts'
import { database } from '../../storage/database'

export function saveAutomationPlan(input: SavedAutomationPlan) {
  database.prepare('INSERT INTO automation_plans (id, analysis_id, case_keys_json, plan_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.id, input.analysisId, JSON.stringify(input.caseKeys), JSON.stringify(input.plan), input.createdAt)
}

export function getLatestAutomationPlan(): SavedAutomationPlan | null {
  const row = database.prepare('SELECT id, analysis_id, case_keys_json, plan_json, created_at FROM automation_plans ORDER BY created_at DESC LIMIT 1').get() as Record<string, string> | undefined
  if (!row) return null
  return { id: row.id, analysisId: row.analysis_id, caseKeys: JSON.parse(row.case_keys_json) as string[], plan: JSON.parse(row.plan_json) as AutomationPlan, createdAt: row.created_at }
}

export function getAutomationPlanById(id: string): SavedAutomationPlan | null {
  const row = database.prepare('SELECT id, analysis_id, case_keys_json, plan_json, created_at FROM automation_plans WHERE id=?').get(id) as Record<string, string> | undefined
  if (!row) return null
  return { id: row.id, analysisId: row.analysis_id, caseKeys: JSON.parse(row.case_keys_json) as string[], plan: JSON.parse(row.plan_json) as AutomationPlan, createdAt: row.created_at }
}
