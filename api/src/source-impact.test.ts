import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-source-impact-'))
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'db.sqlite')
process.env.QUALITY_AI_DATA_ROOT = directory
const { collectSourceImpact } = await import('./modules/regressions/source-impact')
const { collectLocalChangeFacts } = await import('./integrations/git/local-git')
const { database } = await import('./storage/database')

test('共享组件反向追踪两个页面，旧树保留删除依据，未解析与预算明确列出', async t => {
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  const root = join(directory, 'project'); mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  mkdirSync(join(root, 'components')); mkdirSync(join(root, 'pages'))
  writeFileSync(join(root, 'components/Select.ts'), 'export const select = 1')
  writeFileSync(join(root, 'components/index.ts'), "export { select } from './Select'\n")
  writeFileSync(join(root, 'pages/One.vue'), "<script setup>\nimport { select } from '../components'\n</script>\n")
  writeFileSync(join(root, 'pages/Two.ts'), "import { select } from '../components/Select'\nimport unknown from '@/runtime'\nconst late = import(dynamicName)\n")
  writeFileSync(join(root, 'README.md'), 'not source')
  git('add', '.'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  rmSync(join(root, 'components/Select.ts'))
  git('add', '.'); git('commit', '-m', 'delete component')
  const facts = await collectLocalChangeFacts(root, { mode: 'endpoints', baseRef: base, targetRef: 'main' })
  const impact = await collectSourceImpact(root, facts)
  const old = impact.trees.find(tree => tree.sha === base)!
  assert.ok(old.affectedFiles.includes('pages/One.vue'))
  assert.ok(old.affectedFiles.includes('pages/Two.ts'))
  assert.ok(old.edges.some(edge => edge.from === 'pages/One.vue' && edge.to === 'components/index.ts' && edge.line === 2))
  assert.ok(old.edges.some(edge => edge.from === 'components/index.ts' && edge.to === 'components/Select.ts'))
  const current = impact.trees.find(tree => tree.sha === facts.targetSha)!
  assert.ok(current.unresolved.some(item => item.expression === '../components/Select'))
  assert.ok(current.unresolved.some(item => item.expression === '@/runtime'))
  assert.ok(current.unresolved.some(item => item.reason.includes('动态依赖')))
  assert.ok(current.skippedFiles.some(item => item.path === 'README.md'))
  assert.ok(impact.warnings.some(value => value.includes('不是完整调用图')))
  const bounded = await collectSourceImpact(root, facts, { maxFiles: 1, maxBytes: 1024, maxTrees: 1 })
  assert.deepEqual(bounded.skippedShas, [base])
  assert.equal(bounded.trees[0]!.scannedFiles.length, 1)
  assert.ok(bounded.trees[0]!.skippedFiles.some(item => item.reason.includes('预算')))
  assert.ok(bounded.warnings.some(value => value.includes('不完整')))
})
