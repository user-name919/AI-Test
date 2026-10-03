import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { ChangeSet } from '@quality-ai/contracts/regressions'

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
})
