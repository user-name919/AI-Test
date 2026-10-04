import { randomUUID } from 'node:crypto'
import type { ElementHandle, Frame, Page } from 'playwright'
import { pageSnapshotSchema, type PageSnapshot, type SemanticElement } from '@quality-ai/contracts'
import { ElementRegistry } from './element-registry'
import { observePageInBrowser } from './page-observer-browser.js'
import type { BrowserPageSession } from './browser-page-session'

export const interactiveElementSelector = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="listbox"]',
  '[role="grid"]',
  '[role="menu"]',
  '[role="tree"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="treeitem"]',
].join(',')

export const elementRefAttribute = 'data-quality-ai-element-ref'

interface ObserverOptions {
  maxElements?: number
  maxTextLength?: number
  maxTableRows?: number
}

interface RawObservation {
  loading: boolean
  discoveredElements: number
  elements: SemanticElement[]
  dialogs: PageSnapshot['dialogs']
  tables: PageSnapshot['tables']
  messages: PageSnapshot['messages']
}

export class PageObserver {
  readonly registry = new ElementRegistry()

  constructor(private readonly options: ObserverOptions = {}, private readonly pages?: BrowserPageSession) {}

  async observe(page: Page, frame?: Frame): Promise<PageSnapshot> {
    page = this.pages?.current ?? page
    this.pages?.assertAllowed()
    if(frame) this.registry.focusFrame(page,frame)
    this.registry.invalidate()
    const frames = await this.registry.observeFrames(page)
    const root = this.registry.activeRoot(page)
    const snapshotId = randomUUID()
    const maxElements = this.options.maxElements ?? 300
    const maxTextLength = this.options.maxTextLength ?? 160
    const maxTableRows = this.options.maxTableRows ?? 3
    const region=this.registry.takeObservationRegion()
    let raw:RawObservation
    try { raw = await root.evaluate<RawObservation, {
      selector: string
      snapshotId: string
      refAttribute: string
      maxElements: number
      maxTextLength: number
      maxTableRows: number
      region?:ElementHandle
    }>(observePageInBrowser as (options: {
      selector: string
      maxElements: number
      maxTextLength: number
      maxTableRows: number
    }) => RawObservation, {
      selector: interactiveElementSelector,
      snapshotId,
      refAttribute: elementRefAttribute,
      maxElements,
      maxTextLength,
      maxTableRows,
      region:region?.element,
    }) } finally { await region?.element.dispose() }

    this.registry.replace(snapshotId, root, elementRefAttribute, raw.elements)
    return pageSnapshotSchema.parse({
      snapshotId,
      observedAt: new Date().toISOString(),
      url: root.url(),
      title: await root.title(),
      pageContext: this.pages?.observe(snapshotId),
      frameContext: { pageUrl: page.url(), ...frames },
      loading: raw.loading,
      observationScope:region?{mode:'region',sourceElementRef:region.sourceElementRef,sourceSnapshotId:region.sourceSnapshotId}:undefined,
      elements: raw.elements,
      dialogs: raw.dialogs,
      tables: raw.tables,
      messages: raw.messages,
      stats: {
        discoveredElements: raw.discoveredElements,
        returnedElements: raw.elements.length,
        truncated: raw.discoveredElements > raw.elements.length,
      },
    })
  }
}
