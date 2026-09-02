import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LiveExecutionEvent } from '../shared/contracts'
import { runAutomationPlan } from './playwright-runner'

test('streams the same Playwright page and readable fixed-plan activities', async testContext => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-plan-runner-'))
  testContext.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const web = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>考试列表</title><button>选择考试</button>')
  })
  await new Promise<void>((resolve, reject) => web.listen(0, '127.0.0.1', resolve).once('error', reject))
  testContext.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
  const targetUrl = `http://127.0.0.1:${address.port}/mock-exam`
  const events: LiveExecutionEvent[] = []

  const result = await runAutomationPlan({
    name: '选择考试', targetUrl,
    steps: [
      { action: 'goto', path: '/mock-exam' },
      { action: 'click', locator: { by: 'text', value: '选择考试' } },
    ],
  }, undefined, { artifactRoot, onEvent: event => events.push(event) })

  assert.equal(result.status, 'passed')
  assert.ok(events.some(event => event.type === 'execution_started' && event.mode === 'plan'))
  const frames = events.filter((event): event is Extract<LiveExecutionEvent, { type: 'browser_frame' }> => event.type === 'browser_frame')
  assert.ok(frames.length >= 2, 'a fast plan must still publish a page frame after its initial blank frame')
  assert.notEqual(frames.at(-1)?.dataUrl, frames[0]?.dataUrl)
  assert.ok(events.some(event => event.type === 'activity'
    && event.activity.title === '点击“选择考试”'
    && event.activity.technicalAction === 'click text=选择考试'))
})
