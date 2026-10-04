import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'

/** Page identity belongs to the shared browser session, not a case or tab index. */
export class BrowserPageSession {
  private readonly ids = new WeakMap<Page, string>()
  private readonly observed = new Map<string, Page>()
  private snapshotId?: string

  constructor(
    public current: Page,
    private readonly origin: string,
    private readonly onSwitch: (page: Page) => Promise<void>,
  ) {}

  assertAllowed(page = this.current) {
    if (page.isClosed()) throw new Error('当前标签页已关闭，禁止自动改用其他页面')
    if (new URL(page.url()).origin !== this.origin) throw new Error('标签页不属于测试环境，禁止观察或操作')
  }

  observe(snapshotId: string) {
    this.assertAllowed()
    this.snapshotId = snapshotId
    this.observed.clear()
    const all = this.current.context().pages().filter(page => !page.isClosed())
    // Always retain the active page even if many unrelated tabs exist.
    const pages = [this.current, ...all.filter(page => page !== this.current)].slice(0, 50).map(page => {
      let ref = this.ids.get(page)
      if (!ref) { ref = randomUUID(); this.ids.set(page, ref) }
      this.observed.set(ref, page)
      return { ref, url: page.url(), active: page === this.current, allowed: new URL(page.url()).origin === this.origin }
    })
    return { pages, truncated: all.length > pages.length }
  }

  async select(snapshotId: string, ref: string) {
    if (snapshotId !== this.snapshotId) throw new Error('标签页切换引用了过期快照')
    const page = this.observed.get(ref)
    if (!page) throw new Error('目标标签页未出现在当前观察中')
    this.assertAllowed(page)
    await page.bringToFront()
    this.current = page
    this.snapshotId = undefined
    this.observed.clear()
    await this.onSwitch(page)
  }
}
