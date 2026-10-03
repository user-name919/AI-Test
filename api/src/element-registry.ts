import type { Locator, Page } from 'playwright'

interface RegisteredElement {
  ref: string
}

export class ElementRegistry {
  private snapshotId?: string
  private readonly elements = new Map<string, Locator>()

  replace(snapshotId: string, page: Page, refAttribute: string, elements: RegisteredElement[]) {
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
