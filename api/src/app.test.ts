import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { before, after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-domain-routes-'))
const source = join(directory, 'source')
mkdirSync(source)
writeFileSync(join(source, 'search.ts'), 'export const searchTitle = "合成搜索控件"')
const projectConfig = join(directory, 'projects.json')
writeFileSync(projectConfig, JSON.stringify({ projects: [{ id: 'fixture', name: '合成项目', root: source, targetOrigins: ['https://example.test'] }] }))
process.env.QUALITY_AI_DATA_ROOT = directory
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'test.sqlite')
process.env.PROJECTS_CONFIG_PATH = projectConfig
const { createApiServer } = await import('./app')
const server = createApiServer()
let base = ''
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  delete process.env.QUALITY_AI_DATA_ROOT
  delete process.env.QUALITY_AI_DATABASE_PATH
  delete process.env.PROJECTS_CONFIG_PATH
  rmSync(directory, { recursive: true, force: true })
})

async function post(path: string, value: unknown) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
}

test('domain dispatch preserves empty reads, missing records and unsupported routes', async () => {
  for (const [path, expected] of [
    ['/api/analyses/latest', { analysis: null }], ['/api/analyses', { analyses: [] }],
    ['/api/executions/latest', { execution: null }], ['/api/executions', { executions: [] }],
    ['/api/automation/plans/latest', { automationPlan: null }], ['/api/environments/latest', { environment: null }],
  ] as const) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), expected)
  }
  for (const path of ['/api/analyses/11111111-1111-4111-8111-111111111111', '/api/executions/11111111-1111-4111-8111-111111111111', '/api/unknown']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404)
  }
  assert.equal((await post('/api/analyses', {})).status, 404)
  assert.equal((await post('/api/analyze', { files: [] })).status, 400)
})

test('environment routes preserve login-state persistence and never return credential content', async () => {
  assert.equal((await post('/api/environments', { name: '合成' })).status, 400)
  const response = await post('/api/environments', { name: '合成', targetUrl: 'https://example.test/search?mode=1' })
  assert.equal(response.status, 200)
  const { environment } = await response.json()
  const state = { cookies: [], origins: [] }
  const upload = await post(`/api/environments/${environment.id}/storage-state`, state)
  assert.equal(upload.status, 200)
  const body = await upload.json()
  assert.equal(body.environment.hasStorageState, true)
  assert.equal('storageStatePath' in body.environment, false)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'auth', `${environment.id}.json`), 'utf8')), state)
})

test('project source handlers remain read-only and validate input before querying', async () => {
  const list = await fetch(`${base}/api/projects`)
  assert.equal((await list.json()).projects[0].id, 'fixture')
  assert.equal((await post('/api/projects/fixture/validate', {})).status, 200)
  assert.equal((await post('/api/projects/fixture/search-source', { query: '搜索', scopes: ['unknown'] })).status, 400)
  const search = await post('/api/projects/fixture/search-source', { query: '合成搜索控件' })
  assert.equal(search.status, 200)
  assert.equal((await search.json()).matches[0].path, 'search.ts')
  assert.equal((await post('/api/projects/fixture/inspect-source', { paths: ['search.ts'] })).status, 400)
  const inspect = await post('/api/projects/fixture/inspect-source', { paths: ['search.ts'], reason: '验证模块迁移' })
  assert.equal(inspect.status, 200)
  assert.equal(readFileSync(join(source, 'search.ts'), 'utf8'), 'export const searchTitle = "合成搜索控件"')
})

test('legacy artifact URLs still stream files after the route split', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const artifactDirectory = join(directory, 'artifacts', id)
  mkdirSync(artifactDirectory, { recursive: true })
  writeFileSync(join(artifactDirectory, 'failure.png'), 'synthetic-image-bytes')
  const response = await fetch(`${base}/api/artifacts/${id}/failure.png`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(await response.text(), 'synthetic-image-bytes')
  assert.equal((await fetch(`${base}/api/artifacts/${id}/unknown.png`)).status, 404)
  assert.equal((await fetch(`${base}/api/artifacts/${id}/invalid.txt`)).status, 400)
})
