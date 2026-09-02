import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentDecisionProvider } from './test-agent'
import type { ProjectKnowledgeProvider } from './project-knowledge/types'
import { runAgentTest } from './agent-test-runner'
import type { LiveExecutionEvent } from '../shared/contracts'

test('runs a browser Agent with project context, DOM re-observation and required assertions', async testContext => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-agent-runner-'))
  testContext.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const web = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>学生管理</title></head><body>
      <label for="name">学生姓名</label><input id="name">
      <button onclick="document.querySelector('#result').textContent='保存成功'">保存</button>
      <div id="result"></div>
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => web.listen(0, '127.0.0.1', resolve).once('error', reject))
  testContext.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
  const targetUrl = `http://127.0.0.1:${address.port}/students`

  let sourceSearches = 0
  const projectProvider: ProjectKnowledgeProvider = {
    async getProjectInfo() { return { id: 'test', name: 'Test', configuredRoot: '.', connected: true, targetOrigins: [new URL(targetUrl).origin] } },
    async resolveRoute() { return null },
    async searchSource() { sourceSearches += 1; return [{ path: 'src/pages/students.vue', line: 10, column: 1, preview: '保存成功' }] },
    async inspectFiles() { return { projectId: 'test', reason: 'test', files: [], totalCharacters: 0 } },
  }
  let turn = 0
  let firstSnapshotId = ''
  const events: LiveExecutionEvent[] = []
  const decisionProvider: AgentDecisionProvider = {
    async decide({ snapshot, projectContexts }) {
      turn += 1
      if (turn === 1) {
        firstSnapshotId = snapshot.snapshotId
        return { type: 'need_project_context', request: { operation: 'search_source', query: '保存成功', scopes: ['page'] }, reason: '确认成功提示' }
      }
      if (turn === 2) {
        assert.equal(projectContexts.length, 1)
        assert.notEqual(snapshot.snapshotId, firstSnapshotId)
        return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'fill', elementRef: snapshot.elements.find(item => item.name === '学生姓名')?.ref ?? '', value: '张三' }, reason: '填写姓名' }
      }
      if (turn === 3) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'click', elementRef: snapshot.elements.find(item => item.name === '保存')?.ref ?? '' }, reason: '保存' }
      if (turn === 4) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'expectText', text: '保存成功', assertionId: 'saved' }, reason: '回到 DOM 验证结果' }
      return { type: 'finish', summary: '保存流程验证完成' }
    },
  }

  const result = await runAgentTest({
    name: '保存学生', targetUrl, objective: '填写姓名并保存',
    requiredAssertions: [{ id: 'saved', description: '页面显示保存成功' }],
  }, undefined, { projectProvider, decisionProvider, artifactRoot, onEvent: event => events.push(event) })

  assert.equal(result.status, 'passed')
  assert.equal(result.mode, 'agent')
  assert.equal(sourceSearches, 1)
  assert.equal(result.steps.length, 3)
  assert.equal(result.agent?.trajectory.length, 5)
  assert.deepEqual(result.agent?.passedAssertions, ['saved'])
  assert.equal(result.agent?.trajectory[0].observation?.title, '学生管理')
  assert.ok(result.agent?.trajectory[0].observation?.elements.some(element => element.name === '学生姓名'))
  assert.ok(result.tracePath)
  assert.ok(events.some(event => event.type === 'execution_started' && event.name === '保存学生'))
  assert.ok(events.some(event => event.type === 'browser_frame' && event.dataUrl.startsWith('data:image/jpeg;base64,')))
  assert.ok(events.some(event => event.type === 'activity'
    && event.activity.title === '点击“保存”'
    && event.activity.technicalAction?.startsWith('click e')))
  await stat(result.tracePath)
})
