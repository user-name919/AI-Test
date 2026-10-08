import type { Page } from 'playwright'
import { RuntimeDataBindingBlockedError } from './test-data-binding'

/** Attach before the trigger so fast popups cannot be missed. Never replay the click. */
export async function capturePopup(source: Page, trigger: () => Promise<unknown>, signal?: AbortSignal): Promise<Page> {
  signal?.throwIfAborted()
  const opened: Page[] = []
  let accept!: (page: Page) => void
  const ready = new Promise<Page>(resolve => { accept = resolve })
  const onPopup = (page: Page) => { opened.push(page); accept(page) }
  source.on('popup', onPopup)
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  let stopped = false
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RuntimeDataBindingBlockedError('新标签页未在15秒内就绪；未自动重复点击')), 15000)
    abort = () => reject(signal?.reason ?? new Error('打开标签页已取消'))
    signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([boundary, (async () => {
      await trigger()
      const page = await ready
      if (stopped) throw new Error('标签页捕获已停止')
      await page.waitForLoadState('domcontentloaded', { timeout:10000 })
      signal?.throwIfAborted()
      if (stopped) throw new Error('标签页捕获已停止')
      if (opened.length !== 1) throw new RuntimeDataBindingBlockedError('本次操作打开多个标签页，无法唯一绑定；未自动选择第一项')
      if (page.isClosed()) throw new RuntimeDataBindingBlockedError('新标签页已关闭，无法绑定')
      return page
    })()])
  } finally {
    stopped = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    source.off('popup', onPopup)
  }
}
