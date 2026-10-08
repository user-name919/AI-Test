import { randomUUID } from 'node:crypto'
import { deploymentConfirmationSchema, type DeploymentConfirmation, type DeploymentBaseline } from '@quality-ai/contracts/regressions'
import { database } from '../../storage/database'
import { getRegression } from './jobs'
import { getRegressionReviews } from './review'
import { getEnvironmentById } from '../projects/environment-repository'

export function initializeDeploymentConfirmations() {
  database.exec('CREATE TABLE IF NOT EXISTS regression_deployments (id TEXT PRIMARY KEY, regression_id TEXT NOT NULL, environment_id TEXT NOT NULL, record_json TEXT NOT NULL)')
}
export function getDeploymentConfirmation(id: string): DeploymentConfirmation | null {
  const row = database.prepare('SELECT record_json FROM regression_deployments WHERE id=?').get(id) as { record_json: string } | undefined
  return row ? JSON.parse(row.record_json) : null
}
export function listDeploymentConfirmations(regressionId: string): DeploymentConfirmation[] {
  return (database.prepare('SELECT record_json FROM regression_deployments WHERE regression_id=? ORDER BY rowid DESC').all(regressionId) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json))
}

/** Only the latest registration per environment can recommend a baseline; never fall back past an unverified update. */
export function listDeploymentBaselines(projectId: string): DeploymentBaseline[] {
  const rows = database.prepare(`SELECT record_json FROM regression_deployments
    WHERE rowid IN (SELECT MAX(rowid) FROM regression_deployments GROUP BY environment_id)
    ORDER BY rowid DESC`).all() as Array<{ record_json: string }>
  return rows.flatMap(row => {
    const confirmation: DeploymentConfirmation = JSON.parse(row.record_json)
    if (confirmation.projectId !== projectId || confirmation.status !== 'matched' || !confirmation.deployedSha) return []
    const environment = getEnvironmentById(confirmation.environmentId)
    if (!environment || environment.baseUrl !== confirmation.environmentBaseUrl || environment.targetUrl !== confirmation.environmentTargetUrl) return []
    return [{ environmentName: environment.name, confirmation }]
  })
}
export function saveDeploymentConfirmation(regressionId: string, input: unknown): DeploymentConfirmation {
  const request = deploymentConfirmationSchema.parse(input)
  const regression = getRegression(regressionId)
  if (!regression) throw new Error('回归任务不存在')
  const review = getRegressionReviews(regressionId).find(item => item.revision === request.reviewRevision)
  if (review?.content.status !== 'confirmed') throw new Error('必须选择已确认的人工审核版本')
  const environment = getEnvironmentById(request.environmentId)
  if (!environment) throw new Error('测试环境不存在')
  const target = new URL(request.targetUrl)
  if (target.origin !== new URL(environment.baseUrl).origin) throw new Error('测试地址与环境 Origin 不一致')
  const record: DeploymentConfirmation = { ...request, targetUrl: target.href, id: randomUUID(), regressionId, projectId: regression.projectId,
    changeSetId: regression.changeSetId, targetSha: regression.targetSha,
    status: request.deployedSha ? request.deployedSha === regression.targetSha ? 'matched' : 'mismatched' : 'unverified',
    environmentBaseUrl: environment.baseUrl, environmentTargetUrl: environment.targetUrl, createdAt: new Date().toISOString() }
  database.prepare('INSERT INTO regression_deployments (id,regression_id,environment_id,record_json) VALUES (?,?,?,?)').run(record.id, regressionId, request.environmentId, JSON.stringify(record))
  return record
}

/** 只验证人工登记对应关系，不自动探测、部署或声称服务器确实运行该 SHA。 */
export function validateDeploymentForExecution(id: string, expected: { regressionId: string; reviewRevision: number; environmentId: string; targetUrl: string }): DeploymentConfirmation {
  const record = getDeploymentConfirmation(id)
  if (!record || record.regressionId !== expected.regressionId || record.reviewRevision !== expected.reviewRevision || record.environmentId !== expected.environmentId || record.targetUrl !== new URL(expected.targetUrl).href) throw new Error('部署确认与回归版本、环境或测试地址不一致')
  const latest = database.prepare('SELECT id FROM regression_deployments WHERE environment_id=? ORDER BY rowid DESC LIMIT 1').get(record.environmentId) as { id: string } | undefined
  if (latest?.id !== record.id) throw new Error('该环境已有更新的部署确认，请重新核对后执行')
  const environment = getEnvironmentById(record.environmentId)
  if (!environment || environment.baseUrl !== record.environmentBaseUrl || environment.targetUrl !== record.environmentTargetUrl) throw new Error('环境配置已变化，请重新确认部署对应关系')
  if (record.status === 'mismatched') throw new Error('登记的部署 SHA 与回归目标版本不匹配，禁止执行；请修正环境或比较目标')
  return record // unverified 保留状态与人员备注，下游报告必须明确，不变成 matched。
}
