import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DeploymentConfirmation } from '@quality-ai/contracts/regressions'

test('部署基线只用各环境最新有效登记，不回退未核实记录、不跨项目或失效环境推荐', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-baselines-'))
  process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'db.sqlite')
  const { database } = await import('./storage/database')
  const { initializeDeploymentConfirmations, listDeploymentBaselines } = await import('./modules/regressions/deployments')
  const { saveEnvironment } = await import('./modules/projects/environment-repository')
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }) })
  initializeDeploymentConfirmations()
  const environment = saveEnvironment({ name: '测试环境', baseUrl: 'http://example.test', targetUrl: 'http://example.test/page' })
  const record = (overrides: Partial<DeploymentConfirmation> = {}): DeploymentConfirmation => ({
    id: randomUUID(), regressionId: randomUUID(), changeSetId: randomUUID(), projectId: 'fixture', reviewRevision: 1,
    environmentId: environment.id, targetUrl: environment.targetUrl, environmentBaseUrl: environment.baseUrl, environmentTargetUrl: environment.targetUrl,
    deployedSha: 'a'.repeat(40), targetSha: 'a'.repeat(40), status: 'matched', confirmedBy: '合成确认人', note: '合成部署依据', createdAt: new Date().toISOString(), ...overrides,
  })
  const insert = (value: DeploymentConfirmation) => database.prepare('INSERT INTO regression_deployments (id,regression_id,environment_id,record_json) VALUES (?,?,?,?)').run(value.id, value.regressionId, value.environmentId, JSON.stringify(value))
  assert.deepEqual(listDeploymentBaselines('fixture'), [])
  const original = record(); insert(original)
  assert.deepEqual(listDeploymentBaselines('fixture'), [{ environmentName: '测试环境', confirmation: original }])
  insert(record({ status: 'unverified', deployedSha: undefined }))
  assert.deepEqual(listDeploymentBaselines('fixture'), [], '不能退回更早的matched记录')
  insert(record({ status: 'mismatched', deployedSha: 'b'.repeat(40) }))
  assert.deepEqual(listDeploymentBaselines('fixture'), [])
  insert(record({ projectId: 'other' }))
  assert.deepEqual(listDeploymentBaselines('fixture'), [], '其他项目最新登记使同环境旧登记失效')
  insert(record())
  saveEnvironment({ id: environment.id, name: environment.name, baseUrl: environment.baseUrl, targetUrl: 'http://example.test/changed' })
  assert.deepEqual(listDeploymentBaselines('fixture'), [], '配置改变后不推荐历史登记')
  database.prepare('DELETE FROM test_environments WHERE id=?').run(environment.id)
  assert.deepEqual(listDeploymentBaselines('fixture'), [], '删除环境后不推荐孤立记录')
})
