import { randomUUID } from 'node:crypto'
import type { Frame, Locator, Page } from 'playwright'

interface RegisteredElement {
  ref: string
}

export class ElementRegistry {
  private snapshotId?: string
  private readonly elements = new Map<string, Locator>()
  private selectedFrame?: Frame
  private readonly frameIds = new WeakMap<Frame, string>()
  private readonly frames = new Map<string, Frame>()

  activeRoot(page: Page): Frame {
    const frame = this.selectedFrame ?? page.mainFrame()
    if (frame.isDetached() || frame.page() !== page) throw new Error('已选择的框架失效，禁止回退主页面执行')
    return frame
  }

  async observeFrames(page: Page) {
    const active = this.activeRoot(page)
    const all = page.frames()
    const observed = []
    this.frames.clear()
    for (const frame of all.slice(0, 50)) {
      if (frame.isDetached()) continue
      let visible = true
      for (let ancestor: Frame | null = frame; ancestor && ancestor !== page.mainFrame(); ancestor = ancestor.parentFrame()) {
        const element = await ancestor.frameElement()
        try { if (!await element.isVisible()) { visible = false; break } }
        finally { await element.dispose() }
      }
      if (!visible) continue
      let ref = this.frameIds.get(frame)
      if (!ref) { ref = randomUUID(); this.frameIds.set(frame, ref) }
      this.frames.set(ref, frame)
      observed.push({ ref, url: frame.url(), name: frame.name(), main: frame === page.mainFrame(), active: frame === active })
    }
    if (!observed.some(frame => frame.active)) throw new Error('当前框架不可见或不在观察范围内，禁止回退主页面执行')
    return { frames: observed, truncated: all.length > 50 }
  }

  selectFrame(snapshotId: string, ref: string) {
    if (snapshotId !== this.snapshotId) throw new Error('框架切换引用了过期快照')
    const frame = this.frames.get(ref)
    if (!frame || frame.isDetached()) throw new Error('当前快照不存在可用框架引用')
    this.focusFrame(frame.page(), frame)
  }

  focusFrame(page: Page, frame: Frame) {
    if(frame.isDetached() || frame.page() !== page) throw new Error('目标框架不属于当前页面或已失效')
    this.selectedFrame = frame
    this.invalidate()
  }

  resetFrame() { this.selectedFrame = undefined; this.invalidate() }

  replace(snapshotId: string, page: Page | Frame, refAttribute: string, elements: RegisteredElement[]) {
    this.snapshotId = snapshotId
    this.elements.clear()
    for (const element of elements) {
      this.elements.set(element.ref, page.locator(`[${refAttribute}="${snapshotId}:${element.ref}"]`))
    }
  }

  resolve(snapshotId: string, elementRef: string) {
    if (snapshotId !== this.snapshotId) throw new Error(`页面快照已失效：${snapshotId}`)
    const locator = this.elements.get(elementRef)
    if (!locator) throw new Error(`元素引用不存在：${elementRef}`)
    return locator
  }

  invalidate() {
    this.snapshotId = undefined
    this.elements.clear()
  }

  get activeSnapshotId() {
    return this.snapshotId
  }
}
