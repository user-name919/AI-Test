import { randomUUID } from 'node:crypto'
import { createRegressionSchema, type RegressionAnalysis } from '@quality-ai/contracts/regressions'
import { database } from '../../storage/database'
import { getModelConfig } from '../../integrations/model/config'
import { getChangeSet } from './change-sets'
import { analyzeChangeSetSource } from './source-impact'
import { generateRegressionSuggestions, regressionPromptVersion } from './suggestions'

let initialized = false
let working = false
const queue: string[] = []
const active = new Map<string, AbortController>()

export function initializeRegressionJobs() {
  if (initialized) return
  database.exec('CREATE TABLE IF NOT EXISTS regression_analyses (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL)')
  for (const row of database.prepare('SELECT record_json FROM regression_analyses').all() as Array<{ record_json: string }>) {
    const record = JSON.parse(row.record_json) as RegressionAnalysis
    if (record.status === 'queued' || record.status === 'running') {
      record.status = 'interrupted'; record.error = '服务重启，原分析已中断；保留已完成批次，可创建新分析，不自动重放模型请求'
      save(record)
    }
  }
  initialized = true
}
function save(record: RegressionAnalysis) {
  record.updatedAt = new Date().toISOString()
  database.prepare('UPDATE regression_analyses SET record_json=? WHERE id=?').run(JSON.stringify(record), record.id)
}
export function getRegression(id: string): RegressionAnalysis | null {
  const row = database.prepare('SELECT record_json FROM regression_analyses WHERE id=?').get(id) as { record_json: string } | undefined
  return row ? JSON.parse(row.record_json) : null
}
export function listRegressions() {
  return (database.prepare('SELECT record_json FROM regression_analyses ORDER BY rowid DESC LIMIT 100').all() as Array<{ record_json: string }>).map(row => {
    const { sourceImpact, generation, ...record } = JSON.parse(row.record_json) as RegressionAnalysis
    return { ...record, analyzedTrees: sourceImpact?.trees.length ?? 0, completedBatches: generation?.batches.length ?? 0 }
  })
}
export function createRegression(input: unknown) {
  const request = createRegressionSchema.parse(input)
  const existing = database.prepare('SELECT record_json FROM regression_analyses WHERE request_id=?').get(request.requestId) as { record_json: string } | undefined
  if (existing) {
    const record = JSON.parse(existing.record_json) as RegressionAnalysis
    if (record.changeSetId !== request.changeSetId || record.factsHash !== request.expectedHash) throw new Error('同一 requestId 不能对应不同范围')
    return record
  }
  const changeSet = getChangeSet(request.changeSetId)
  if (!changeSet || changeSet.status !== 'frozen' || changeSet.factsHash !== request.expectedHash) throw new Error('变更范围未冻结或指纹不一致')
  if (queue.length >= 20) throw new Error('回归分析队列已满')
  const now = new Date().toISOString()
  const record: RegressionAnalysis = { id: randomUUID(), changeSetId: changeSet.id, factsHash: changeSet.factsHash, projectId: changeSet.projectId, targetSha: changeSet.facts.targetSha, status: 'queued', stage: 'source', createdAt: now, updatedAt: now }
  database.prepare('INSERT INTO regression_analyses (id,request_id,record_json) VALUES (?,?,?)').run(record.id, request.requestId, JSON.stringify(record))
  queue.push(record.id)
  setImmediate(() => { void drain() })
  return record
}
export function cancelRegression(id: string) {
  const record = getRegression(id)
  if (!record) throw new Error('回归分析不存在')
  if (record.status === 'cancelled') return record
  if (!['queued', 'running'].includes(record.status)) throw new Error('任务已结束，不能取消')
  active.get(id)?.abort(new Error('用户取消回归分析'))
  record.status = 'cancelled'; record.error = '用户取消分析；已保存的源码依据和建议批次保留'
  save(record)
  return record
}
async function drain() {
  if (working) return
  working = true
  try {
    while (queue.length) {
      const record = getRegression(queue.shift()!)!
      if (record.status !== 'queued') continue
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)])
      active.set(record.id, controller)
      record.status = 'running'; save(record)
      try {
        const changeSet = getChangeSet(record.changeSetId)!
        record.sourceImpact = await analyzeChangeSetSource(record.changeSetId, record.id, signal)
        signal.throwIfAborted()
        record.stage = 'generating'; save(record)
        if (!changeSet.facts.diffs.some(diff => diff.files.length)) {
          record.generation = { promptVersion: regressionPromptVersion, model: 'not-called', reviewStatus: 'pending', batches: [], pendingEvidenceIds: [], omittedEvidenceIds: [], limitations: ['无文件变更，未调用模型；不代表回归测试通过'] }
        } else {
          record.generation = await generateRegressionSuggestions(changeSet.facts, record.sourceImpact, getModelConfig(), signal, progress => {
            signal.throwIfAborted(); record.generation = progress; save(record)
          })
        }
        signal.throwIfAborted()
        record.status = 'completed'; record.stage = 'finished'; save(record)
      } catch (error) {
        if (!controller.signal.aborted) {
          record.status = 'failed'; record.error = error instanceof Error ? error.message : String(error); save(record)
        } // 用户取消记录由取消入口保存，不能被迟到的结果覆盖。
      } finally { active.delete(record.id) }
    }
  } finally { working = false }
}
