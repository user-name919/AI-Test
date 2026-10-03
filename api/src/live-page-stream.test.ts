import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserContext, Page } from 'playwright'
import { startLivePageStream } from './automation/live-page-stream'

test('starts a throttled Chromium screencast, acknowledges frames and stops cleanly', async () => {
  const calls: Array<{ method: string; params?: unknown }> = []
  const handlers = new Map<string, (event: unknown) => void>()
  let detached = false
  const session = {
    on(event: string, handler: (event: unknown) => void) { handlers.set(event, handler) },
    async send(method: string, params?: unknown) {
      calls.push({ method, params })
      if (method === 'Page.captureScreenshot') return { data: 'aW5pdGlhbA==' }
      return {}
    },
    async detach() { detached = true },
  }
  const context = {
    async newCDPSession() { return session },
  } as unknown as BrowserContext
  let pageScreenshotCount = 0
  const page = {
    async screenshot() {
      pageScreenshotCount += 1
      return Buffer.from(`page-${pageScreenshotCount}`)
    },
  } as unknown as Page
  const frames: Array<{ dataUrl: string; capturedAt: string }> = []

  const stream = await startLivePageStream(context, page, frame => frames.push(frame))

  assert.ok(calls.some(call => call.method === 'Page.startScreencast'))
  assert.deepEqual(frames.map(frame => frame.dataUrl), ['data:image/jpeg;base64,cGFnZS0x'])

  handlers.get('Page.screencastFrame')?.({ data: 'ZnJhbWU=', sessionId: 7, metadata: {} })
  await new Promise(resolve => setImmediate(resolve))

  assert.ok(calls.some(call => call.method === 'Page.screencastFrameAck' && (call.params as { sessionId: number }).sessionId === 7))
  assert.equal(frames.length, 1, 'the immediate browser frame should be throttled after the initial frame')

  await new Promise(resolve => setTimeout(resolve, 210))
  handlers.get('Page.screencastFrame')?.({ data: 'd2hpdGUtY2RwLWZyYW1l', sessionId: 8, metadata: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(frames[1]?.dataUrl, 'data:image/jpeg;base64,cGFnZS0y', 'CDP should signal a fresh Playwright screenshot instead of forwarding a blank CDP frame')

  await stream.capture()
  assert.equal(frames.length, 3, 'an explicit action-boundary capture should bypass the passive-frame throttle')
  assert.equal(frames[2]?.dataUrl, 'data:image/jpeg;base64,cGFnZS0z')

  await stream.stop()
  assert.ok(calls.some(call => call.method === 'Page.stopScreencast'))
  assert.equal(detached, true)
})

test('cleans up the CDP session when the initial Playwright frame cannot be captured', async () => {
  const calls: string[] = []
  let detached = false
  const session = {
    on() {},
    async send(method: string) { calls.push(method); return {} },
    async detach() { detached = true },
  }
  const context = { async newCDPSession() { return session } } as unknown as BrowserContext
  const page = { async screenshot() { throw new Error('capture unavailable') } } as unknown as Page

  await assert.rejects(startLivePageStream(context, page, () => undefined), /capture unavailable/)

  assert.ok(calls.includes('Page.stopScreencast'))
  assert.equal(detached, true)
})
