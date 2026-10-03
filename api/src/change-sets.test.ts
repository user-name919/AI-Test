import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { ChangeSet } from '@quality-ai/contracts/regressions'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-change-sets-'))
process.env.QUALITY_AI_DATA_ROOT = directory
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'db.sqlite')
process.env.PROJECTS_CONFIG_PATH = join(directory, 'projects.json')
const root = join(directory, 'project'); mkdirSync(root)
writeFileSync(process.env.PROJECTS_CONFIG_PATH, JSON.stringify({ projects: [{ id: 'fixture', name: '公开示例', root }] }))
const { createApiServer } = await import('./app')
const { database } = await import('./storage/database')

test('实际 API 预览与冻结使用服务端事实，刷新与分支移动不改历史', async t => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, 'page.ts'), 'original'); git('add', '.'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'page.ts'), 'refactored'); git('add', '.'); git('commit', '-m', 'refactor')
  const target = git('rev-parse', 'HEAD')
  const api = createApiServer()
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  t.after(async () => { await new Promise<void>(resolve => api.close(() => resolve())); database.close(); rmSync(directory, { recursive: true, force: true }) })
  const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const previewResponse = await post('/api/change-sets/preview', { projectId: 'fixture', comparison: { mode: 'endpoints', baseRef: base, targetRef: 'main' } })
  assert.equal(previewResponse.status, 201)
  const preview = (await previewResponse.json() as { changeSet: ChangeSet }).changeSet
  assert.equal(preview.status, 'preview')
  assert.equal(preview.facts.targetSha, target)
  assert.ok(!JSON.stringify(preview).includes(root))
  writeFileSync(join(root, 'page.ts'), 'newer'); git('add', '.'); git('commit', '-m', 'branch moved')
  assert.equal((await post(`/api/change-sets/${preview.id}/freeze`, { expectedHash: '0'.repeat(64) })).status, 409)
  assert.equal((await post(`/api/change-sets/${preview.id}/freeze`, { expectedHash: preview.factsHash, facts: {} })).status, 400)
  const freeze = await post(`/api/change-sets/${preview.id}/freeze`, { expectedHash: preview.factsHash })
  const frozen = (await freeze.json() as { changeSet: ChangeSet }).changeSet
  assert.equal(frozen.status, 'frozen')
  assert.deepEqual(frozen.facts, preview.facts)
  assert.deepEqual((await (await post(`/api/change-sets/${preview.id}/freeze`, { expectedHash: preview.factsHash })).json()).changeSet, frozen)
  assert.deepEqual((await (await fetch(`${url}/api/change-sets/${preview.id}`)).json()).changeSet, frozen)
  const list = await (await fetch(`${url}/api/change-sets`)).json()
  assert.equal(list.changeSets[0].targetSha, target)
  assert.equal(list.changeSets[0].facts, undefined, '列表不重复传输所有 patch')
  assert.equal((await post('/api/change-sets/preview', { projectId: 'missing', comparison: { mode: 'endpoints', baseRef: base, targetRef: 'main' } })).status, 422)
  assert.equal((await post('/api/change-sets/preview', { projectId: 'fixture', root: '/arbitrary', comparison: { mode: 'endpoints', baseRef: base, targetRef: 'main' } })).status, 400)
  const persisted = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const {getChangeSet}=await import('./api/src/modules/regressions/change-sets.ts'); process.stdout.write(JSON.stringify(getChangeSet('${preview.id}')))`], { cwd: process.cwd().endsWith('/api') ? join(process.cwd(), '..') : process.cwd(), env: process.env, encoding: 'utf8' }))
  assert.deepEqual(persisted, frozen, '新进程读取仍是相同冻结事实')

  let calls = 0
  let hold = false
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const model = createServer(async (_request, response) => {
    calls++
    if (hold) await gate
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ output_text: JSON.stringify({ risks: [], cases: [], limitations: ['夹具未提出风险，不表示业务通过'] }) }))
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  t.after(async () => { release(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())) })
  process.env.MODEL_API_KEY = 'synthetic-only'
  process.env.MODEL_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}`
  const input = { changeSetId: frozen.id, expectedHash: frozen.factsHash, requestId: randomUUID() }
  const createdResponse = await post('/api/regressions', input)
  assert.equal(createdResponse.status, 202)
  const created = (await createdResponse.json()).regression
  assert.equal(created.status, 'queued')
  assert.equal((await (await post('/api/regressions', input)).json()).regression.id, created.id)
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let index = 0; index < 300; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
    throw new Error('后台任务未及时达到预期状态')
  }
  const detail = async (id: string) => (await (await fetch(`${url}/api/regressions/${id}`)).json()).regression
  await waitFor(async () => (await detail(created.id)).status === 'completed')
  const completed = await detail(created.id)
  assert.equal(completed.targetSha, target)
  assert.equal(completed.generation.reviewStatus, 'pending')
  assert.equal(completed.generation.batches.length, 1)
  assert.ok(completed.sourceImpact.trees.length >= 2)
  assert.equal(calls, 1)
  hold = true
  const cancelling = (await (await post('/api/regressions', { ...input, requestId: randomUUID() })).json()).regression
  await waitFor(async () => calls === 2)
  assert.equal((await (await post(`/api/regressions/${cancelling.id}/cancel`, {})).json()).regression.status, 'cancelled')
  release()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await detail(cancelling.id)).status, 'cancelled', '迟到模型结果不覆盖取消')
  assert.equal((await detail(cancelling.id)).generation.batches.length, 0)
  const orphan = { ...completed, id: randomUUID(), status: 'running' }
  database.prepare('INSERT INTO regression_analyses (id,request_id,record_json) VALUES (?,?,?)').run(orphan.id, randomUUID(), JSON.stringify(orphan))
  const restarted = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const m=await import('./api/src/modules/regressions/jobs.ts');m.initializeRegressionJobs();process.stdout.write(JSON.stringify(m.getRegression('${orphan.id}')))`], { cwd: process.cwd().endsWith('/api') ? join(process.cwd(), '..') : process.cwd(), env: process.env, encoding: 'utf8' }))
  assert.equal(restarted.status, 'interrupted')
  assert.deepEqual(restarted.generation, completed.generation)
})
