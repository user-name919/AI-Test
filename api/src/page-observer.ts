import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import { pageSnapshotSchema, type PageSnapshot, type SemanticElement } from '@quality-ai/contracts'
import { ElementRegistry } from './element-registry'
import { observePageInBrowser } from './page-observer-browser.js'

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

  constructor(private readonly options: ObserverOptions = {}) {}

  async observe(page: Page): Promise<PageSnapshot> {
    const snapshotId = randomUUID()
    const maxElements = this.options.maxElements ?? 300
    const maxTextLength = this.options.maxTextLength ?? 160
    const maxTableRows = this.options.maxTableRows ?? 3
    const raw = await page.evaluate<RawObservation, {
      selector: string
      snapshotId: string
      refAttribute: string
      maxElements: number
      maxTextLength: number
      maxTableRows: number
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
    })

    this.registry.replace(snapshotId, page, elementRefAttribute, raw.elements)
    return pageSnapshotSchema.parse({
      snapshotId,
      observedAt: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      loading: raw.loading,
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
