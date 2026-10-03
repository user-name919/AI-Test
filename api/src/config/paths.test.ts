import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { getRuntimePaths, workspaceRoot } from './paths'

test('all default persistent paths stay under the existing repository root', () => {
  assert.equal(existsSync(resolve(workspaceRoot, 'pnpm-workspace.yaml')), true)
  assert.deepEqual(getRuntimePaths({}), {
    workspaceRoot,
    dataRoot: resolve(workspaceRoot, 'data'),
    databasePath: resolve(workspaceRoot, 'data/quality-ai.sqlite'),
    artifactRoot: resolve(workspaceRoot, 'data/artifacts'),
    authRoot: resolve(workspaceRoot, 'data/auth'),
    projectConfigPath: resolve(workspaceRoot, 'config/projects.local.json'),
  })
})

test('relative overrides are repository-relative and explicit absolute database/config paths remain valid', () => {
  const paths = getRuntimePaths({ QUALITY_AI_DATA_ROOT: 'work/test-data', QUALITY_AI_DATABASE_PATH: '/private/tmp/test.sqlite', PROJECTS_CONFIG_PATH: '/private/tmp/projects.json' })
  assert.equal(paths.artifactRoot, resolve(workspaceRoot, 'work/test-data/artifacts'))
  assert.equal(paths.authRoot, resolve(workspaceRoot, 'work/test-data/auth'))
  assert.equal(paths.databasePath, '/private/tmp/test.sqlite')
  assert.equal(paths.projectConfigPath, '/private/tmp/projects.json')
  assert.equal(getRuntimePaths({ QUALITY_AI_DATABASE_PATH: 'data/other.sqlite' }).databasePath, resolve(workspaceRoot, 'data/other.sqlite'))
})

test('repository, api and external working directories resolve the same persistent paths', () => {
  const script = `import {getRuntimePaths} from ${JSON.stringify(new URL('./paths.ts', import.meta.url).href)};console.log(JSON.stringify(getRuntimePaths({})))`
  for (const cwd of [workspaceRoot, resolve(workspaceRoot, 'api'), tmpdir()]) {
    const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(output), getRuntimePaths({}))
  }
})
