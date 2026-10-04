import type { BrowserContext, Page } from 'playwright'

export interface LiveBrowserFrame {
  dataUrl: string
  capturedAt: string
}

export async function startLivePageStream(
  context: BrowserContext,
  page: Page,
  onFrame: (frame: LiveBrowserFrame) => void,
) {
  const session = await context.newCDPSession(page)
  const minimumFrameIntervalMs = 200
  let lastFrameAt = 0
  let stopped = false
  let captureInFlight: Promise<void> | undefined

  const emitFrame = (data: string) => {
    const capturedAt = Date.now()
    if (stopped) return
    lastFrameAt = capturedAt
    onFrame({ dataUrl: `data:image/jpeg;base64,${data}`, capturedAt: new Date(capturedAt).toISOString() })
  }

  session.on('Page.screencastFrame', event => {
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
    void capture(false).catch(() => undefined)
  })

  async function capture(force = true) {
    if (stopped || (!force && Date.now() - lastFrameAt < minimumFrameIntervalMs)) return
    if (captureInFlight) {
      await captureInFlight
      if (!force || stopped) return
    }
    captureInFlight = (async () => {
      const frame = await page.screenshot({
        type: 'jpeg', quality: 55, fullPage: false, caret: 'hide', scale: 'css', timeout:3000,
      })
      emitFrame(frame.toString('base64'))
    })()
    try {
      await captureInFlight
    } finally {
      captureInFlight = undefined
    }
  }

  async function stop() {
    if (stopped) return
    stopped = true
    await session.send('Page.stopScreencast').catch(() => undefined)
    await session.detach().catch(() => undefined)
  }

  try {
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 55,
      maxWidth: 1_280,
      maxHeight: 900,
      everyNthFrame: 1,
    })
    await capture()
  } catch (error) {
    await stop()
    throw error
  }

  return {
    capture,
    stop,
  }
}
