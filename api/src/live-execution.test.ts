import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentDecision, AutomationPlan, PageSnapshot } from '@quality-ai/contracts'
import { consumeNdjsonChunk, createLiveExecutionState, describeAgentDecision, describeAutomationStep, encodeNdjsonEvent, reduceLiveExecutionState } from '@quality-ai/contracts/live-execution'
import { openNdjsonResponse } from './ndjson-response'
import type { ServerResponse } from 'node:http'

const snapshot: PageSnapshot = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  observedAt: '2026-09-01T00:00:00.000Z',
  url: 'https://example.com/mock-exam',
  title: '批量操作',
  loading: false,
  elements: [{
    ref: 'e10', tag: 'button', role: 'button', name: '选择考试',
    visible: true, enabled: true,
  }],
  dialogs: [], tables: [], messages: [],
  stats: { discoveredElements: 1, returnedElements: 1, truncated: false },
}

test('describes an Agent element action with readable target and raw action', () => {
  const decision: AgentDecision = {
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'click', elementRef: 'e10' },
    reason: '展开考试选择列表',
  }

  const activity = describeAgentDecision(decision, snapshot, 3)

  assert.equal(activity.title, '点击“选择考试”')
  assert.equal(activity.purpose, '展开考试选择列表')
  assert.equal(activity.technicalAction, 'click e10')
  assert.equal(activity.iteration, 3)
  assert.equal(activity.snapshotId, snapshot.snapshotId)
})

test('keeps waitFor raw detail while explaining the wait', () => {
  const decision: AgentDecision = {
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'waitFor', durationMs: 1_000 },
    reason: '等待异步表单和考试数据完成渲染',
  }

  const activity = describeAgentDecision(decision, snapshot, 4)

  assert.equal(activity.title, '等待页面加载 1 秒')
  assert.equal(activity.purpose, '等待异步表单和考试数据完成渲染')
  assert.equal(activity.technicalAction, 'waitFor 1000ms')
})

test('describes a resolved DOM data proposal with its visible source and retained technical detail', () => {
  const dataSnapshot: PageSnapshot = {
    ...snapshot,
    elements: [{ ref: 'e10', tag: 'div', role: 'option', name: '模考数学一', visible: true, enabled: true }],
  }
  const decision: AgentDecision = {
    type: 'resolve_test_data', snapshotId: dataSnapshot.snapshotId, bindingId: 'exam-keyword',
    sourceElementRef: 'e10', value: '数学', reason: '从真实 option 选择部分关键词',
  }

  const activity = describeAgentDecision(decision, dataSnapshot, 5)

  assert.equal(activity.title, '从“模考数学一”解析测试数据“数学”')
  assert.equal(activity.technicalAction, 'resolve_test_data exam-keyword source=e10 value=“数学”')
  assert.equal(activity.status, 'running')
})

test('describes a fixed plan step without hiding its Playwright locator', () => {
  const step: AutomationPlan['steps'][number] = {
    action: 'click', locator: { by: 'label', value: '选择考试' },
  }

  const activity = describeAutomationStep(step, 1)

  assert.equal(activity.title, '点击“选择考试”')
  assert.equal(activity.purpose, '执行固定计划的第 2 步')
  assert.equal(activity.technicalAction, 'click label=选择考试')
})

test('recovers complete NDJSON events while preserving an incomplete tail', () => {
  const first = { type: 'activity', value: '点击“选择考试”' }
  const second = { type: 'execution_completed', value: '完成' }
  const encoded = encodeNdjsonEvent(first) + encodeNdjsonEvent(second)
  const splitAt = encoded.indexOf('\n') + 8

  const partOne = consumeNdjsonChunk('', encoded.slice(0, splitAt))
  assert.deepEqual(partOne.values, [first])
  assert.notEqual(partOne.remainder, '')

  const partTwo = consumeNdjsonChunk(partOne.remainder, encoded.slice(splitAt))
  assert.deepEqual(partTwo.values, [second])
  assert.equal(partTwo.remainder, '')
})

test('writes live execution events as no-cache NDJSON records', () => {
  let status = 0
  let headers: Record<string, string> = {}
  const chunks: string[] = []
  let ended = false
  const response = {
    writeHead(nextStatus: number, nextHeaders: Record<string, string>) { status = nextStatus; headers = nextHeaders },
    write(chunk: string) { chunks.push(chunk); return true },
    end() { ended = true },
  } as unknown as ServerResponse

  const stream = openNdjsonResponse(response)
  stream.send({ type: 'activity', value: '正在点击' })
  stream.close()

  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'application/x-ndjson; charset=utf-8')
  assert.equal(headers['cache-control'], 'no-store, no-transform')
  assert.deepEqual(chunks, ['{"type":"activity","value":"正在点击"}\n'])
  assert.equal(ended, true)
})

test('reduces a live event stream without carrying the previous execution frame', () => {
  let state = createLiveExecutionState()
  state = reduceLiveExecutionState(state, {
    type: 'execution_started', executionId: 'run-1', mode: 'agent', name: '选择考试',
    targetUrl: 'https://example.com', cases: [{ key: '0-TC-2', title: '按关键词筛选考试' }],
  })
  state = reduceLiveExecutionState(state, {
    type: 'browser_frame', executionId: 'run-1', dataUrl: 'data:image/jpeg;base64,one', capturedAt: '2026-09-01T00:00:01.000Z', pageUrl: 'https://example.com/detail',
  })
  state = reduceLiveExecutionState(state, {
    type: 'activity', executionId: 'run-1',
    activity: {
      id: 'step-1', phase: 'executing', title: '点击“选择考试”', purpose: '展开列表',
      technicalAction: 'click e10', status: 'running',
    },
  })

  assert.equal(state.status, 'running')
  assert.equal(state.cases[0]?.title, '按关键词筛选考试')
  assert.equal(state.frameDataUrl, 'data:image/jpeg;base64,one')
  assert.equal(state.framePageUrl, 'https://example.com/detail')
  assert.equal(state.activity?.technicalAction, 'click e10')

  state = reduceLiveExecutionState(state, {
    type: 'execution_started', executionId: 'run-2', mode: 'plan', name: '新执行', targetUrl: 'https://example.com/next',
  })
  assert.equal(state.executionId, 'run-2')
  assert.equal(state.frameDataUrl, '')
  assert.equal(state.activity, null)
})

test('retains an infrastructure failure reported by a completed execution', () => {
  const state = reduceLiveExecutionState(createLiveExecutionState(), {
    type: 'execution_completed',
    execution: {
      id: 'run-infrastructure-failure', name: '连续执行', targetUrl: 'https://example.test', status: 'infrastructure_failed',
      startedAt: '2026-09-03T00:00:00.000Z', finishedAt: '2026-09-03T00:00:01.000Z', durationMs: 1_000,
      steps: [], screenshots: [], caseKeys: [], error: '浏览器会话已中断',
    },
  })

  assert.equal(state.status, 'infrastructure_failed')
  assert.equal(state.error, '浏览器会话已中断')
})
