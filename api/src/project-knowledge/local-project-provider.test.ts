import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { projectConfigSchema } from './types'
import { LocalProjectKnowledgeProvider } from './local-project-provider'

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-project-'))
  const projectRoot = join(directory, 'target-project')
  const workspaceRoot = join(directory, 'quality-ai')
  await mkdir(join(projectRoot, 'src/router'), { recursive: true })
  await mkdir(join(projectRoot, 'src/views/student'), { recursive: true })
  await mkdir(join(projectRoot, 'private'), { recursive: true })
  await mkdir(join(workspaceRoot, 'targets'), { recursive: true })
  await writeFile(join(projectRoot, 'src/router/index.ts'), `
    export const routes = [{
      path: '/students/:id',
      component: () => import('../views/student/detail.vue'),
    }]
  `)
  await writeFile(join(projectRoot, 'src/views/student/detail.vue'), '<button data-testid="student-save">保存学生</button>')
  await writeFile(join(projectRoot, 'private/secret.ts'), 'not-readable')
  await symlink(projectRoot, join(workspaceRoot, 'targets/project'))
  const config = projectConfigSchema.parse({
    id: 'fixture-project',
    name: 'Fixture project',
    root: './targets/project',
    targetOrigins: ['http://localhost:5173'],
    sourceRoots: ['src'],
  })
  return { directory, provider: new LocalProjectKnowledgeProvider(config, workspaceRoot) }
}

test('resolves a symlinked project and exposes its Git-independent connection state', async testContext => {
  const { directory, provider } = await createFixture()
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  const info = await provider.getProjectInfo()
  assert.equal(info.connected, true)
  assert.match(info.resolvedRoot ?? '', /target-project$/)
})

test('resolves a dynamic route and its lazy component without executing target code', async testContext => {
  const { directory, provider } = await createFixture()
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  const route = await provider.resolveRoute({ url: 'http://localhost:5173/students/42' })
  assert.deepEqual(route, {
    url: 'http://localhost:5173/students/42',
    pathname: '/students/42',
    routePath: '/students/:id',
    routeFile: 'src/router/index.ts',
    componentFile: 'src/views/student/detail.vue',
    confidence: 'pattern',
  })
})

test('resolves a source route behind a deployment base path', async testContext => {
  const { directory, provider } = await createFixture()
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  const route = await provider.resolveRoute({ url: 'http://localhost:5173/lvworkbench/students/42' })
  assert.equal(route?.routePath, '/students/:id')
  assert.equal(route?.componentFile, 'src/views/student/detail.vue')
  assert.equal(route?.confidence, 'partial')
})

test('searches and inspects only allowlisted source roots', async testContext => {
  const { directory, provider } = await createFixture()
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  const matches = await provider.searchSource({ query: 'student-save', scopes: ['page'] })
  assert.equal(matches.length, 1)
  assert.equal(matches[0].path, 'src/views/student/detail.vue')

  const context = await provider.inspectFiles({ paths: [matches[0].path], reason: '确认保存按钮定位' })
  assert.match(context.files[0].content, /保存学生/)
  await assert.rejects(
    provider.inspectFiles({ paths: ['private/secret.ts'], reason: '尝试越界读取' }),
    /文件不在允许的源码目录/,
  )
})

test('finds a close Chinese source phrase when wording contains an extra qualifier', async testContext => {
  const { directory, provider } = await createFixture()
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  const projectRoot = join(directory, 'target-project')
  await writeFile(join(projectRoot, 'src/views/student/detail.vue'), '<button>批量生成报告</button>')

  const matches = await provider.searchSource({ query: '批量生成分析报告', scopes: ['page'] })
  assert.equal(matches[0]?.path, 'src/views/student/detail.vue')
  assert.match(matches[0]?.preview ?? '', /批量生成报告/)
})

test('rejects URLs outside configured target origins', async testContext => {
  const { directory, provider } = await createFixture()
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  await assert.rejects(
    provider.resolveRoute({ url: 'https://example.com/students/42' }),
    /URL Origin 未配置到项目/,
  )
})
